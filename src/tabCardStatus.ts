// What a switcher card can say about state, beyond its picture: the agent
// bucket mark the strip already draws, and one line of why you'd go there.
// Display derivation only — the attention queue (src/attention.ts) stays the
// one mechanism that notifies; nothing here fires anything.

import type { SubTab } from "./components/ProjectView/helpers";
import { BUCKET_LABEL, type Bucket } from "../shared/agentLife";

export interface CardStatus {
  /** Colours the card's mark; null draws none. */
  bucket: Bucket | null;
  /** One short line; "" when the picture already says everything. */
  line: string;
}

const NONE: CardStatus = { bucket: null, line: "" };

/**
 * A card's status. `bucket` is the session's settled agentLife bucket where
 * the tab has one — resolved by the caller, which owns that map — and derived
 * visually for tabs whose state lives on the tab itself (a PR's CI, a chat's
 * unread).
 */
export function cardStatus(tab: SubTab, bucket?: Bucket): CardStatus {
  switch (tab.type) {
    case "terminal": {
      if (!bucket) return NONE;
      const line =
        bucket === "attention" && tab.unread && tab.notice
          ? tab.notice
          : BUCKET_LABEL[bucket];
      return { bucket, line };
    }
    case "agent":
      return bucket ? { bucket, line: BUCKET_LABEL[bucket] } : NONE;
    case "pr":
      return prStatus(tab.pr);
    case "chat":
      return tab.unread ? { bucket: "attention", line: "Unread" } : NONE;
    default:
      return NONE;
  }
}

interface PrFacts {
  state: string;
  draft: boolean;
  checks: string;
  review_decision: string;
  mergeable: string;
}

function prStatus(pr: PrFacts): CardStatus {
  const state = pr.state.toUpperCase();
  if (state === "MERGED") return { bucket: null, line: "Merged" };
  if (state === "CLOSED") return { bucket: null, line: "Closed" };

  const parts: string[] = [];
  if (pr.draft) parts.push("Draft");
  if (pr.checks === "FAIL") parts.push("CI failing");
  else if (pr.checks === "PENDING") parts.push("CI running");
  else if (pr.checks === "PASS") parts.push("CI passing");
  if (pr.review_decision === "CHANGES_REQUESTED") parts.push("changes requested");
  else if (pr.review_decision === "APPROVED") parts.push("approved");
  if (pr.mergeable === "CONFLICTING") parts.push("conflicts");

  const needsYou =
    pr.checks === "FAIL" ||
    pr.review_decision === "CHANGES_REQUESTED" ||
    pr.mergeable === "CONFLICTING";
  return {
    bucket: needsYou ? "attention" : pr.checks === "PENDING" ? "active" : null,
    line: parts.join(" · "),
  };
}
