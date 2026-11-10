import { describe, expect, it, vi } from "vitest";
import { commitPushPr, CommitPushPrError, type FlowDeps } from "./commitPushPr";

const ctx = { branch: "agent/claude-1", base: "main", commits: ["Add the thing"], files: ["a.ts"], stat: "1 file changed", template: null };

function deps(over: Partial<FlowDeps> = {}): FlowDeps & { calls: string[] } {
  const calls: string[] = [];
  const d: FlowDeps = {
    status: vi.fn(async () => ({ entries: [{ status: " M", path: "a.ts" }, { status: "??", path: "b.ts" }], branch: "agent/claude-1" })),
    stage: vi.fn(async (_r, paths) => { calls.push(`stage ${paths.join(",")}`); }),
    commit: vi.fn(async (_r, m) => { calls.push(`commit ${m}`); return "abc123"; }),
    push: vi.fn(async (_r, up) => { calls.push(`push ${up}`); return "ok"; }),
    prContext: vi.fn(async () => ctx),
    createPr: vi.fn(async (_r, base, head, title) => { calls.push(`pr ${base}<-${head} ${title}`); return "https://github.com/x/y/pull/9"; }),
    ...over,
  };
  return Object.assign(d, { calls });
}

describe("commitPushPr", () => {
  it("stages every changed file, commits, pushes with an upstream, and opens a PR, in that order", async () => {
    const d = deps();
    const r = await commitPushPr(d, { repo: "/r", message: "Add the thing" });
    expect(d.calls[0]).toBe("stage a.ts,b.ts");
    expect(d.calls[1]).toBe("commit Add the thing");
    expect(d.calls[2]).toBe("push true");
    expect(d.calls[3]).toMatch(/^pr main<-agent\/claude-1 /);
    expect(r).toEqual({ committed: true, pushed: true, prUrl: "https://github.com/x/y/pull/9", prExisted: false, skipped: [] });
  });

  it("refuses to commit conflicted files, which would be marked resolved with their markers", async () => {
    const d = deps({ status: vi.fn(async () => ({ entries: [{ status: "UU", path: "a.ts" }, { status: " M", path: "b.ts" }], branch: "agent/x" })) });
    const error = await commitPushPr(d, { repo: "/r", message: "m" }).catch((e) => e);
    expect(error).toMatchObject({ step: "stage" });
    expect(String(error.message)).toContain("a.ts");
    expect(d.stage).not.toHaveBeenCalled();
    expect(d.push).not.toHaveBeenCalled();
  });

  it("leaves out files that look like secrets and says so", async () => {
    const d = deps({
      status: vi.fn(async () => ({
        entries: [{ status: "??", path: ".env" }, { status: "??", path: ".env.example" }, { status: " M", path: "src/a.ts" }, { status: "??", path: "keys/server.pem" }],
        branch: "agent/x",
      })),
    });
    const r = await commitPushPr(d, { repo: "/r", message: "m" });
    expect(d.calls[0]).toBe("stage .env.example,src/a.ts");
    expect(r.skipped).toEqual([".env", "keys/server.pem"]);
  });

  it("will not commit onto the default branch, or from a detached HEAD", async () => {
    const onMain = deps({ status: vi.fn(async () => ({ entries: [{ status: " M", path: "a.ts" }], branch: "main" })) });
    await expect(commitPushPr(onMain, { repo: "/r", message: "m" })).rejects.toMatchObject({ step: "stage" });
    expect(onMain.push).not.toHaveBeenCalled();
    const allowed = await commitPushPr(onMain, { repo: "/r", message: "m", allowDefaultBranch: true });
    expect(allowed.committed).toBe(true);
    const detached = deps({ status: vi.fn(async () => ({ entries: [{ status: " M", path: "a.ts" }], branch: null })) });
    await expect(commitPushPr(detached, { repo: "/r", message: "m" })).rejects.toMatchObject({ step: "stage" });
  });

  it("reads the existing PR's URL out of gh's message", async () => {
    const d = deps({
      createPr: vi.fn(async () => {
        throw new Error("a pull request for branch \"x\" into branch \"main\" already exists:\nhttps://github.com/o/r/pull/12");
      }),
    });
    const r = await commitPushPr(d, { repo: "/r", message: "m" });
    expect(r).toMatchObject({ prExisted: true, prUrl: "https://github.com/o/r/pull/12" });
  });

  it("skips the commit when there is nothing to commit", async () => {
    const d = deps({ status: vi.fn(async () => ({ entries: [], branch: "b" })) });
    const r = await commitPushPr(d, { repo: "/r" });
    expect(r.committed).toBe(false);
    expect(d.commit).not.toHaveBeenCalled();
    expect(d.push).toHaveBeenCalled();
  });

  it("asks for a message rather than committing with none", async () => {
    const d = deps();
    await expect(commitPushPr(d, { repo: "/r" })).rejects.toMatchObject({ step: "commit" });
    expect(d.push).not.toHaveBeenCalled();
  });

  it("names the step that failed and runs nothing after it", async () => {
    const d = deps({ push: vi.fn(async () => { throw new Error("rejected: no permission"); }) });
    const error = await commitPushPr(d, { repo: "/r", message: "m" }).catch((e) => e);
    expect(error).toBeInstanceOf(CommitPushPrError);
    expect(error).toMatchObject({ step: "push", message: "rejected: no permission" });
    expect(d.createPr).not.toHaveBeenCalled();
  });

  it("treats a PR that already exists as success once the push went through", async () => {
    const d = deps({ createPr: vi.fn(async () => { throw new Error("a pull request for branch already exists"); }) });
    const r = await commitPushPr(d, { repo: "/r", message: "m" });
    expect(r).toMatchObject({ pushed: true, prUrl: null, prExisted: true });
  });

  it("can push and open a PR without committing, with the caller's own title and body", async () => {
    const d = deps();
    const r = await commitPushPr(d, { repo: "/r", commit: false, title: "My title", body: "My body", draft: true, base: "develop" });
    expect(d.status).not.toHaveBeenCalled();
    expect(d.createPr).toHaveBeenCalledWith("/r", "develop", "agent/claude-1", "My title", "My body", true);
    expect(r.committed).toBe(false);
  });

  it("stops after the push when no PR is wanted", async () => {
    const d = deps();
    const r = await commitPushPr(d, { repo: "/r", message: "m", openPr: false });
    expect(d.createPr).not.toHaveBeenCalled();
    expect(r.prUrl).toBeNull();
  });

  it("uses session trailers when given, and falls back to the plain message if they fail", async () => {
    const withTrailers = vi.fn(async (_r: string, m: string) => `${m}\n\nSession: x`);
    const d = deps({ withTrailers });
    await commitPushPr(d, { repo: "/r", message: "m" });
    expect(d.calls).toContain("commit m\n\nSession: x");
    const d2 = deps({ withTrailers: vi.fn(async () => { throw new Error("nope"); }) });
    await commitPushPr(d2, { repo: "/r", message: "m" });
    expect(d2.calls).toContain("commit m");
  });
});
