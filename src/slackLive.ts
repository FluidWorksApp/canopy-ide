// The Slack bridge wired to the real app: requests polled from the hub on
// canopyide.dev with the signed-in account, the companion's turns, and the
// replies handed back. Kept apart from slackBridge.ts so the rules there stay
// testable without Tauri.

import { slackHub, type SlackHubItem, type SlackHubStatus } from "./ipc";
import { askCompanion } from "./companionSession";
import { companionName } from "./companion";
import { createSlackBridge, type SlackBridge, type SlackProposal } from "./slackBridge";

const POLL_MS = 3_000;
/** Signed out, Slack not set up on canopyide.dev, or nothing linked: look
 *  again rarely rather than asking every few seconds. */
const IDLE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60_000;

let bridge: SlackBridge | null = null;
let poke: (() => void) | null = null;

/** Start polling once; later calls are no-ops. Returns the stop. */
export function startSlack(): () => void {
  if (bridge) return () => {};
  const live = createSlackBridge({
    companionName,
    ask: askCompanion,
    reply: (id, text) => slackHub("reply", { id, text }).then(() => {}),
    // `summary`, not `action`: the hub's dispatcher owns that field name.
    approval: (id, proposalId, p) =>
      slackHub("approval", { id, proposalId, summary: p.action, project: p.project ?? null, detail: p.detail ?? null }).then(() => {}),
    cancel: (proposalId, accepted) => slackHub("approval-cancel", { proposalId, accepted }).then(() => {}),
    newId: () => crypto.randomUUID().replace(/-/g, ""),
    log: (message) => console.warn(message),
  });
  bridge = live;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let linkedUntil = 0;
  const next = (ms: number) => {
    if (!stopped) timer = setTimeout(() => void tick(), ms);
  };
  const tick = async () => {
    try {
      if (Date.now() >= linkedUntil) {
        const status = await slackHub<SlackHubStatus>("status");
        if (!status.configured || status.linked.length === 0) return next(IDLE_MS);
        linkedUntil = Date.now() + IDLE_MS;
      }
      const { items } = await slackHub<{ items: SlackHubItem[] }>("poll");
      failures = 0;
      live.receive(Array.isArray(items) ? items : []);
      next(POLL_MS);
    } catch {
      // Signed out reads as a failure too; it backs off to a minute, so
      // signing back in is noticed without hammering the account API.
      failures += 1;
      linkedUntil = 0;
      next(Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** failures));
    }
  };
  poke = () => {
    clearTimeout(timer);
    linkedUntil = 0;
    failures = 0;
    void tick();
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    bridge = null;
    poke = null;
  };
}

/** Linking or unlinking in Settings changes what there is to poll; look now. */
export function slackStatusChanged(): void {
  poke?.();
}

/** The approval question in Slack too, when the companion is answering there. */
export function slackConfirm(p: SlackProposal) {
  return bridge?.confirm(p) ?? null;
}
