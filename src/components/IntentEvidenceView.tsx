// Intent & evidence: the review surface's first view. It answers "was the
// right thing done, and is it proven?" before anyone reads a line:
//
//   1. The plan — goal and the decisions that were made.
//   2. What changed against it — the brain's deviation summary (plan + diff).
//   3. The proof receipt — from the ledger, when the receipts feature wrote one.
//   4. The risk map — files by risk; auth / data / migrations / money are
//      always "high, read the lines". A click drills into that file's diff.
//
// Plus the slice budget (too big to review at once → ask the agent to split
// it) and the autonomy ledger's track record for this kind of work.
//
// Used by the agent workspace (the agent's changes) and the PR tab. The host
// owns the diff below; this view only orders and points into it.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getSettings, subscribeSettings } from "../settings";
import { plansForSession, type PlanEntry } from "../plans/planStore";
import { subscribeLedger } from "../ledger";
import {
  riskOrder,
  sliceStatus,
  splitDiff,
  splitRequest,
  summarizeChange,
  cachedReview,
  reviewCacheKey,
  type ReviewSummary,
} from "../review/intentReview";
import { latestReceipt, receiptLine, trackRecord, type ReceiptView, type TrackRecord } from "../review/evidence";
import { statusLabel } from "../plans/plan";
import { AgentsIcon } from "./icons";
import { Button } from "./ui";
import "./plans.css";

export interface IntentEvidenceViewProps {
  /** Any directory of the repo: the ledger and the brain both key on it. */
  cwd: string;
  /** The agent sessions this change came from (newest first). */
  sessionIds: string[];
  /** The diff under review; null while it loads. */
  patch: string | null;
  /** Drill into one file's diff. */
  onOpenFile?: (path: string) => void;
  /** Hears the risk order, so the host can order its diff the same way. */
  onRiskOrder?: (paths: string[]) => void;
  /** Type text into the agent's terminal (the split request). Absent when no
   *  agent can be reached from this surface. */
  /** The agent is mid-turn and its diff is still moving: summaries wait for
   *  a click instead of firing on their own. */
  paused?: boolean;
  onAskAgent?: (
    text: string,
  ) => Promise<{ delivered: boolean; note: string }> | { delivered: boolean; note: string } | void;
}

type SummaryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; value: ReviewSummary; cached: boolean }
  | { kind: "error"; message: string };

const BRAIN_REASON: Record<string, string> = {
  "no-brain": "No brain is connected, so there is no summary. The plan, receipt and path-based risk still apply.",
  "signed-out": "The brain is signed out. Sign in to get the summary.",
  "rate-limited": "The brain is rate-limited right now. Try again in a bit.",
  "over-budget": "Review summaries are over today's brain budget.",
  timeout: "The summary took too long. Try again.",
  "invalid-output": "The brain's summary was unreadable. Try again.",
  failed: "The summary failed. Try again.",
};

const NO_RISK: ReviewSummary["risk"] = [];
/** How long a changed diff must sit still before it is summarised again. */
const SETTLE_MS = 10_000;

const VERDICT_LABEL: Record<string, string> = {
  proven: "Proven",
  partial: "Partly proven",
  unproven: "Not proven",
  contradicted: "Contradicted by the evidence",
};

