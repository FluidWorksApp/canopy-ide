// Device-tab annotations: what a click on a device frame resolves to in the
// app's accessibility tree, plus the user's comment — and the opening context
// an agent gets when that feedback is handed over (same single-line contract as
// previewFeedbackContext: PTY-typed prompts must not contain newlines).
//
// The web picker is injected into the page and reports a CSS selector and the
// React components above it. Nothing is injected here: the frame is a picture,
// so a click is resolved against the accessibility tree the device already
// publishes. That works on any app without its cooperation — but it also means
// the anchor is weaker, and how much weaker depends on the toolkit. See
// `anchorOf`.

export interface DeviceBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DeviceNode {
  /** Index into the parsed list; also the ref an agent targets. */
  n: number;
  /** Parent's index, or -1 for the root. */
  parent: number;
  depth: number;
  text: string;
  contentDesc: string;
  /** `the.banana.app:id/foo` when the toolkit publishes one — Views do, and
   *  Compose does not unless the app opts in with testTagsAsResourceId. */
  resourceId: string;
  className: string;
  package: string;
  clickable: boolean;
  enabled: boolean;
  bounds: DeviceBounds;
}

export interface DeviceAnnotation {
  n: number;
  serial: string;
  /** The foreground component, `package/activity`, when known. */
  component: string;
  resourceId: string;
  className: string;
  text: string;
  contentDesc: string;
  clickable: boolean;
  bounds: DeviceBounds;
  comment: string;
}

const attr = (el: Element, name: string) => el.getAttribute(name) ?? "";

/** `[x1,y1][x2,y2]` — uiautomator's rectangle, in device pixels. */
export function parseBounds(raw: string): DeviceBounds | null {
  const m = raw.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
  if (x2 < x1 || y2 < y1) return null;
  return { x1, y1, x2, y2 };
}

export const areaOf = (b: DeviceBounds) => (b.x2 - b.x1) * (b.y2 - b.y1);

export const contains = (b: DeviceBounds, x: number, y: number) =>
  x >= b.x1 && x < b.x2 && y >= b.y1 && y < b.y2;

/**
 * The `<hierarchy>` uiautomator dumps, flattened in document order with each
 * node's parent recorded. Flat rather than nested because every consumer wants
 * either a hit test (which walks all of them) or an ancestor walk (which
 * follows `parent`) — neither is served by rebuilding a tree.
 *
 * Nodes without a parseable `bounds` are dropped: they cannot be hit-tested,
 * cannot be drawn, and cannot be tapped, which is everything this list is for.
 */
export function parseUiDump(xml: string): DeviceNode[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return [];
  const out: DeviceNode[] = [];
  const walk = (el: Element, parent: number, depth: number) => {
    let index = parent;
    const bounds = parseBounds(attr(el, "bounds"));
    if (bounds) {
      index = out.length;
      out.push({
        n: index,
        parent,
        depth,
        text: attr(el, "text"),
        contentDesc: attr(el, "content-desc"),
        resourceId: attr(el, "resource-id"),
        className: attr(el, "class"),
        package: attr(el, "package"),
        clickable: attr(el, "clickable") === "true",
        enabled: attr(el, "enabled") !== "false",
        bounds,
      });
    }
    for (const child of Array.from(el.children)) {
      if (child.tagName === "node") walk(child, index, depth + 1);
    }
  };
  for (const root of Array.from(doc.documentElement?.children ?? [])) {
    if (root.tagName === "node") walk(root, -1, 0);
  }
  return out;
}

/**
 * The node a click landed on: the smallest one containing the point.
 *
 * Smallest area rather than greatest depth — a deep node is not reliably a
 * small one. Compose in particular emits full-screen wrappers several levels
 * down, and picking by depth would hand back the wrapper over the label the
 * user actually aimed at. Depth only breaks ties between equal areas.
 */
export function nodeAt(nodes: DeviceNode[], x: number, y: number): DeviceNode | null {
  let best: DeviceNode | null = null;
  for (const node of nodes) {
    if (!contains(node.bounds, x, y)) continue;
    if (!best) {
      best = node;
      continue;
    }
    const a = areaOf(node.bounds);
    const b = areaOf(best.bounds);
    if (a < b || (a === b && node.depth > best.depth)) best = node;
  }
  return best;
}

