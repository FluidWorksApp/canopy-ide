import { describe, expect, it } from "vitest";
import { headingSlug, parseCallout, renderMarkdown, sanitizeHtml } from "./markdown";

// This module is the app's single sanitized markdown/HTML gate — issue bodies
// from GitHub/Linear are attacker-controlled, and a gap here was arbitrary
// command execution in the webview (see the module header). These tests pin the
// XSS-stripping behavior so a future renderer swap can't quietly reopen it.

describe("renderMarkdown", () => {
  it("renders basic markdown to HTML", () => {
    const html = renderMarkdown("# Title\n\nsome **bold** text");
    expect(html).toContain("<h1");
    expect(html).toContain("Title");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("strips a script-bearing onerror attribute from injected HTML", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });

  it("drops javascript: URLs on links", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("keeps https links (the allow-listed scheme)", () => {
    const html = renderMarkdown("[docs](https://example.com)");
    expect(html).toContain("https://example.com");
  });
});

describe("sanitizeHtml", () => {
  it("removes <script> tags outright", () => {
    const html = sanitizeHtml("<p>ok</p><script>steal()</script>");
    expect(html).toContain("<p>ok</p>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("steal()");
  });

  it("strips inline event handlers while keeping the element", () => {
    const html = sanitizeHtml('<div onclick="evil()">hi</div>');
    expect(html).toContain("hi");
    expect(html).not.toContain("onclick");
  });
});

// ---------- wikilinks ----------
//
// The feature exists for notes and research; the tests that matter are the ones
// pinning where it must NOT reach. Rendering is shared by every surface, and a
// ticket body is written by whoever can file an issue on a repo you opened.

describe("wikilinks", () => {
  it("are off unless a surface asks for them", () => {
    // The default is what a PR body and an issue body get.
    const html = renderMarkdown("see [[0007-tier-donations]]");
    expect(html).not.toContain("wikilink");
    expect(html).toContain("[[0007-tier-donations]]");
  });

  it("become inert anchors carrying the target when enabled", () => {
    const html = renderMarkdown("see [[0007-tier-donations]]", { wikilinks: true });
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('data-wikilink="0007-tier-donations"');
    // No href: this points nowhere a browser could go, and only the owning
    // surface's click handler gives it meaning.
    expect(html).not.toContain("href");
  });

  it("take a display label after a pipe", () => {
    const html = renderMarkdown("[[0007-tier|the tiering idea]]", { wikilinks: true });
    expect(html).toContain('data-wikilink="0007-tier"');
    expect(html).toContain("the tiering idea");
  });

  it("do not leak into a later render for another surface", () => {
    // marked keeps extensions as global state, so this is the regression that
    // registering per-call would cause: an issue body rendered right after a
    // note would silently gain internal links.
    renderMarkdown("[[a]]", { wikilinks: true });
    expect(renderMarkdown("[[a]]")).not.toContain("wikilink");
  });

  it("leave code alone", () => {
    // Someone quoting the syntax is showing you text, not linking.
    const inline = renderMarkdown("use `[[target]]` to link", { wikilinks: true });
    expect(inline).not.toContain("wikilink");
    const fenced = renderMarkdown("```\n[[target]]\n```", { wikilinks: true });
    expect(fenced).not.toContain("wikilink");
  });

  it("cannot smuggle markup through the target or the label", () => {
    const html = renderMarkdown('[[a"><script>alert(1)</script>|x]]', {
      wikilinks: true,
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });

  it("do not run away on an unclosed opener", () => {
    const html = renderMarkdown("[[ nope\n\nnext paragraph", { wikilinks: true });
    expect(html).not.toContain("wikilink");
    expect(html).toContain("next paragraph");
  });
});

describe("headingSlug", () => {
  it("makes an anchor out of a heading", () => {
    expect(headingSlug("What it does")).toBe("what-it-does");
    expect(headingSlug("Risk: the *hard* part!")).toBe("risk-the-hard-part");
  });

  it("never returns an empty id", () => {
    // A heading of pure punctuation still has to be addressable.
    expect(headingSlug("!!!")).toBe("section");
    expect(headingSlug("   ")).toBe("section");
  });

  it("keeps non-latin headings addressable", () => {
    expect(headingSlug("設計メモ")).toBe("設計メモ");
  });
});

describe("callouts", () => {
  it("reads the kinds GitHub and Obsidian both write", () => {
    expect(parseCallout("[!NOTE]")?.kind).toBe("note");
    expect(parseCallout("[!WARNING]")?.kind).toBe("warning");
    expect(parseCallout("[!caution]")?.kind).toBe("warning");
    expect(parseCallout("[!TIP] Try this")?.title).toBe("Try this");
  });

  it("titles an untitled callout after its kind", () => {
    expect(parseCallout("[!IMPORTANT]")?.title).toBe("Important");
  });

  it("reads Obsidian's fold hints", () => {
    expect(parseCallout("[!NOTE]-")).toMatchObject({ folded: true, foldable: true });
    expect(parseCallout("[!NOTE]+")).toMatchObject({ folded: false, foldable: true });
    expect(parseCallout("[!NOTE]")).toMatchObject({ folded: false, foldable: false });
  });

  it("leaves an ordinary blockquote alone", () => {
    // Inventing a callout out of an unknown marker would style something nobody
    // asked for, in a body we did not write.
    expect(parseCallout("just a quote")).toBeNull();
    expect(parseCallout("[!NOPE] something")).toBeNull();
  });
});

describe("task lists", () => {
  it("keeps the attributes that make a checkbox a checkbox", () => {
    // Regression: the html profile drops `type`, and an <input> with no type
    // is a text field — so every checklist in every PR body rendered as a row
    // of disabled text boxes.
    const html = renderMarkdown("- [ ] todo\n- [x] done");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("disabled");
  });

  it("still refuses the attributes on an input that actually carry script", () => {
    const html = renderMarkdown(
      '<input type="checkbox" onfocus="alert(1)" formaction="javascript:alert(1)">',
    );
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("onfocus");
    expect(html).not.toContain("formaction");
  });
});
