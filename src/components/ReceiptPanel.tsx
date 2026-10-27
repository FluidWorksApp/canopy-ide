// The receipt, opened: what was asked against what the evidence shows was
// done, and the evidence itself — every command the workspace ran, its exit
// code and counts, the raw output one click away. Receipts must show raw
// evidence, not just verdicts: a verdict without its output is one more claim.
//
// "Agent says" (the agent's own closing words) and "Workspace verified" are
// separate sections on purpose: the first is the claim, the second the proof.
import { useState } from "react";
import { Button } from "./ui";
import { STATUS_META } from "../receipts/status";
import { checkLine } from "../receipts/markdown";
import type { CheckResult, ReceiptRecord } from "../receipts/types";
import type { ReceiptState } from "../receipts/store";
import "./receipts.css";

const OUTCOME_ICON: Record<CheckResult["outcome"], { icon: string; cls: string; label: string }> = {
  passed: { icon: "✓", cls: "rc-proven", label: "passed" },
  failed: { icon: "✗", cls: "rc-unproven", label: "failed" },
  "no-tests": { icon: "0", cls: "rc-partial", label: "ran zero tests" },
  "timed-out": { icon: "⏱", cls: "rc-partial", label: "timed out" },
  "not-run": { icon: "—", cls: "rc-unverified", label: "could not start" },
};

export interface ReceiptPanelProps {
  state: ReceiptState | null;
  /** Last finished record, shown greyed while a re-verify runs. */
  record?: ReceiptRecord;
  onReverify(): void;
  onCopy?(): void;
  onShare?(): void;
  /** Offered when the receipt is not proven and the agent's terminal is known. */
  onTellAgent?(): void;
  /** The project's own check commands, when the person has set them. */
  commands?: string[];
  onSaveCommands?(lines: string[]): void;
}

function CheckRow({ c }: { c: CheckResult }) {
  const o = OUTCOME_ICON[c.outcome];
  return (
    <li className="rc-check">
      <details>
        <summary>
          <span className={`rc-check-mark ${o.cls}`} aria-label={o.label}>
            {o.icon}
          </span>
          <span className="rc-check-line">{checkLine(c)}</span>
        </summary>
        {c.note && <div className="rc-note">{c.note}</div>}
        {c.failures.length > 0 && (
          <div className="rc-note">Failing: {c.failures.join(", ")}</div>
        )}
        <pre className="rc-output" aria-label={`Raw output of ${c.command}`}>
          {c.outputTail || "(no output)"}
        </pre>
      </details>
    </li>
  );
}

