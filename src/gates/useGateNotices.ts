// Which gate notices an agent's terminal shows, and the hook that keeps them
// current. Apart from GateNotices.tsx so that file exports only components.
import { useEffect, useState } from "react";
import { gateNotices, subscribeGateNotices, type GateNotice } from "./events";

/** Cards older than this stop being shown: the agent has long moved on. An
 *  outstanding approval is the exception — it waits until answered. A warning
 *  stopped nothing, so it never gets a card over the terminal: it repeated on
 *  every outbound command and covered the agent's output. It stays in the
 *  ledger the Rules panel counts. */
const SHOW_FOR_MS = 15 * 60 * 1000;
const MAX_SHOWN = 3;

export function useGateNotices(): readonly GateNotice[] {
  const [list, setList] = useState(gateNotices);
  useEffect(() => subscribeGateNotices(() => setList(gateNotices())), []);
  return list;
}

export function visibleNotices(
  list: readonly GateNotice[],
  ptyId: number | null | undefined,
  now = Date.now(),
): GateNotice[] {
  return list
    .filter((n) => n.ptyId != null && n.ptyId === ptyId)
    .filter((n) => !n.resolved && n.stamp.status !== "allowed-once" && n.stamp.status !== "warned")
    .filter((n) => n.stamp.status === "needs-approval" || now - n.ts < SHOW_FOR_MS)
    .slice(0, MAX_SHOWN);
}
