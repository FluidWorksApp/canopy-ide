import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Markdown, toggleTaskAt } from "./Markdown";

describe("toggleTaskAt", () => {
  const doc = "- [ ] first\n- [x] second\n- [ ] third";

  it("flips the nth box and leaves the rest alone", () => {
    expect(toggleTaskAt(doc, 0)).toBe("- [x] first\n- [x] second\n- [ ] third");
    expect(toggleTaskAt(doc, 1)).toBe("- [ ] first\n- [ ] second\n- [ ] third");
  });

  it("counts position, not label", () => {
    // Two tasks in a document routinely say the same thing under different
    // headings; matching text would tick whichever came first.
    const dupes = "## a\n- [ ] test it\n\n## b\n- [ ] test it";
    expect(toggleTaskAt(dupes, 1)).toBe("## a\n- [ ] test it\n\n## b\n- [x] test it");
  });

  it("handles the other list markers and indentation", () => {
    expect(toggleTaskAt("  * [ ] nested", 0)).toBe("  * [x] nested");
    expect(toggleTaskAt("1. [ ] ordered", 0)).toBe("1. [x] ordered");
  });

  it("is a no-op for an index that isn't there", () => {
    expect(toggleTaskAt(doc, 9)).toBe(doc);
  });
});

describe("Markdown rendering", () => {
  it("renders the same content for owned and external text", () => {
    // The split is about what content can *do*, never about how it looks — an
    // issue body must not render as a second-class citizen.
    const md = "# Title\n\n- [ ] a task\n\n> [!WARNING] careful\n\n`code`";
    const { container: owned } = render(<Markdown text={md} origin="owned" />);
    const { container: ext } = render(<Markdown text={md} origin="external" />);
    for (const root of [owned, ext]) {
      expect(root.querySelector("h1")).toBeTruthy();
      expect(root.querySelector('input[type="checkbox"]')).toBeTruthy();
      expect(root.querySelector(".md-callout-warning")).toBeTruthy();
      expect(root.querySelector("code")).toBeTruthy();
    }
  });

  it("turns a GitHub/Obsidian callout into a titled block", async () => {
    render(<Markdown text={"> [!NOTE] Read this\n> and the body"} />);
    await waitFor(() =>
      expect(document.querySelector(".md-callout-note")).toBeTruthy(),
    );
    expect(screen.getByText("Read this")).toBeInTheDocument();
    // The prose after the marker survives — it is the same paragraph.
    expect(screen.getByText(/and the body/)).toBeInTheDocument();
  });

  it("gives headings stable, unique anchors and reports an outline", async () => {
    const onOutline = vi.fn();
    render(
      <Markdown text={"## Notes\n\ntext\n\n## Notes\n\nmore"} onOutline={onOutline} />,
    );
    await waitFor(() => expect(onOutline).toHaveBeenCalled());
    const headings = onOutline.mock.calls.at(-1)?.[0];
    // Two identical headings is normal, and both have to be addressable.
    expect(headings.map((h: { id: string }) => h.id)).toEqual(["notes", "notes-1"]);
    expect(headings[0]).toMatchObject({ level: 2, text: "Notes" });
  });
});

describe("the owned/external boundary", () => {
  it("follows a wikilink on owned text", async () => {
    const onWikilink = vi.fn();
    render(<Markdown text="see [[0007-tier]]" origin="owned" onWikilink={onWikilink} />);
    await userEvent.click(screen.getByText("0007-tier"));
    expect(onWikilink).toHaveBeenCalledWith("0007-tier");
  });

  it("does not make wikilinks out of external text at all", () => {
    const onWikilink = vi.fn();
    const { container } = render(
      <Markdown text="see [[0007-tier]]" origin="external" onWikilink={onWikilink} />,
    );
    expect(container.querySelector("a.wikilink")).toBeNull();
    expect(container.textContent).toContain("[[0007-tier]]");
  });

  it("ignores a wikilink an external body hand-wrote as raw HTML", async () => {
    // `data-*` survives sanitising, so a hostile issue body can forge this
    // anchor. This is where that stops being interesting: the handler that
    // gives it meaning is never attached on an external surface.
    const onWikilink = vi.fn();
    render(
      <Markdown
        text={'<a class="wikilink" data-wikilink="0001-anything">totally safe</a>'}
        origin="external"
        onWikilink={onWikilink}
      />,
    );
    await userEvent.click(screen.getByText("totally safe"));
    expect(onWikilink).not.toHaveBeenCalled();
  });

  it("ticks a task on owned text and hands back the edited source", async () => {
    const onToggleTask = vi.fn();
    const { container } = render(
      <Markdown text="- [ ] ship it" origin="owned" onToggleTask={onToggleTask} />,
    );
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await waitFor(() => expect(box.disabled).toBe(false));
    await userEvent.click(box);
    expect(onToggleTask).toHaveBeenCalledWith("- [x] ship it");
  });

  it("leaves an external body's checkboxes readable but inert", async () => {
    const onToggleTask = vi.fn();
    const { container } = render(
      <Markdown text="- [x] done upstream" origin="external" onToggleTask={onToggleTask} />,
    );
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await waitFor(() => expect(box.disabled).toBe(true));
    expect(box.checked).toBe(true);
    expect(onToggleTask).not.toHaveBeenCalled();
  });

  it("leaves boxes inert on owned text with nowhere to save", async () => {
    const { container } = render(<Markdown text="- [ ] a task" origin="owned" />);
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await waitFor(() => expect(box.disabled).toBe(true));
  });
});

describe("the image lightbox", () => {
  const md = "![the broken dropdown](https://example.test/a.png)";

  it("opens full size from any surface, including an external one", async () => {
    render(<Markdown text={md} origin="external" />);
    await userEvent.click(screen.getByAltText("the broken dropdown"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Escape and on a click outside the image", async () => {
    render(<Markdown text={md} />);
    await userEvent.click(screen.getByAltText("the broken dropdown"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await userEvent.click(screen.getByAltText("the broken dropdown"));
    await userEvent.click(screen.getByRole("dialog"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("stays open when the image itself is clicked", async () => {
    render(<Markdown text={md} />);
    await userEvent.click(screen.getByAltText("the broken dropdown"));
    // Two images now: the one in the document and the one in the lightbox.
    const inDialog = screen.getByRole("dialog").querySelector("img")!;
    await userEvent.click(inDialog);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
