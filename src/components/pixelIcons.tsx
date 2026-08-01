// The Pixel skin's twin of every rail concept.
//
// A 1.8px stroke has nowhere to go on an 8x8 grid: half a pixel is a colour
// the machine this skin is imitating did not have. So these are not the rail
// icons redrawn smaller — they are the same concepts drawn again in whole
// blocks, and they only ever appear under `data-theme="pixel"`.
//
// The blocks are the source and the path is compiled from them. Hand-inlining
// the `d` strings would save a millisecond of work at render and cost the next
// person the ability to read, or fix, a single square.
import { useEffect, useState } from "react";
import { THEME_CHANGE_EVENT } from "../settings";

interface IconProps {
  size?: number;
  className?: string;
}

/** One block: x, y, width, height, in grid units. */
type Block = [number, number, number, number];

/** Blocks to one fill path — a closed rectangle per block, all in one `d`, so
 *  a glyph is one node no matter how many squares it is made of. */
function px(blocks: Block[]): string {
  return blocks.map(([x, y, w, h]) => `M${x} ${y}h${w}v${h}h${-w}z`).join("");
}

/** How much of its own box a line icon's ink actually covers, measured across
 *  the rail set: the paths run roughly 3->21 inside a 24 grid. A pixel twin's
 *  blocks, by contrast, use all eight of their eight. */
const LINE_INK_RATIO = 0.741;

/** The box a twin draws in so it carries the same weight as the line icon the
 *  caller asked for.
 *
 *  Both sets were rendered at the same number and the twins came out a third
 *  larger on average — the sparsest line glyph, Git, was twice — because a
 *  full-bleed 8x8 block grid is not the same amount of ink as a 1.8px stroke
 *  inside a 24 grid with margins. `size` therefore means here what it means
 *  everywhere else in the app: the size of the equivalent line icon. The twin
 *  works out its own box.
 *
 *  Snapped to whole blocks. 22 * 0.741 is 16.3, which would land every block
 *  edge on a 2.04px boundary and undo the one thing this icon set is for. */
function inkBox(size: number): number {
  return Math.max(8, Math.round((size * LINE_INK_RATIO) / 8) * 8);
}

function pixelIcon(blocks: Block[]) {
  const d = px(blocks);
  return function PixelIcon({ size = 22, className }: IconProps) {
    const box = inkBox(size);
    return (
      <svg
        width={box}
        height={box}
        viewBox="0 0 8 8"
        /* Geometry, not paint: this keeps the block edges on whole device
           pixels at whatever size the caller asks for. It lives on the
           element rather than in the skin's stylesheet because an icon that
           needs a stylesheet to stop being blurry is not a pixel icon. */
        shapeRendering="crispEdges"
        className={className}
        aria-hidden={true}
      >
        <path d={d} fill="currentColor" />
      </svg>
    );
  };
}

export const PixelFilesIcon = pixelIcon([
  [0, 1, 3, 1],
  [0, 2, 8, 5],
]);

export const PixelRunsIcon = pixelIcon([
  [0, 0, 5, 3],
  [0, 4, 5, 3],
  [6, 2, 1, 1],
  [6, 3, 2, 2],
  [6, 5, 1, 1],
]);

export const PixelChangesIcon = pixelIcon([
  [0, 1, 3, 1],
  [1, 0, 1, 3],
  [4, 1, 4, 1],
  [0, 5, 3, 1],
  [4, 5, 4, 1],
]);

export const PixelGitIcon = pixelIcon([
  [1, 0, 2, 2],
  [2, 2, 1, 4],
  [1, 6, 2, 2],
  [5, 2, 2, 2],
  [3, 3, 2, 1],
]);

export const PixelReviewsIcon = pixelIcon([
  [1, 0, 2, 2],
  [2, 2, 1, 4],
  [1, 6, 2, 2],
  [5, 5, 2, 2],
  [6, 2, 1, 3],
  [4, 1, 2, 1],
]);

export const PixelIssuesIcon = pixelIcon([
  [2, 0, 4, 1],
  [1, 1, 1, 1],
  [6, 1, 1, 1],
  [0, 2, 1, 4],
  [7, 2, 1, 4],
  [1, 6, 1, 1],
  [6, 6, 1, 1],
  [2, 7, 4, 1],
  [3, 3, 2, 2],
]);

