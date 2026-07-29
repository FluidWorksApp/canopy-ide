import { describe, expect, it } from "vitest";
import {
  actionableFor,
  anchorOf,
  centerOf,
  contains,
  deviceFeedbackContext,
  labelFor,
  nodeAt,
  parseBounds,
  parseUiDump,
  toDevicePoint,
  type DeviceAnnotation,
} from "./android";

// Trimmed from a real `uiautomator dump` of a Jetpack Compose screen: a
// clickable button carrying no text, with its label as a separate
// non-clickable node inside it. Coordinates are the ones the device reported.
const COMPOSE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="the.banana.app" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
    <node index="0" text="" resource-id="android:id/content" class="android.widget.FrameLayout" package="the.banana.app" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
      <node index="0" text="" resource-id="" class="androidx.compose.ui.platform.ComposeView" package="the.banana.app" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
        <node index="0" text="YOU SPEAK YOURS" resource-id="" class="android.widget.TextView" package="the.banana.app" content-desc="" clickable="false" enabled="true" bounds="[233,947][848,1033]" />
        <node index="1" text="" resource-id="" class="android.view.View" package="the.banana.app" content-desc="" clickable="true" enabled="true" bounds="[63,2016][1017,2163]">
          <node index="0" text="G" resource-id="" class="android.widget.TextView" package="the.banana.app" content-desc="" clickable="false" enabled="true" bounds="[284,2062][317,2118]" />
          <node index="1" text="CONTINUE WITH GOOGLE" resource-id="" class="android.widget.TextView" package="the.banana.app" content-desc="" clickable="false" enabled="true" bounds="[369,2069][817,2112]" />
        </node>
      </node>
    </node>
  </node>
</hierarchy>`;

// The same shape from a View-based app, which does publish resource ids.
const VIEWS = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="com.example:id/root" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
    <node index="0" text="Sign in" resource-id="com.example:id/sign_in" class="android.widget.Button" package="com.example" content-desc="Sign in" clickable="true" enabled="true" bounds="[100,1000][980,1200]" />
  </node>
</hierarchy>`;

const annotation = (over: Partial<DeviceAnnotation> = {}): DeviceAnnotation => ({
  n: 1,
  serial: "emulator-5554",
  component: "the.banana.app/the.banana.app.MainActivity",
  resourceId: "",
  className: "android.view.View",
  text: "",
  contentDesc: "",
  clickable: true,
  bounds: { x1: 63, y1: 2016, x2: 1017, y2: 2163 },
  comment: "",
  ...over,
});

describe("parseBounds", () => {
  it("reads uiautomator's rectangle", () => {
    expect(parseBounds("[63,2016][1017,2163]")).toEqual({
      x1: 63,
      y1: 2016,
      x2: 1017,
      y2: 2163,
    });
  });

  it("accepts negative origins from off-screen nodes", () => {
    expect(parseBounds("[-10,-20][10,20]")).toEqual({ x1: -10, y1: -20, x2: 10, y2: 20 });
  });

  it("rejects an inverted rectangle rather than returning a negative area", () => {
    expect(parseBounds("[100,100][10,10]")).toBeNull();
  });

  it("rejects junk", () => {
    expect(parseBounds("")).toBeNull();
    expect(parseBounds("[1,2]")).toBeNull();
  });
});

describe("parseUiDump", () => {
  it("flattens the hierarchy in document order with parents recorded", () => {
    const nodes = parseUiDump(COMPOSE);
    expect(nodes).toHaveLength(7);
    expect(nodes[0].parent).toBe(-1);
    expect(nodes[0].className).toBe("android.widget.FrameLayout");
    // The label's parent is the clickable button, not the ComposeView.
    const label = nodes.find((n) => n.text === "CONTINUE WITH GOOGLE")!;
    expect(nodes[label.parent].clickable).toBe(true);
  });

  it("records depth so ties can be broken", () => {
    const nodes = parseUiDump(COMPOSE);
    expect(nodes[0].depth).toBe(0);
    expect(nodes.find((n) => n.text === "CONTINUE WITH GOOGLE")!.depth).toBe(4);
  });

  it("reads resource ids where the toolkit publishes them", () => {
    const nodes = parseUiDump(VIEWS);
    expect(nodes[1].resourceId).toBe("com.example:id/sign_in");
    expect(nodes[1].clickable).toBe(true);
  });

  it("returns nothing for malformed xml instead of throwing", () => {
    expect(parseUiDump("<hierarchy><node")).toEqual([]);
  });

  it("returns nothing for an empty dump", () => {
    expect(parseUiDump("")).toEqual([]);
  });
});

describe("nodeAt", () => {
  it("picks the smallest node containing the point", () => {
    const nodes = parseUiDump(COMPOSE);
    // Dead centre of the label.
    const hit = nodeAt(nodes, 593, 2090)!;
    expect(hit.text).toBe("CONTINUE WITH GOOGLE");
  });

  it("prefers the small label over the full-screen Compose wrappers above it", () => {
    // Three ancestors are all [0,0][1080,2400]; depth alone would pick a wrapper.
    const nodes = parseUiDump(COMPOSE);
    expect(nodeAt(nodes, 540, 990)!.text).toBe("YOU SPEAK YOURS");
  });

  it("falls back to the enclosing surface where nothing smaller is hit", () => {
    const nodes = parseUiDump(COMPOSE);
    const hit = nodeAt(nodes, 10, 10)!;
    expect(hit.bounds).toEqual({ x1: 0, y1: 0, x2: 1080, y2: 2400 });
  });

  it("returns null outside every node", () => {
    expect(nodeAt(parseUiDump(COMPOSE), 5000, 5000)).toBeNull();
  });

  it("treats the right and bottom edges as outside, so neighbours don't overlap", () => {
    const nodes = parseUiDump(VIEWS);
    expect(nodeAt(nodes, 980, 1100)!.resourceId).toBe("com.example:id/root");
    expect(nodeAt(nodes, 979, 1100)!.resourceId).toBe("com.example:id/sign_in");
  });
});

