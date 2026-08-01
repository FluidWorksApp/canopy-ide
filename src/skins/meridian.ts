import type { SkinDef } from "./types";

export const meridian: SkinDef = {
  id: "meridian",
  label: "Meridian",
  note: "cool paper + ink",
  // The card previews --bg-deep rather than the editor canvas. Meridian and
  // Daylight are both near-white at the canvas, so a card painted there would
  // be indistinguishable from Daylight's #f5f6f8; the shell grey is the thing
  // that actually differs, so that is what the swatch shows.
  preview: {
    bg: "#dfe4ec",
    raised: "#ffffff",
    text: "#16202e",
    accent: "#1f5fbf",
  },
  // The terminal sits on --bg-alt, the same plane the side panels use, so it
  // reads as part of the shell rather than a white sheet dropped into it.
  //
  // Every slot here clears 4.5:1 against that background, which is what forces
  // the bright half downward: on paper "bright" cannot mean paler, so each
  // bright slot is a deeper, more saturated version of its normal partner —
  // the emphasis a program asks for arrives as more ink, not less. The grey
  // ramp is the part that has to be re-read rather than inverted:
  //   black       body ink, what a program means by "the default dark"
  //   white       mid ink — programs that set fg=white must not vanish here
  //   brightBlack the dim slot (comments, timestamps), --text-dim so it
  //               matches dim text everywhere else in the shell; the one
  //               bright slot lighter than its partner, because darker than
  //               black is just black
  //   brightWhite maximum emphasis, so the darkest ink in the skin
  term: {
    background: "#eaeef4",
    foreground: "#16202e",
    cursor: "#1f5fbf",
    selectionBackground: "#c8dcf6",
    black: "#202a3a",
    red: "#bf2f3f",
    green: "#1b7048",
    yellow: "#7d5309",
    blue: "#1f5fbf",
    magenta: "#6134b5",
    cyan: "#0e6470",
    white: "#5f6b7d",
    brightBlack: "#525e70",
    brightRed: "#8f1f2d",
    brightGreen: "#0f5334",
    brightYellow: "#5c3c05",
    brightBlue: "#16468f",
    brightMagenta: "#47228a",
    brightCyan: "#094a54",
    brightWhite: "#16202e",
  },
  monaco: { base: "vs", colors: { "editor.background": "#f6f8fb" } },
};
