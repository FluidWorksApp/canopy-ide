// "Done" is a state only independent evidence can set. Wherever an agent's turn
// or task reads as finished, this badge stands in for the agent's word: ✓
// Proven / ◐ Partial / ✗ Unproven / ⚠ Tests changed / … Verifying / —
// Unverified, from the workspace's own receipt (src/receipts/). Clicking it
// opens the receipt.
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "./Dialog";
import { ReceiptPanel } from "./ReceiptPanel";
import { STATUS_META } from "../receipts/status";
import { hydrateReceipt, previousReceipt, useReceipt } from "../receipts/store";
import { reverify, tellAgent, verifyNow } from "../receipts/engine";
import { receiptMarkdown, tellAgentMessage } from "../receipts/markdown";
import { getSettings, subscribeSettings, updateSettings } from "../settings";
import { ledgerRoot } from "../ledger";
import { buildReportCard, shareWith } from "../shareCards";
import * as ipc from "../ipc";
import "./receipts.css";

export interface ReceiptBadgeProps {
  sessionId?: string | null;
  ptyId?: number | null;
  /** The agent's working directory — for Verify now and loading a stored
   *  receipt after a restart. */
  cwd?: string | null;
  /** Agent registry id, recorded on a receipt this badge starts. */
  cli?: string;
  /** Hide the "— Unverified" state (rows where nothing finished yet). */
  quietWhenUnverified?: boolean;
  className?: string;
}

export function ReceiptBadge({
  sessionId,
  ptyId,
  cwd,
  cli = "",
  quietWhenUnverified = false,
  className = "",
}: ReceiptBadgeProps) {
  const mode = useSyncExternalStore(subscribeSettings, () => getSettings().receiptMode);
  const state = useReceipt(sessionId, ptyId);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (cwd && sessionId && mode !== "off") void hydrateReceipt(cwd, sessionId);
  }, [cwd, sessionId, mode]);
  if (mode === "off") return null;
  if (!state && quietWhenUnverified) return null;

  const record = state?.state === "done" ? state.record : sessionId ? previousReceipt(sessionId) : undefined;
  const meta =
    state?.state === "verifying"
      ? STATUS_META.verifying
      : state?.state === "done"
        ? STATUS_META[state.record.status]
        : STATUS_META.unverified;
  const title =
    state?.state === "error"
      ? state.message
      : state?.state === "done"
        ? `Workspace verification: ${meta.label}. ${state.record.reasons.join(" ")} Click for the receipt.`
        : state?.state === "verifying"
          ? "The workspace is re-running this project's checks."
          : "Not verified by the workspace yet. Click to verify.";

  const run = async () => {
    setNotice(null);
    if (record) return void reverify(record);
    const dir = cwd ?? "";
    if (!dir || !sessionId) return setNotice("This agent's folder is not known, so there is nothing to verify.");
    const root = await ledgerRoot(dir).catch(() => dir);
    void verifyNow({ sessionId, ptyId: ptyId ?? null, cli, cwd: dir, root });
  };
  const root = record?.root ?? "";
  const commands = root ? (getSettings().receiptCommands[root] ?? []) : [];

  // Badges sit inside clickable rows (jump to terminal); nothing in here —
  // the badge, the dialog, its buttons — may reach the row's handler. React
  // bubbles through the dialog's portal, hence the wrapper.
  return (
    <span className="rc-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`rc-badge ${meta.cls} ${className}`}
        title={title}
        aria-label={`Receipt: ${meta.label}`}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden>{meta.icon}</span> {meta.label}
      </button>
      {/* Portaled: the badge lives in table cells and cards whose overflow or
          transform would otherwise clip a fixed-position dialog. */}
      {open && createPortal(
        <Dialog
          title="Proof receipt"
          size="lg"
          onDismiss={() => setOpen(false)}
          dismissLabel="Close"
        >
          <div>
            <ReceiptPanel
              state={state}
              record={record}
              onReverify={() => void run()}
              onCopy={
                record
                  ? () =>
                      void ipc
                        .clipboardWriteText(receiptMarkdown(record))
                        .then(() => setNotice("Receipt copied as markdown."))
                        .catch(() => setNotice("Could not copy the receipt."))
                  : undefined
              }
              onShare={
                record
                  ? () =>
                      shareWith(async () => ({
                        kind: "share",
                        card: await buildReportCard("Canopy workspace", `Proof receipt: ${STATUS_META[record.status].label}`, receiptMarkdown(record), record.cwd),
                      }))
                  : undefined
              }
              onTellAgent={
                record?.ptyId != null
                  ? () =>
                      void tellAgent(record.ptyId!, tellAgentMessage(record))
                        .then(() => setNotice("Sent to the agent's terminal."))
                        .catch(() => setNotice("That agent's terminal is no longer open."))
                  : undefined
              }
              commands={commands}
              onSaveCommands={
                root
                  ? (lines) => {
                      const next = { ...getSettings().receiptCommands };
                      if (lines.length) next[root] = lines;
                      else delete next[root];
                      updateSettings({ receiptCommands: next });
                      setNotice(lines.length ? "Saved. Re-verify to run them." : "Cleared — Canopy will detect checks again.");
                    }
                  : undefined
              }
            />
            {notice && (
              <div className="rc-note" role="status">
                {notice}
              </div>
            )}
          </div>
        </Dialog>,
        document.body,
      )}
    </span>
  );
}
