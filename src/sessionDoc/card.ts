// A handoff packet as a team-chat share card (cardSchema.ts `handoff`).
//
// The card carries the packet's markdown, clipped to fit, plus the session's
// identity. The sender's ShareDialog previews the exact card and its text
// fallback before anything is sent, and runs the credential check over the
// packet — a packet is drafted from the person's own prompts.

import { basename } from "../paths";
import { repoRefFor } from "../shareCards";
import { LIMITS, clipBytes, cleanLine, stripAnsi, type HandoffCard } from "../teamMessaging/cardSchema";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function buildHandoffCard(args: {
  title: string;
  agent: string;
  sessionId: string;
  markdown: string;
  cwd?: string;
  /** Git checkout, for the repo the card names (by origin only). */
  repo?: string | null;
}): Promise<HandoffCard> {
  // Control and bidi characters out, line endings normalised: the recipient
  // will refuse anything else, and the sender must never send what its own
  // teammates would drop.
  const clean = stripAnsi(args.markdown).replace(/\s+$/, "");
  const { text, clipped } = clipBytes(clean, LIMITS.packetBytes - 64);
  const packet = clipped ? `${text}\n\n…(packet shortened to fit a chat message)` : text;
  const repoRef = args.repo ? await repoRefFor(args.repo).catch(() => undefined) : undefined;
  const dir = args.cwd ? cleanLine(basename(args.cwd), 200).replace(/[\\/]/g, "") : "";
  return {
    type: "handoff",
    v: 1,
    title: cleanLine(args.title, LIMITS.title) || "Agent session",
    agent: cleanLine(args.agent, 64) || "agent",
    session: SESSION_ID.test(args.sessionId) ? args.sessionId : args.sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128) || "unknown",
    packet,
    ...(dir ? { dir } : {}),
    ...(repoRef ? { repo: repoRef } : {}),
    ...(clipped ? { truncated: true } : {}),
  };
}