export function IntentEvidenceView({ cwd, sessionIds, patch, paused = false, onOpenFile, onRiskOrder, onAskAgent }: IntentEvidenceViewProps) {
  const settings = useSyncExternalStore(subscribeSettings, getSettings, getSettings);
  const sessionsKey = sessionIds.join(",");

  // 1. The plan the run worked from. undefined = still looking.
  const [plan, setPlan] = useState<PlanEntry | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setPlan(undefined);
    void (async () => {
      for (const id of sessionIds) {
        const rows = await plansForSession(cwd, id).catch(() => []);
        if (rows[0]) return rows[0];
      }
      return null;
    })().then((p) => live && setPlan(p));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, sessionsKey]);

  // 3. The receipt for the run (the plan's session, else the newest one).
  const runSession = plan?.data.sessionId ?? sessionIds[0] ?? null;
  const [receipt, setReceipt] = useState<ReceiptView | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setReceipt(undefined);
    const read = () => void latestReceipt(cwd, runSession).then((r) => live && setReceipt(r));
    read();
    // The receipts feature writes after the run: show it the moment it lands.
    let off = () => {};
    try {
      off = subscribeLedger(cwd, (e) => {
        if (e.kind === "receipt") read();
      });
    } catch {
      // No ledger events here (a host without them): the first read stands.
    }
    return () => {
      live = false;
      off();
    };
  }, [cwd, runSession]);

  const files = useMemo(() => (patch ? splitDiff(patch) : []), [patch]);

  // 2. The brain's summary. Cached by plan + diff: the same pair is never
  //    asked twice, and a cached one shows at once.
  //
  //    The agent tab re-reads a working agent's edits every few seconds, so
  //    the diff — and the cache key — keeps moving while it works. Two rules
  //    keep that from becoming a stream of main-tier calls: the key must sit
  //    still for SETTLE_MS before a later diff is summarised (the first one
  //    goes at once), and a call already out is never aborted or doubled —
  //    when it lands, the newest settled key gets its turn. `paused` (the
  //    agent is mid-turn) turns automatic summaries into a button.
  const planData = plan?.data ?? null;
  const key = patch && plan !== undefined ? reviewCacheKey(planData, patch) : null;
  const inputs = useRef({ key, patch, planData, receipt });
  inputs.current = { key, patch, planData, receipt };
  const [stableKey, setStableKey] = useState<string | null>(null);
  useEffect(() => {
    if (!key || key === stableKey) return;
    if (stableKey === null || cachedReview(key)) {
      setStableKey(key);
      return;
    }
    const t = window.setTimeout(() => setStableKey(key), SETTLE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const stableRef = useRef(stableKey);
  stableRef.current = stableKey;

  const [summary, setSummary] = useState<SummaryState>({ kind: "idle" });
  const [asked, setAsked] = useState(0);
  const [recheck, setRecheck] = useState(0);
  const running = useRef<string | null>(null);
  const unmount = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    unmount.current = c;
    return () => c.abort();
  }, []);
  const auto = settings.reviewAutoSummary && !paused;
  useEffect(() => {
    if (!stableKey || receipt === undefined || !files.length) return;
    const hit = cachedReview(stableKey);
    if (hit) {
      setSummary({ kind: "ok", value: hit, cached: true });
      return;
    }
    if (!auto && asked === 0) {
      setSummary({ kind: "idle" });
      return;
    }
    if (running.current) return; // lands, then re-checks (below)
    const inp = inputs.current;
    if (inp.key !== stableKey || !inp.patch) return; // moved on; the next settle fires
    running.current = stableKey;
    setSummary({ kind: "loading" });
    void summarizeChange({
      cwd,
      plan: inp.planData,
      patch: inp.patch,
      receiptLine: receiptLine(inp.receipt ?? null),
      signal: unmount.current?.signal,
    }).then((a) => {
      const asFor = running.current;
      running.current = null;
      if (unmount.current?.signal.aborted) return;
      if (asFor !== stableRef.current) {
        setRecheck((n) => n + 1);
        return;
      }
      if (a.ok && a.value) setSummary({ kind: "ok", value: a.value, cached: !!a.cached });
      else setSummary({ kind: "error", message: a.ok ? BRAIN_REASON["invalid-output"] : (BRAIN_REASON[a.reason] ?? BRAIN_REASON.failed) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableKey, asked, auto, recheck, receipt === undefined]);

  // 4. Risk map, and the order the host's diff should follow.
  const brainRisk = summary.kind === "ok" ? summary.value.risk : NO_RISK;
  const rows = useMemo(() => riskOrder(files, brainRisk), [files, brainRisk]);
  const order = rows.map((r) => r.path).join("\n");
  useEffect(() => {
    if (onRiskOrder && order) onRiskOrder(order.split("\n"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order]);

  // Autonomy ledger: how this kind of work has held up here.
  const taskClass = planData?.taskClass;
  const [record, setRecord] = useState<TrackRecord | null>(null);
  useEffect(() => {
    let live = true;
    setRecord(null);
    if (!taskClass) return;
    void trackRecord(cwd, taskClass)
      .then((r) => live && setRecord(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [cwd, taskClass]);

  const slice = sliceStatus(files, settings.reviewSliceBudgetLines);
  const [splitNote, setSplitNote] = useState("");

  return (
    <div className="intent-view" aria-label="Intent and evidence">
      {/* 1. Intent */}
      <section className="intent-step">
        <h3>The plan</h3>
        {plan === undefined ? (
          <p className="intent-muted">Looking for the plan…</p>
        ) : !plan ? (
          <p className="intent-muted">No plan was recorded for this work. Judge it by the summary and the receipt.</p>
        ) : (
          <>
            <p className="intent-summary">
              {plan.data.goal} <span className="plan-chip">{statusLabel(plan.status ?? "")}</span>
            </p>
            {plan.data.decisions.length > 0 && (
              <ul className="intent-list" aria-label="Decisions">
                {plan.data.decisions.map((d, i) => (
                  <li key={i}>
                    {d.question} <strong>→ {d.answer || d.recommended || "undecided"}</strong>
                    {d.source === "mid-run" && <span className="plan-chip">asked while working</span>}
                  </li>
                ))}
              </ul>
            )}
            {plan.data.acceptance.length > 0 && (
              <AcceptanceList items={plan.data.acceptance} receipt={receipt ?? null} />
            )}
          </>
        )}
      </section>

      {/* 2. Deviations, by the brain */}
      <section className="intent-step is-agent-made">
        <h3>
          <AgentsIcon size={12} />
          What changed against the plan
          <span className="agent-byline-note">written by the brain</span>
        </h3>
        {!patch ? (
          <p className="intent-muted">Reading the changes…</p>
        ) : !files.length ? (
          <p className="intent-muted">No changes to review.</p>
        ) : summary.kind === "idle" ? (
          <Button size="sm" onClick={() => setAsked((n) => n + 1)}>
            Summarize against the plan
          </Button>
        ) : summary.kind === "loading" ? (
          <p className="intent-muted" role="status">
            Comparing the changes with the plan…
          </p>
        ) : summary.kind === "error" ? (
          <p className="intent-muted">
            {summary.message}{" "}
            <Button size="sm" variant="ghost" onClick={() => setAsked((n) => n + 1)}>
              Retry
            </Button>
          </p>
        ) : (
          <SummaryBody value={summary.value} />
        )}
      </section>

      {/* 3. Evidence */}
      <section className="intent-step">
        <h3>Proof receipt</h3>
        {receipt === undefined ? (
          <p className="intent-muted">Looking for a receipt…</p>
        ) : !receipt ? (
          <p className="intent-muted">No receipt yet.</p>
        ) : (
          <ReceiptBody r={receipt} />
        )}
      </section>

      {/* 4. Risk map */}
      {rows.length > 0 && (
        <section className="intent-step">
          <h3>Risk map · read in this order</h3>
          {slice.over && (
            <div className="intent-banner" role="note">
              <span>
                This is {slice.lines} changed lines — over the {slice.budget}-line budget for one reviewable slice.
              </span>
              {onAskAgent && (
                <Button
                  size="sm"
                  onClick={() => {
                    const suggestion = summary.kind === "ok" ? summary.value.sliceSuggestion : undefined;
                    void Promise.resolve(onAskAgent(splitRequest(slice, suggestion))).then((r) =>
                      setSplitNote(r ? (r.delivered ? "Sent to the agent." : r.note) : "Sent to the agent."),
                    );
                  }}
                >
                  Ask the agent to split this
                </Button>
              )}
              {splitNote && <small className="intent-muted">{splitNote}</small>}
            </div>
          )}
          <div className="intent-risk" role="list">
            {rows.map((r) => (
              <button
                key={r.path}
                type="button"
                role="listitem"
                className="intent-risk-row"
                onClick={() => onOpenFile?.(r.path)}
                title={onOpenFile ? "Open this file's changes" : undefined}
              >
                <span className={`intent-sev is-${r.level}`}>{r.forced ? "high · read lines" : r.level}</span>
                <span className="intent-risk-path">{r.path}</span>
                <span className="intent-risk-why">{r.why}</span>
                <span className="intent-risk-lines">{r.lines} lines</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {record && (
        <section className="intent-step">
          <h3>Track record</h3>
          <p className="intent-record">
            Track record for <strong>{record.taskClass}</strong> in this repo: {record.proven} proven,{" "}
            {record.reverted} reverted
            {record.contradicted ? `, ${record.contradicted} contradicted` : ""}
            {record.partial + record.unproven ? `, ${record.partial + record.unproven} not fully proven` : ""}.
            {record.eligible ? (
              <span className="intent-eligible"> Eligible for auto-merge (a recommendation; nothing merges on its own).</span>
            ) : null}
          </p>
        </section>
      )}
    </div>
  );
}

function SummaryBody({ value }: { value: ReviewSummary }) {
  return (
    <>
      <p className="intent-summary">{value.summary}</p>
      {value.deviations.length > 0 && (
        <ul className="intent-list" aria-label="Deviations from the plan">
          {value.deviations.map((d, i) => (
            <li key={i}>
              <span className={`intent-sev is-${d.severity}`}>{d.severity}</span>
              {d.what}
              {d.where && <span className="intent-muted"> · {d.where}</span>}
            </li>
          ))}
        </ul>
      )}
      {value.unplanned.length > 0 && (
        <p className="intent-muted">
          <strong>Not in the plan:</strong> {value.unplanned.join(", ")}
        </p>
      )}
      {value.missing.length > 0 && (
        <p className="intent-muted">
          <strong>Acceptance not met:</strong> {value.missing.join("; ")}
        </p>
      )}
    </>
  );
}

/** The plan's acceptance checks, each with what the receipt proved about it:
 *  the review starts from what was agreed counts as done. */
function AcceptanceList({ items, receipt }: { items: string[]; receipt: ReceiptView | null }) {
  const judged = receipt?.acceptance ?? [];
  const rows = items.map((item, i) => {
    const hit = judged.find((a) => a.item.trim() === item.trim()) ?? judged[i];
    return { item, met: hit ? hit.met : undefined, evidence: hit?.evidence ?? "" };
  });
  return (
    <ul className="intent-list" aria-label="What counts as done">
      {rows.map((r, i) => (
        <li key={i}>
          <span
            className={`intent-accept ${r.met === true ? "is-met" : r.met === false ? "is-unmet" : "is-unknown"}`}
            aria-label={r.met === true ? "Met" : r.met === false ? "Not met" : r.met === null ? "Not shown either way" : "Not checked yet"}
          >
            {r.met === true ? "✓" : r.met === false ? "✗" : "?"}
          </span>{" "}
          {r.item}
          {r.evidence && <span className="intent-muted"> — {r.evidence}</span>}
          {r.met === undefined && <span className="intent-muted"> — not checked by a receipt yet</span>}
        </li>
      ))}
    </ul>
  );
}

function ReceiptBody({ r }: { r: ReceiptView }) {
  const met = r.acceptance.filter((a) => a.met === true).length;
  return (
    <div className="intent-receipt">
      <span className={`intent-verdict is-${r.verdict ?? "unproven"}`}>
        {r.verdict ? VERDICT_LABEL[r.verdict] : "No verdict"}
        {r.tampered && <span className="intent-sev is-high"> tamper flags raised</span>}
      </span>
      {r.did && <span>{r.did}</span>}
      {r.acceptance.length > 0 && (
        <span className={met === r.acceptance.length ? "" : "intent-muted"}>
          {met} of {r.acceptance.length} acceptance {r.acceptance.length === 1 ? "check" : "checks"} met
        </span>
      )}
      {r.checks.length > 0 && (
        <ul className="intent-list" aria-label="Checks">
          {r.checks.map((c, i) => (
            <li key={i}>
              {c.ok === true ? "✓" : c.ok === false ? "✗" : "·"} {c.name}
              {c.detail && <span className="intent-muted"> ({c.detail})</span>}
            </li>
          ))}
        </ul>
      )}
      {r.evidence.length > 0 && (
        <ul className="intent-list" aria-label="Evidence">
          {r.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {r.gaps.length > 0 && (
        <p className="intent-muted">
          <strong>Gaps:</strong> {r.gaps.join("; ")}
        </p>
      )}
    </div>
  );
}
