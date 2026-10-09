// The Slack bridge wired to the real app: slack.rs events in, the companion's
// turns and the Web API out. Kept apart from slackBridge.ts so the rules there
// stay testable without Tauri.

import * as ipc from "./ipc";
import { askCompanion } from "./companionSession";
import { companionName } from "./companion";
import { getSettings } from "./settings";
import { createSlackBridge, linkedPeople, type SlackBridge, type SlackProposal } from "./slackBridge";

let bridge: SlackBridge | null = null;

function ownerName(): string {
  return linkedPeople(getSettings().slackPeople).find((p) => p.role === "me")?.label || "the owner";
}

/** Start listening once; later calls are no-ops. Returns the unlisten. */
export function startSlack(): () => void {
  if (bridge) return () => {};
  const live = createSlackBridge({
    people: () => getSettings().slackPeople,
    ownerName,
    companionName,
    ask: askCompanion,
    post: ipc.slackPost,
    update: ipc.slackUpdate,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    log: (message) => console.warn(message),
  });
  bridge = live;
  const offs = [ipc.onSlackMessage(live.onMessage), ipc.onSlackAction(live.onAction)];
  return () => {
    bridge = null;
    for (const off of offs) void off.then((fn) => fn());
  };
}

/** The approval question in Slack too, when the companion is answering there. */
export function slackConfirm(p: SlackProposal) {
  return bridge?.confirm(p) ?? null;
}
