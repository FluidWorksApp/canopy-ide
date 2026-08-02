// @vitest-environment jsdom
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TabSwitcher } from "./TabSwitcher";
import type { SubTab, TermSubTab } from "./ProjectView/helpers";

// The switcher's own module graph, not ProjectView's: it needs one label
// helper from there, and importing the real index would drag the whole view
// (and its IPC) into a test about thumbnails.
vi.mock("./ProjectView", () => ({
  tabDisplayLabel: (t: SubTab) => t.id,
}));

const term = (id: string): TermSubTab => ({
  id,
  type: "terminal",
  cwd: "/repo",
  title: id,
  ptyId: 1,
});

const note = (id: string): SubTab => ({ id, type: "note", noteId: id, title: id });

/** A pane area with one mounted (hidden) host per doc tab — what ProjectView
 *  renders, and what the thumbnails are clones of. */
function paneWith(ids: string[], html: string) {
  const pane = document.createElement("div");
  for (const id of ids) {
    const hostEl = document.createElement("div");
    hostEl.setAttribute("data-tab-id", id);
    hostEl.style.display = "none";
    hostEl.innerHTML = html;
    pane.appendChild(hostEl);
  }
  document.body.appendChild(pane);
  const ref = createRef<HTMLDivElement>();
  (ref as { current: HTMLDivElement | null }).current = pane;
  return ref;
}

describe("TabSwitcher", () => {
  it("shows every tab, with the one a release would land on marked", () => {
    render(
      <TabSwitcher
        tabs={[term("one"), term("two"), term("three")]}
        selectedId="two"
        paneRef={paneWith([], "")}
        termText={() => ""}
        onPick={() => {}}
      />,
    );
    const cards = screen.getAllByRole("option");
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("puts the terminal's live tail on its card", () => {
    render(
      <TabSwitcher
        tabs={[term("one")]}
        selectedId="one"
        paneRef={paneWith([], "")}
        termText={(id) => (id === "one" ? "building…\n$ npm test\n\n" : null)}
        onPick={() => {}}
      />,
    );
    const shot = document.querySelector(".tsw-term")!;
    // The blank tail under the prompt is trimmed; the live end is not.
    expect(shot.textContent).toBe("building…\n$ npm test");
  });

  it("clones a doc pane rather than naming it", () => {
    render(
      <TabSwitcher
        tabs={[note("n1")]}
        selectedId="n1"
        paneRef={paneWith(["n1"], "<p>the note body</p>")}
        termText={() => null}
        onPick={() => {}}
      />,
    );
    const shot = document.querySelector(".tsw-scale")!;
    expect(shot.textContent).toContain("the note body");
    // The picture is a picture: nothing in it is reachable or clickable.
    expect(shot.firstElementChild?.getAttribute("inert")).toBe("");
  });

  it("numbers the cards only for the layer whose digits are the shortcut", () => {
    const { rerender } = render(
      <TabSwitcher
        tabs={[term("one"), term("two")]}
        selectedId="one"
        paneRef={paneWith([], "")}
        termText={() => ""}
        onPick={() => {}}
      />,
    );
    expect(document.querySelectorAll(".tsw-digit")).toHaveLength(0);
    rerender(
      <TabSwitcher
        tabs={[term("one"), term("two")]}
        selectedId="one"
        digits
        paneRef={paneWith([], "")}
        termText={() => ""}
        onPick={() => {}}
      />,
    );
    expect(
      [...document.querySelectorAll(".tsw-digit")].map((d) => d.textContent),
    ).toEqual(["1", "2"]);
  });

  it("clicking a card is the mouse's version of releasing on it", () => {
    const picked: string[] = [];
    render(
      <TabSwitcher
        tabs={[term("one"), term("two")]}
        selectedId="one"
        paneRef={paneWith([], "")}
        termText={() => ""}
        onPick={(id) => picked.push(id)}
      />,
    );
    screen.getAllByRole("option")[1].click();
    expect(picked).toEqual(["two"]);
  });

  it("shows a card for a tab whose page this document can't see", () => {
    // A preview tab's page lives in a native webview — no clonable host, so the
    // card is its header alone rather than a broken frame.
    render(
      <TabSwitcher
        tabs={[{ id: "p1", type: "preview", url: "http://localhost:5173" } as SubTab]}
        selectedId="p1"
        paneRef={paneWith(["p1"], "")}
        termText={() => null}
        onPick={() => {}}
      />,
    );
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(document.querySelector(".tsw-scale")!.children).toHaveLength(0);
  });
});