/**
 * The node that would actually respond to a tap there: the nearest clickable
 * ancestor, or the node itself.
 *
 * This walk is not optional. A Compose button arrives as a clickable node with
 * no text, and its label as a separate non-clickable node inside it — so the
 * thing the user can see and the thing that reacts are never the same node.
 */
export function actionableFor(nodes: DeviceNode[], node: DeviceNode): DeviceNode {
  let cur: DeviceNode | undefined = node;
  while (cur) {
    if (cur.clickable) return cur;
    cur = cur.parent >= 0 ? nodes[cur.parent] : undefined;
  }
  return node;
}

/** What the user can read on it: its own text, else its descendants'. */
export function labelFor(nodes: DeviceNode[], node: DeviceNode): string {
  const own = node.text || node.contentDesc;
  if (own.trim()) return own.trim();
  const inside = nodes
    .filter((c) => c !== node && contains(node.bounds, c.bounds.x1, c.bounds.y1))
    .map((c) => (c.text || c.contentDesc).trim())
    .filter(Boolean);
  return [...new Set(inside)].join(" ").trim();
}

/** Where a click on the displayed frame lands in device pixels. */
export function toDevicePoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  deviceWidth: number,
  deviceHeight: number,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = Math.round(((clientX - rect.left) / rect.width) * deviceWidth);
  const y = Math.round(((clientY - rect.top) / rect.height) * deviceHeight);
  if (x < 0 || y < 0 || x >= deviceWidth || y >= deviceHeight) return null;
  return { x, y };
}

/** The tap point for a node.
 *
 *  Truncated, not rounded: the device computes this in Java integer arithmetic,
 *  so a node spanning 2069–2112 centres on 2090 and not 2091. Rounding would
 *  put our refs half a pixel off the ones `android layout` reports for the same
 *  node, and the two are meant to be interchangeable. */
export const centerOf = (b: DeviceBounds) => ({
  x: Math.trunc((b.x1 + b.x2) / 2),
  y: Math.trunc((b.y1 + b.y2) / 2),
});

const flat = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

/**
 * How confidently this annotation points at source, and what to say about it.
 *
 * A resource id greps straight to `R.id.x` or an `@+id/x` in a layout, so it is
 * named as the anchor. Compose publishes none, and claiming selector-grade
 * precision there would send an agent hunting for an id that does not exist —
 * so the fallback says plainly that the anchor is the visible text.
 */
export function anchorOf(a: DeviceAnnotation): string {
  if (a.resourceId) return `resource id \`${a.resourceId}\``;
  if (a.text.trim() || a.contentDesc.trim()) {
    return `visible text "${flat(a.text || a.contentDesc, 80)}" (no resource id — search the UI source for that string)`;
  }
  return `no resource id and no text — locate it by position (${a.className || "unknown class"} at ${boundsText(a.bounds)})`;
}

const boundsText = (b: DeviceBounds) => `[${b.x1},${b.y1}][${b.x2},${b.y2}]`;

function annotationLine(a: DeviceAnnotation): string {
  const cls = a.className ? `<${a.className}>` : "<element>";
  const note = a.comment.trim() ? ` Feedback: ${flat(a.comment.trim(), 500)}` : "";
  const tappable = a.clickable ? ", tappable" : "";
  return `(${a.n}) ${cls} at ${anchorOf(a)}${tappable}.${note}`;
}

export function deviceFeedbackContext(
  annotations: DeviceAnnotation[],
  serial: string,
  componentPath?: string | null,
): string {
  const parts = annotations.map(annotationLine).join(" ");
  const component = annotations.find((a) => a.component)?.component ?? "";
  const where = component ? `${component} on ${serial}` : serial;
  const source = componentPath
    ? `The app is built from \`${componentPath}\` — that is the codebase to change. `
    : "";
  // Say once that ids may be absent, rather than per item: under Compose none
  // of them will have one, and repeating it would bury the actual feedback.
  const compose = annotations.some((a) => !a.resourceId)
    ? `Some items have no resource id, which is normal for Jetpack Compose — for those, ` +
      `find the composable that renders the quoted text. `
    : "";
  return (
    `I was looking at this project's Android app running on ${where} and marked ` +
    `${annotations.length === 1 ? "an element" : `${annotations.length} elements`} with feedback. ` +
    source +
    `For each item, find where that element is produced in the source and make the requested ` +
    `change: ${parts} ${compose}` +
    `Verify the result builds, and summarize what you changed per item.`
  );
}