describe("actionableFor", () => {
  it("walks from a label to the button that actually responds", () => {
    const nodes = parseUiDump(COMPOSE);
    const label = nodeAt(nodes, 593, 2090)!;
    expect(label.clickable).toBe(false);
    const target = actionableFor(nodes, label);
    expect(target.clickable).toBe(true);
    expect(target.bounds).toEqual({ x1: 63, y1: 2016, x2: 1017, y2: 2163 });
  });

  it("keeps a node that is itself clickable", () => {
    const nodes = parseUiDump(VIEWS);
    const button = nodes[1];
    expect(actionableFor(nodes, button)).toBe(button);
  });

  it("returns the node itself when nothing above it is clickable", () => {
    const nodes = parseUiDump(COMPOSE);
    const heading = nodeAt(nodes, 540, 990)!;
    expect(actionableFor(nodes, heading)).toBe(heading);
  });
});

describe("labelFor", () => {
  it("uses the node's own text", () => {
    const nodes = parseUiDump(VIEWS);
    expect(labelFor(nodes, nodes[1])).toBe("Sign in");
  });

  it("gathers text from inside a button that carries none", () => {
    const nodes = parseUiDump(COMPOSE);
    const button = nodes.find((n) => n.clickable)!;
    expect(labelFor(nodes, button)).toBe("G CONTINUE WITH GOOGLE");
  });
});

describe("toDevicePoint", () => {
  const rect = { left: 100, top: 50, width: 270, height: 600 };

  it("scales a click on the displayed frame back to device pixels", () => {
    expect(toDevicePoint(235, 350, rect, 1080, 2400)).toEqual({ x: 540, y: 1200 });
  });

  it("maps the top-left corner to the origin", () => {
    expect(toDevicePoint(100, 50, rect, 1080, 2400)).toEqual({ x: 0, y: 0 });
  });

  it("rejects a click outside the frame", () => {
    expect(toDevicePoint(90, 350, rect, 1080, 2400)).toBeNull();
    expect(toDevicePoint(235, 700, rect, 1080, 2400)).toBeNull();
  });

  it("rejects an unlaid-out frame rather than dividing by zero", () => {
    expect(toDevicePoint(0, 0, { ...rect, width: 0 }, 1080, 2400)).toBeNull();
  });
});

describe("centerOf", () => {
  it("gives the tap point for a node", () => {
    // Matches what `android layout` reports for this node, independently.
    expect(centerOf({ x1: 369, y1: 2069, x2: 817, y2: 2112 })).toEqual({ x: 593, y: 2090 });
  });
});

describe("contains", () => {
  it("includes the top-left and excludes the bottom-right", () => {
    const b = { x1: 0, y1: 0, x2: 10, y2: 10 };
    expect(contains(b, 0, 0)).toBe(true);
    expect(contains(b, 9, 9)).toBe(true);
    expect(contains(b, 10, 10)).toBe(false);
  });
});

describe("anchorOf", () => {
  it("names the resource id when there is one", () => {
    expect(anchorOf(annotation({ resourceId: "com.example:id/sign_in" }))).toContain(
      "resource id `com.example:id/sign_in`",
    );
  });

  it("falls back to visible text and says the id is absent", () => {
    const a = anchorOf(annotation({ text: "CONTINUE WITH GOOGLE" }));
    expect(a).toContain('visible text "CONTINUE WITH GOOGLE"');
    expect(a).toContain("no resource id");
  });

  it("admits it can only give a position when there is neither", () => {
    const a = anchorOf(annotation());
    expect(a).toContain("[63,2016][1017,2163]");
    expect(a).toContain("no resource id and no text");
  });
});

describe("deviceFeedbackContext", () => {
  it("stays on one line, because the prompt is typed into a TUI", () => {
    const text = deviceFeedbackContext(
      [annotation({ text: "CONTINUE WITH GOOGLE", comment: "make this\nwider" })],
      "emulator-5554",
    );
    expect(text).not.toContain("\n");
  });

  it("names the device, the app and the codebase", () => {
    const text = deviceFeedbackContext([annotation()], "emulator-5554", "/repo/app");
    expect(text).toContain("the.banana.app/the.banana.app.MainActivity on emulator-5554");
    expect(text).toContain("`/repo/app`");
  });

  it("explains the missing ids once rather than per item", () => {
    const text = deviceFeedbackContext(
      [annotation({ n: 1, text: "A" }), annotation({ n: 2, text: "B" })],
      "emulator-5554",
    );
    expect(text.match(/normal for Jetpack Compose/g)).toHaveLength(1);
  });

  it("says nothing about Compose when every item has a resource id", () => {
    const text = deviceFeedbackContext(
      [annotation({ resourceId: "com.example:id/sign_in" })],
      "emulator-5554",
    );
    expect(text).not.toContain("Compose");
  });

  it("carries each item's comment", () => {
    const text = deviceFeedbackContext(
      [annotation({ n: 1, comment: "wrong colour" })],
      "emulator-5554",
    );
    expect(text).toContain("(1)");
    expect(text).toContain("Feedback: wrong colour");
  });

  it("counts items in the opening line", () => {
    expect(deviceFeedbackContext([annotation()], "x")).toContain("an element");
    expect(deviceFeedbackContext([annotation(), annotation()], "x")).toContain("2 elements");
  });
});