export const PixelAgentsIcon = pixelIcon([
  [2, 0, 1, 1],
  [5, 0, 1, 1],
  [1, 1, 6, 1],
  [1, 2, 1, 4],
  [6, 2, 1, 4],
  [1, 6, 6, 1],
  [2, 3, 1, 1],
  [5, 3, 1, 1],
  [3, 5, 2, 1],
]);

export const PixelTasksIcon = pixelIcon([
  [0, 1, 1, 1],
  [1, 2, 1, 1],
  [2, 0, 1, 2],
  [4, 1, 4, 1],
  [0, 4, 8, 1],
  [0, 6, 8, 1],
]);

export const PixelNotesIcon = pixelIcon([
  [2, 0, 4, 1],
  [1, 1, 1, 3],
  [6, 1, 1, 3],
  [2, 4, 4, 1],
  [2, 5, 4, 1],
  [3, 6, 2, 1],
  [3, 7, 2, 1],
]);

export const PixelResearchIcon = pixelIcon([
  [0, 0, 6, 1],
  [0, 1, 1, 6],
  [0, 7, 4, 1],
  [2, 2, 3, 1],
  [2, 4, 2, 1],
  [5, 4, 3, 1],
  [5, 5, 1, 2],
  [7, 5, 1, 2],
  [6, 7, 1, 1],
]);

export const PixelTeamIcon = pixelIcon([
  [2, 1, 2, 2],
  [1, 4, 4, 3],
  [5, 1, 2, 2],
  [5, 4, 3, 3],
]);

export const PixelToolsIcon = pixelIcon([
  [1, 0, 1, 3],
  [5, 0, 1, 3],
  [0, 3, 8, 1],
  [1, 4, 6, 2],
  [3, 6, 2, 2],
]);

export const PixelStatsIcon = pixelIcon([
  [0, 7, 8, 1],
  [1, 4, 2, 3],
  [3, 2, 2, 5],
  [5, 0, 2, 7],
]);

export const PixelSettingsIcon = pixelIcon([
  [3, 0, 2, 1],
  [1, 1, 1, 1],
  [5, 1, 1, 1],
  [0, 3, 1, 2],
  [7, 3, 1, 2],
  [1, 6, 1, 1],
  [5, 6, 1, 1],
  [3, 7, 2, 1],
  [2, 2, 4, 4],
]);

export const PixelPanelIcon = pixelIcon([
  [0, 0, 8, 1],
  [0, 1, 1, 6],
  [7, 1, 1, 6],
  [0, 7, 8, 1],
  [3, 1, 1, 6],
]);

export const PixelTerminalIcon = pixelIcon([
  [0, 0, 8, 1],
  [0, 1, 1, 6],
  [7, 1, 1, 6],
  [0, 7, 8, 1],
  [2, 2, 1, 1],
  [3, 3, 1, 1],
  [2, 4, 1, 1],
  [4, 5, 3, 1],
]);

/** Is the Pixel skin the one on screen?
 *
 *  The skin is an attribute on <html> that applyTheme() (settings.ts) stamps,
 *  so there is nothing to subscribe to but the event it fires afterwards. The
 *  one read of the raw string in the app lives here: a surface that wants the
 *  twins asks this, and nothing else has to know what the attribute is called
 *  or which value means pixels.
 *
 *  A surface with a twin calls this once and picks per icon — a hook that took
 *  a pair and returned one would have to be called in a loop, which is the one
 *  thing a hook cannot be. */
export function usePixelSkin(): boolean {
  const [on, setOn] = useState(
    () => document.documentElement.dataset.theme === "pixel",
  );
  useEffect(() => {
    const read = () =>
      setOn(document.documentElement.dataset.theme === "pixel");
    // The initial state is read during the first render, and the theme can be
    // applied between that and this effect running. Re-read rather than trust
    // it — a missed switch here leaves stroke icons on a skin that cannot
    // draw them, and nothing would correct it until the next switch.
    read();
    window.addEventListener(THEME_CHANGE_EVENT, read);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, read);
  }, []);
  return on;
}
