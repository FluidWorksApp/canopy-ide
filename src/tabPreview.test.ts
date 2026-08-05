import { describe, it, expect } from "vitest";
import {
  clonePane,
  nextTickMs,
  paneNodeCount,
  tailLines,
  PREVIEW_BUDGET_MS,
  PREVIEW_TICK_MS,
  PREVIEW_TICK_MAX_MS,
} from "./tabPreview";

const host = (html: string): HTMLElement => {
  const el = document.createElement("div");
  el.style.display = "none";
  el.innerHTML = html;
  return el;
};

describe("tailLines", () => {
  it("keeps the end, not the beginning", () => {
    expect(tailLines("a\nb\nc\nd", 2)).toEqual(["c", "d"]);
  });

  it("drops the blank tail a prompt leaves under itself", () => {
    expect(tailLines("work\n$ \n\n\n", 4)).toEqual(["work", "$ "]);
  });

  it("keeps blank lines that are inside the output", () => {
    expect(tailLines("one\n\ntwo", 4)).toEqual(["one", "", "two"]);
  });

  it("has nothing to show for an empty buffer", () => {
    expect(tailLines("", 10)).toEqual([]);
    expect(tailLines("\n\n", 10)).toEqual([]);
  });
});

describe("clonePane", () => {
  it("undoes the hiding the host carries", () => {
    const clone = clonePane(host("<p>hello</p>"));
    expect(clone).not.toBeNull();
    expect(clone!.style.display).toBe("block");
    expect(clone!.style.visibility).toBe("visible");
    expect(clone!.textContent).toBe("hello");
  });

  it("leaves nothing behind that would load, run or paint blank", () => {
    const clone = clonePane(
      host(
        `<iframe src="http://x"></iframe><canvas></canvas><video></video>
         <script>window.x = 1</script><div data-preview-skip>secret</div>
         <span>kept</span>`,
      ),
    );
    expect(clone!.querySelector("iframe")).toBeNull();
    expect(clone!.querySelector("canvas")).toBeNull();
    expect(clone!.querySelector("video")).toBeNull();
    expect(clone!.querySelector("script")).toBeNull();
    expect(clone!.querySelector("[data-preview-skip]")).toBeNull();
    expect(clone!.querySelector("span")?.textContent).toBe("kept");
  });

  it("carries no ids — a duplicate id makes every #id query ambiguous", () => {
    const el = host(`<div id="inner"><b id="deep">x</b></div>`);
    el.id = "outer";
    el.setAttribute("data-tab-id", "t1");
    const clone = clonePane(el)!;
    expect(clone.id).toBe("");
    expect(clone.querySelectorAll("[id]")).toHaveLength(0);
    expect(clone.getAttribute("data-tab-id")).toBeNull();
  });

  it("is inert and unreachable — a picture is not a control", () => {
    const clone = clonePane(host(`<button>Delete</button>`))!;
    expect(clone.getAttribute("inert")).toBe("");
    expect(clone.getAttribute("aria-hidden")).toBe("true");
    expect(clone.style.pointerEvents).toBe("none");
  });

  it("truncates a pane past the cap instead of showing nothing", () => {
    const big = host("<i></i>".repeat(50));
    expect(paneNodeCount(big)).toBe(50);
    const clipped = clonePane(big, 10)!;
    expect(clipped).not.toBeNull();
    expect(paneNodeCount(clipped)).toBe(10);
    expect(paneNodeCount(clonePane(big, 100)!)).toBe(50);
  });

  it("keeps the top of the pane — the part a thumbnail has room for", () => {
    const big = host(
      `<header>first</header>${"<p>row</p>".repeat(40)}<footer>last</footer>`,
    );
    const clipped = clonePane(big, 5)!;
    expect(clipped.textContent).toContain("first");
    expect(clipped.textContent).not.toContain("last");
  });

  it("spends the budget inside a big container, not on skipping it", () => {
    // One wrapper holding more than the budget: the wrapper is walked child by
    // child so the preview shows its first rows, rather than the wrapper being
    // dropped whole and the card coming out empty.
    const big = host(`<div class="diff">${"<p>row</p>".repeat(40)}</div>`);
    const clipped = clonePane(big, 5)!;
    expect(clipped.querySelector(".diff")).not.toBeNull();
    expect(clipped.querySelectorAll("p")).toHaveLength(4);
  });

  it("still strips and de-ids what it truncated down to", () => {
    const big = host(
      `<div id="head"><iframe src="http://x"></iframe><span>kept</span></div>` +
        "<i></i>".repeat(50),
    );
    const clipped = clonePane(big, 6)!;
    expect(clipped.querySelector("iframe")).toBeNull();
    expect(clipped.querySelectorAll("[id]")).toHaveLength(0);
    expect(clipped.textContent).toContain("kept");
  });

  it("has nothing to show for a missing or empty host", () => {
    expect(clonePane(null)).toBeNull();
    expect(clonePane(undefined)).toBeNull();
    // A native webview's pane: the host is here, its page isn't in this
    // document, so there is no picture to take.
    expect(clonePane(host(""))).toBeNull();
  });
});

describe("nextTickMs", () => {
  it("backs off when a pass costs more than a frame", () => {
    expect(nextTickMs(PREVIEW_BUDGET_MS + 5, 220)).toBe(440);
  });

  it("never backs off past the ceiling — the stream stays a stream", () => {
    expect(nextTickMs(500, PREVIEW_TICK_MAX_MS)).toBe(PREVIEW_TICK_MAX_MS);
  });

  it("speeds back up when the panes turn out to be cheap", () => {
    expect(nextTickMs(1, 880)).toBe(440);
  });

  it("never runs faster than the base rate", () => {
    expect(nextTickMs(0, PREVIEW_TICK_MS)).toBe(PREVIEW_TICK_MS);
  });

  it("holds steady in between", () => {
    expect(nextTickMs(PREVIEW_BUDGET_MS - 1, 600)).toBe(600);
  });
});
