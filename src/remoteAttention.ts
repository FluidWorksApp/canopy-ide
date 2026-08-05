// The attention channel, projected for the portal.
//
// A question raised in the desktop UI (canopy_ask_user, the branch-switch
// dialog, a review refusal) never touches the hook stream the portal already
// receives — it exists only in src/attention.ts. So the portal learns about it
// the same way it learns about the companion: the desktop pushes a snapshot on
// every change, and Rust carries whatever was last pushed.

import { attentionItems } from "./attention";
import type { RemoteAttentionItem } from "../shared/model";

/** Enough history for a phone's notification list; outstanding questions are
 *  always newest-first at the top of the store, so a cap cannot hide one that
 *  is still waiting inside the window a portal user would scroll. */
const MAX_ITEMS = 100;
/** A pasted log in a toast body must not bloat every four-second snapshot. */
const MAX_BODY = 400;

export function remoteAttentionSnapshot(): RemoteAttentionItem[] {
  return attentionItems()
    .slice(0, MAX_ITEMS)
    .map((x) => ({
      id: x.id,
      kind: x.kind,
      tone: x.tone,
      title: x.title,
      body: x.body ? x.body.slice(0, MAX_BODY) : undefined,
      source: x.source,
      projectId: x.projectId,
      projectName: x.projectName,
      ts: x.ts,
      resolvedAt: x.resolvedAt,
      resolution: x.resolution,
      dedupeKey: x.dedupeKey,
    }));
}
