export type Corner = "tl" | "tr" | "bl" | "br";

/** The corner nearest a point in the window. */
export function nearestCorner(
  x: number,
  y: number,
  w: number,
  h: number,
): Corner {
  return `${y < h / 2 ? "t" : "b"}${x < w / 2 ? "l" : "r"}` as Corner;
}
