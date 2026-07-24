import { describe, expect, it } from "vitest";
import { renderMarkdown, sanitizeHtml } from "./markdown";

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
