export type SplitAxis = "horizontal" | "vertical";

export type TerminalSplitNode =
  | { type: "leaf"; tabId: string }
  | {
      type: "split";
      id: string;
      axis: SplitAxis;
      ratio: number;
      first: TerminalSplitNode;
      second: TerminalSplitNode;
    };

export interface TerminalGroup {
  id: string;
  root: TerminalSplitNode;
  activeTabId: string;
  zoomedTabId?: string;
}

export interface PaneRect {
  tabId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SplitDivider {
  nodeId: string;
  axis: SplitAxis;
  left: number;
  top: number;
  width: number;
  height: number;
  parentLeft: number;
  parentTop: number;
  parentWidth: number;
  parentHeight: number;
}

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

export const splitId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function leafIds(node: TerminalSplitNode): string[] {
  return node.type === "leaf"
    ? [node.tabId]
    : [...leafIds(node.first), ...leafIds(node.second)];
}

export function splitLeaf(
  node: TerminalSplitNode,
  tabId: string,
  nextTabId: string,
  axis: SplitAxis,
): TerminalSplitNode {
  if (node.type === "leaf") {
    return node.tabId === tabId
      ? {
          type: "split",
          id: splitId(),
          axis,
          ratio: 0.5,
          first: node,
          second: { type: "leaf", tabId: nextTabId },
        }
      : node;
  }
  const first = splitLeaf(node.first, tabId, nextTabId, axis);
  if (first !== node.first) return { ...node, first };
  const second = splitLeaf(node.second, tabId, nextTabId, axis);
  return second === node.second ? node : { ...node, second };
}

export function removeLeaf(
  node: TerminalSplitNode,
  tabId: string,
): TerminalSplitNode | null {
  if (node.type === "leaf") return node.tabId === tabId ? null : node;
  const first = removeLeaf(node.first, tabId);
  const second = removeLeaf(node.second, tabId);
  if (!first) return second;
  if (!second) return first;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

export function updateSplitRatio(
  node: TerminalSplitNode,
  nodeId: string,
  ratio: number,
): TerminalSplitNode {
  if (node.type === "leaf") return node;
  if (node.id === nodeId) {
    return { ...node, ratio: Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio)) };
  }
  const first = updateSplitRatio(node.first, nodeId, ratio);
  const second = updateSplitRatio(node.second, nodeId, ratio);
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second };
}

export function equalizeSplits(node: TerminalSplitNode): TerminalSplitNode {
  if (node.type === "leaf") return node;
  return {
    ...node,
    ratio: 0.5,
    first: equalizeSplits(node.first),
    second: equalizeSplits(node.second),
  };
}

export function mapSplitTabIds(
  node: TerminalSplitNode,
  ids: ReadonlyMap<string, string>,
): TerminalSplitNode | null {
  if (node.type === "leaf") {
    const tabId = ids.get(node.tabId);
    return tabId ? { type: "leaf", tabId } : null;
  }
  const first = mapSplitTabIds(node.first, ids);
  const second = mapSplitTabIds(node.second, ids);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function swapLeaves(
  node: TerminalSplitNode,
  firstTabId: string,
  secondTabId: string,
): TerminalSplitNode {
  if (node.type === "leaf") {
    if (node.tabId === firstTabId) return { ...node, tabId: secondTabId };
    if (node.tabId === secondTabId) return { ...node, tabId: firstTabId };
    return node;
  }
  const first = swapLeaves(node.first, firstTabId, secondTabId);
  const second = swapLeaves(node.second, firstTabId, secondTabId);
  return first === node.first && second === node.second
    ? node
    : { ...node, first, second };
}

export function layoutSplit(
  node: TerminalSplitNode,
  zoomedTabId?: string,
): { panes: PaneRect[]; dividers: SplitDivider[] } {
  if (zoomedTabId && leafIds(node).includes(zoomedTabId)) {
    return {
      panes: [{ tabId: zoomedTabId, left: 0, top: 0, width: 1, height: 1 }],
      dividers: [],
    };
  }
  const panes: PaneRect[] = [];
  const dividers: SplitDivider[] = [];
  const walk = (
    current: TerminalSplitNode,
    left: number,
    top: number,
    width: number,
    height: number,
  ) => {
    if (current.type === "leaf") {
      panes.push({ tabId: current.tabId, left, top, width, height });
      return;
    }
    const ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, current.ratio));
    if (current.axis === "horizontal") {
      const firstWidth = width * ratio;
      walk(current.first, left, top, firstWidth, height);
      walk(current.second, left + firstWidth, top, width - firstWidth, height);
      dividers.push({
        nodeId: current.id,
        axis: current.axis,
        left: left + firstWidth,
        top,
        width: 0,
        height,
        parentLeft: left,
        parentTop: top,
        parentWidth: width,
        parentHeight: height,
      });
    } else {
      const firstHeight = height * ratio;
      walk(current.first, left, top, width, firstHeight);
      walk(current.second, left, top + firstHeight, width, height - firstHeight);
      dividers.push({
        nodeId: current.id,
        axis: current.axis,
        left,
        top: top + firstHeight,
        width,
        height: 0,
        parentLeft: left,
        parentTop: top,
        parentWidth: width,
        parentHeight: height,
      });
    }
  };
  walk(node, 0, 0, 1, 1);
  return { panes, dividers };
}

export type PaneDirection = "left" | "right" | "up" | "down";

export function neighborPane(
  node: TerminalSplitNode,
  tabId: string,
  direction: PaneDirection,
): string | null {
  const panes = layoutSplit(node).panes;
  const from = panes.find((pane) => pane.tabId === tabId);
  if (!from) return null;
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  let best: { id: string; score: number } | null = null;
  for (const pane of panes) {
    if (pane.tabId === tabId) continue;
    const x = pane.left + pane.width / 2;
    const y = pane.top + pane.height / 2;
    const primary =
      direction === "left"
        ? fx - x
        : direction === "right"
          ? x - fx
          : direction === "up"
            ? fy - y
            : y - fy;
    if (primary <= 0) continue;
    const cross = direction === "left" || direction === "right" ? Math.abs(y - fy) : Math.abs(x - fx);
    const score = primary + cross * 2;
    if (!best || score < best.score) best = { id: pane.tabId, score };
  }
  return best?.id ?? null;
}
