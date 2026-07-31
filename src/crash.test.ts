import { describe, expect, it } from "vitest";
import { issueComposeUrl, type CrashIssueDraft } from "./crash";

const draft = (over: Partial<CrashIssueDraft> = {}): CrashIssueDraft => ({
  repo: "FluidWorksApp/canopy-ide",
  title: "[crash] Can't find variable: agentMenu",
  body: "### Crash\n\n```\nCan't find variable: agentMenu\n```\n",
  fingerprint: "canopycrashsigdeadbeefdeadbeef",
  ...over,
});

describe("issueComposeUrl", () => {
  it("targets the draft's repo, not whatever repo is open", () => {
    const url = new URL(issueComposeUrl(draft()));
    expect(url.origin + url.pathname).toBe(
      "https://github.com/FluidWorksApp/canopy-ide/issues/new",
    );
  });

  it("round-trips the title and body through the query string", () => {
    const d = draft();
    const params = new URL(issueComposeUrl(d)).searchParams;
    // The point of the check: markdown, backticks and newlines have to survive
    // encoding intact, or the prefilled form arrives mangled.
    expect(params.get("title")).toBe(d.title);
    expect(params.get("body")).toBe(d.body);
  });

  it("carries the fingerprint through, so a composed issue still dedups", () => {
    const d = draft({ body: "text\n<!-- fingerprint: canopycrashsigabc123 -->\n" });
    expect(new URL(issueComposeUrl(d)).searchParams.get("body")).toContain(
      "canopycrashsigabc123",
    );
  });

  it("truncates a body too long for a URL and says that it did", () => {
    const body = `${"stack line\n".repeat(2000)}tail`;
    const got = new URL(issueComposeUrl(draft({ body }))).searchParams.get("body") ?? "";
    expect(got.length).toBeLessThan(body.length);
    expect(got).toContain("truncated to fit a URL");
    expect(got).not.toContain("tail");
  });

  it("leaves a body that already fits completely alone", () => {
    const d = draft();
    expect(new URL(issueComposeUrl(d)).searchParams.get("body")).toBe(d.body);
  });

  it("budgets the encoded length, not the character count", () => {
    // `»` encodes to `%C2%BB` — a character-counted cap overshoots by 6x, which
    // is exactly the bug this asserts against.
    const url = issueComposeUrl(draft({ body: "»\n".repeat(20_000) }));
    expect(url.length).toBeLessThan(8_000);
    expect(decodeURIComponent(new URL(url).searchParams.get("body") ?? "")).toContain(
      "truncated to fit a URL",
    );
  });

  it("stays under the ceiling for a long title too", () => {
    const url = issueComposeUrl(
      draft({ title: "[crash] ".concat("»".repeat(400)), body: "x".repeat(20_000) }),
    );
    expect(url.length).toBeLessThan(8_000);
  });

  it("never emits a URL it can't build, even mid-emoji", () => {
    // A truncation point that splits a surrogate pair would throw inside
    // encodeURIComponent; the cut has to back off to a whole code point.
    const url = issueComposeUrl(draft({ body: "🌲".repeat(20_000) }));
    expect(() => new URL(url)).not.toThrow();
    expect(url.length).toBeLessThan(8_000);
  });
});