function CommandsEditor({
  commands,
  onSave,
}: {
  commands: string[];
  onSave(lines: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(commands.join("\n"));
  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {commands.length ? "Edit check commands…" : "Set check commands…"}
      </Button>
    );
  return (
    <div className="rc-commands">
      <label className="rc-label" htmlFor="rc-commands-input">
        Check commands for this project — one per line. Leave empty to let Canopy detect them.
      </label>
      <textarea
        id="rc-commands-input"
        className="oneoff-input"
        rows={3}
        value={text}
        placeholder={"npm test\ncargo test"}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="rc-actions">
        <Button size="sm" variant="accent" onClick={() => { onSave(text.split("\n").map((l) => l.trim()).filter(Boolean)); setOpen(false); }}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ReceiptPanel({
  state,
  record: fallback,
  onReverify,
  onCopy,
  onShare,
  onTellAgent,
  commands = [],
  onSaveCommands,
}: ReceiptPanelProps) {
  const record = state?.state === "done" ? state.record : (state?.state === "error" ? state.record : undefined) ?? fallback;
  const verifying = state?.state === "verifying";
  const meta = verifying ? STATUS_META.verifying : record ? STATUS_META[record.status] : STATUS_META.unverified;
  const review = record?.tamper.filter((t) => t.severity === "review") ?? [];
  const notes = record?.tamper.filter((t) => t.severity === "note") ?? [];
  return (
    <div className={`rc-panel ${verifying ? "rc-stale" : ""}`}>
      <div className={`rc-headline ${meta.cls}`} role="status">
        <span className="rc-icon" aria-hidden>
          {meta.icon}
        </span>
        <span>{meta.label}</span>
        {verifying && <span className="rc-sub">re-running the checks…</span>}
        {record && !verifying && (
          <span className="rc-sub">
            {new Date(record.ts).toLocaleTimeString()} · {record.base}
            {record.costUsd != null ? ` · brain $${record.costUsd.toFixed(3)}` : ""}
          </span>
        )}
      </div>
      {state?.state === "error" && <div className="rc-note">{state.message}</div>}
      {!record && !verifying && state?.state !== "error" && (
        <p className="rc-empty">
          Nothing has been verified for this agent yet. Verify re-runs the project's checks
          outside the agent's terminal and compares the result with what was asked.
        </p>
      )}
      {record && (
        <>
          <section className="rc-section">
            <h4>Asked</h4>
            <p>{record.verdict?.asked || record.asked || "(the request was not captured)"}</p>
            <h4>Did</h4>
            <p>{record.verdict?.did ?? <span className="rc-dim">{record.brainNote ?? "Not judged."}</span>}</p>
          </section>
          {record.claim && (
            <section className="rc-section rc-claim">
              <h4>Agent says</h4>
              <p>{record.claim.length > 600 ? `${record.claim.slice(0, 600)}…` : record.claim}</p>
            </section>
          )}
          <section className="rc-section">
            <h4>Workspace verified</h4>
            <ul className="rc-reasons">
              {record.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {record.checks.length > 0 && (
              <ul className="rc-checks">
                {record.checks.map((c) => (
                  <CheckRow key={c.id} c={c} />
                ))}
              </ul>
            )}
          </section>
          {review.length > 0 && (
            <section className="rc-section rc-tamper-box">
              <h4>⚠ Test changed by the agent — needs a human look</h4>
              <ul>
                {review.map((t) => (
                  <li key={t.path}>
                    <code>{t.path}</code> — {t.detail}
                    {t.lines.length > 0 && <pre className="rc-output">{t.lines.join("\n")}</pre>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {notes.length > 0 && (
            <section className="rc-section">
              <h4>Tests touched</h4>
              <ul>
                {notes.map((t) => (
                  <li key={t.path}>
                    <code>{t.path}</code> — {t.detail}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {record.packages.length > 0 && (
            <section className="rc-section">
              <h4>New packages</h4>
              <ul>
                {record.packages.map((p) => (
                  <li key={`${p.ecosystem}:${p.name}`} className={p.status === "unknown" ? "rc-unproven" : ""}>
                    <code>{p.name}</code> ({p.ecosystem}) —{" "}
                    {p.status === "exists" ? "exists on the registry" : p.status === "unknown" ? "unknown package: not on the registry" : "could not be checked"}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {record.verdict && (record.verdict.evidence.length > 0 || record.verdict.gaps.length > 0) && (
            <section className="rc-section">
              {record.verdict.evidence.length > 0 && (
                <>
                  <h4>Evidence the brain cited</h4>
                  <ul>
                    {record.verdict.evidence.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </>
              )}
              {record.verdict.gaps.length > 0 && (
                <>
                  <h4>Gaps</h4>
                  <ul>
                    {record.verdict.gaps.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </>
      )}
      <div className="rc-actions">
        <Button size="sm" variant="accent" disabled={verifying} onClick={onReverify}>
          {record ? "Re-verify" : "Verify now"}
        </Button>
        {record && onCopy && (
          <Button size="sm" onClick={onCopy}>
            Copy receipt
          </Button>
        )}
        {record && onShare && (
          <Button size="sm" onClick={onShare}>
            Share…
          </Button>
        )}
        {record && onTellAgent && ["unproven", "contradicted", "tests-changed"].includes(record.status) && (
          <Button size="sm" onClick={onTellAgent} title="Types a short factual summary into the agent's terminal">
            Tell the agent
          </Button>
        )}
        {onSaveCommands && <CommandsEditor commands={commands} onSave={onSaveCommands} />}
      </div>
    </div>
  );
}
