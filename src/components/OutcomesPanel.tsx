// Outcomes: is agent work paying off here? Spend, what merged, what was
// proven, what was reverted or redone, and how long review took — by task
// class, CLI, person and week, with the brain's weekly read of the numbers on
// top.
//
// Local-first: everything is computed on this computer from the ledger, the
// checkout's git history and the provenance store (outcomes/reconcile.ts).
// Nothing is sent anywhere; the brain sees only the aggregated numbers.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_CLIS } from "../projects";
import { basename } from "../paths";
import { getSettings, SETTINGS_CHANGE_EVENT } from "../settings";
import { brainSpendByFeature, subscribeBrainMeter } from "../brainMeter";
import { reconcileOutcomes, groupReport, type OutcomesReport } from "../outcomes/reconcile";
import { realReconcileDeps } from "../outcomes";
import { attributeSpend } from "../outcomes/attribution";
import { loadInsight, type InsightOutcome } from "../outcomes/insight";
import { fmtUsd } from "../outcomes/budgets";
import { type GroupBy, type MetricRow } from "../outcomes/metrics";
import { UNPLANNED } from "../outcomes/types";
import { Button, Segmented, Select } from "./ui";
import "./OutcomesPanel.css";

const DAY = 24 * 60 * 60 * 1000;
type Days = "7" | "30" | "90";

const cliName = (id: string) => AGENT_CLIS.find((c) => c.id === id)?.name ?? id;
const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const hours = (h: number | null) =>
  h == null ? "—" : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)}h` : `${(h / 24).toFixed(1)}d`;

/** What a brain failure means, in one line. Never a spinner, never a crash. */
const FAILURE_LINE: Record<string, string> = {
  "no-brain": "No brain connected — connect one to get a weekly insight.",
  "signed-out": "The brain is signed out — sign in again to get a weekly insight.",
  "rate-limited": "The brain's plan is rate-limited right now; the insight will come later.",
  "over-budget": "The outcomes feature has used today's brain budget.",
  timeout: "The brain took too long to answer. Try Refresh later.",
  "invalid-output": "The brain's answer was not usable. Try Refresh.",
  failed: "The brain could not answer. Try Refresh later.",
};

function groupLabel(key: string, by: GroupBy): string {
  if (by === "cli") return cliName(key);
  if (by === "class" && key === UNPLANNED) return "No plan";
  if (by === "week") return `Week of ${key}`;
  return key;
}

export interface OutcomesPanelProps {
  /** Repositories in this project (component checkouts). */
  repos: string[];
  visible?: boolean;
  /** Test seams. */
  reconcile?: (root: string, sinceMs: number) => Promise<OutcomesReport>;
  insight?: typeof loadInsight;
}

export function OutcomesPanel({
  repos,
  visible = true,
  reconcile = (root, since) => reconcileOutcomes(realReconcileDeps, root, since),
  insight = loadInsight,
}: OutcomesPanelProps) {
  const [repo, setRepo] = useState(repos[0] ?? "");
  useEffect(() => {
    if (!repos.includes(repo)) setRepo(repos[0] ?? "");
  }, [repos, repo]);
  const [days, setDays] = useState<Days>("30");
  const [by, setBy] = useState<GroupBy>("class");
  const [report, setReport] = useState<OutcomesReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [brainTick, setBrainTick] = useState(0);
  const [insightOn, setInsightOn] = useState(() => getSettings().outcomesInsight);
  const [ins, setIns] = useState<InsightOutcome | { state: "loading" } | null>(null);
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  useEffect(() => subscribeBrainMeter(() => setBrainTick((n) => n + 1)), []);
  useEffect(() => {
    const sync = () => setInsightOn(getSettings().outcomesInsight);
    window.addEventListener(SETTINGS_CHANGE_EVENT, sync);
    return () => window.removeEventListener(SETTINGS_CHANGE_EVENT, sync);
  }, []);

  const refreshNumbers = useCallback(() => {
    if (!repo) return () => {};
    let live = true;
    setLoadError(null);
    reconcileRef
      .current(repo, Date.now() - Number(days) * DAY)
      .then((r) => live && setReport(r))
      .catch((e) => live && setLoadError(String(e)));
    return () => {
      live = false;
    };
  }, [repo, days]);

  useEffect(() => {
    if (!visible) return;
    return refreshNumbers();
  }, [visible, refreshNumbers]);

  const grouped = useMemo(() => (report ? groupReport(report, by) : null), [report, by]);
  // Canopy's own spend over the same window as the report. `brainTick` is the
  // meter's change signal: the meter is read synchronously from storage.
  const reportSince = report?.sinceMs;
  const brainByFeature = useMemo(
    () => brainSpendByFeature(reportSince ?? Date.now() - Number(days) * DAY),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reportSince, days, brainTick],
  );
  const attribution = useMemo(
    () =>
      report
        ? attributeSpend(report.spends, {
            sinceMs: report.sinceMs,
            cliName,
            brainByFeature,
            planTitles: report.planTitles,
          })
        : null,
    [report, brainByFeature],
  );

  const insightInput = useMemo(() => {
    if (!report) return null;
    return {
      days: Number(days),
      total: groupReport(report, "class").total,
      byClass: groupReport(report, "class").rows,
      byCli: groupReport(report, "cli").rows,
      byWeek: groupReport(report, "week").rows,
      brainByFeature,
    };
    // brainByFeature moves on every brain call (including this one); the
    // insight is about agent work, so only a new report re-asks.
  }, [report]); // eslint-disable-line react-hooks/exhaustive-deps

  const askInsight = useCallback(
    (force: boolean) => {
      if (!insightInput || !repo) return () => {};
      let live = true;
      const ctl = new AbortController();
      setIns({ state: "loading" });
      void insight(repo, insightInput, { force, signal: ctl.signal }).then((r) => live && setIns(r));
      return () => {
        live = false;
        ctl.abort();
      };
    },
    [insight, insightInput, repo],
  );

  useEffect(() => {
    if (!visible || !insightOn || !insightInput) return;
    return askInsight(false);
  }, [visible, insightOn, insightInput, askInsight]);

  if (repos.length === 0) {
    return (
      <div className="side-panel outcomes-panel">
        <div className="side-panel-head">Outcomes</div>
        <p className="tree-empty">Add a git repository to this project to see how agent work pays off.</p>
      </div>
    );
  }

  const total = grouped?.total ?? null;
  const maxCost = Math.max(0.01, ...(grouped?.rows.map((r) => r.costUsd) ?? [0]));
  const weeks = report ? groupReport(report, "week").rows.slice(-8) : [];
  const maxWeek = Math.max(0.01, ...weeks.map((w) => w.costUsd));

  return (
    <div className="side-panel outcomes-panel">
      <div className="side-panel-head">
        <span>Outcomes</span>
        <Button size="sm" variant="ghost" onClick={() => refreshNumbers()} title="Recount from the ledger and git history">
          Recount
        </Button>
      </div>
      <div className="outcomes-controls">
        {repos.length > 1 && (
          <Select size="sm" width="full" aria-label="Repository" value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r} value={r}>
                {basename(r)}
              </option>
            ))}
          </Select>
        )}
        <Segmented<Days>
          aria-label="Period"
          value={days}
          onChange={setDays}
          options={[
            { id: "7", label: "7 days" },
            { id: "30", label: "30 days" },
            { id: "90", label: "90 days" },
          ]}
        />
      </div>

      <InsightCard
        on={insightOn}
        state={ins}
        hasNumbers={!!report}
        onRefresh={() => askInsight(true)}
      />

      {loadError && <p className="stats-note outcomes-error">Couldn't count outcomes: {loadError}</p>}
      {!report && !loadError && <p className="stats-note">Counting from the ledger and git history…</p>}

      {report && total && (
        <>
          <div className="stats-overview outcomes-tiles">
            <Tile label="Agent spend" value={fmtUsd(total.costUsd)} hint={`${total.sessions} agent sessions in the last ${days} days`} />
            <Tile
              label="Cost per merged change"
              value={total.costPerMerged == null ? "—" : fmtUsd(total.costPerMerged)}
              hint={`${total.merged} merged pull requests came from agent sessions. Cost of those sessions divided by the PRs they produced.`}
            />
            <Tile
              label="Receipts proven"
              value={pct(total.passRate)}
              hint={`${total.receipts.proven} proven, ${total.receipts.partial} partial, ${total.receipts.unproven} unproven, ${total.receipts.contradicted} contradicted`}
            />
            <Tile label="Reverted" value={pct(total.revertRate)} hint={`${total.reverted} sessions had files changed by a later git revert`} />
            <Tile label="Reworked in a week" value={pct(total.reworkRate)} hint={`${total.reworked} sessions had files edited again by another session within 7 days`} />
            <Tile label="Time in review" value={hours(total.medianReviewHours)} hint="Median time from a pull request being opened to its merge, for PRs agents raised" />
          </div>
          {report.gitUnavailable && (
            <p className="stats-note">Git history could not be read, so merges and reverts are unknown here, not zero.</p>
          )}

          <div className="stats-section-head outcomes-group-head">
            <span>Breakdown</span>
            <Segmented<GroupBy>
              aria-label="Group by"
              value={by}
              onChange={setBy}
              options={[
                { id: "class", label: "Task" },
                { id: "cli", label: "CLI" },
                { id: "person", label: "Person" },
                { id: "week", label: "Week" },
              ]}
            />
          </div>
          {grouped && grouped.rows.length > 0 ? (
            <table className="stats-table outcomes-table">
              <colgroup>
                <col />
                <col style={{ width: "34%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "14%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">{by === "class" ? "Task class" : by === "cli" ? "CLI" : by === "person" ? "Person" : "Week"}</th>
                  <th scope="col">Spend</th>
                  <th scope="col" className="stats-num" title="Merged pull requests">Merged</th>
                  <th scope="col" className="stats-num" title="Receipts proven">Proven</th>
                  <th scope="col" className="stats-num" title="Sessions reworked within a week">Rework</th>
                </tr>
              </thead>
              <tbody>
                {grouped.rows.map((r) => (
                  <GroupRow key={r.key} r={r} label={groupLabel(r.key, by)} maxCost={maxCost} />
                ))}
              </tbody>
            </table>
          ) : (
            <p className="stats-note">
              No agent sessions recorded in this period yet. Spend is recorded at the end of each agent turn.
            </p>
          )}

          {weeks.length > 1 && (
            <>
              <div className="stats-section-head">Spend by week</div>
              <div className="outcomes-weeks" role="list" aria-label="Agent spend by week">
                {weeks.map((w) => (
                  <div
                    key={w.key}
                    role="listitem"
                    className="outcomes-week"
                    title={`Week of ${w.key}: ${fmtUsd(w.costUsd)}, ${w.sessions} sessions, ${w.merged} merged`}
                    aria-label={`Week of ${w.key}: ${fmtUsd(w.costUsd)}`}
                  >
                    <div className="outcomes-week-bar" style={{ height: `${Math.max(2, (w.costUsd / maxWeek) * 100)}%` }} />
                    <span className="outcomes-week-lbl">{w.key.slice(5)}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {attribution && (
            <>
              <div className="stats-section-head">Where the money went</div>
              <ul className="outcomes-attr" aria-label="Spend by plan">
                {attribution.byPlan.slice(0, 6).map((p) => (
                  <li key={p.key}>
                    <span className="outcomes-attr-name">{p.label}</span>
                    <span className="stats-num">
                      {p.estimated ? "~" : ""}
                      {fmtUsd(p.costUsd)}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="stats-section-head" title="What Canopy's own background intelligence spent on your brain's plan, per feature">
                Canopy's brain, by feature
              </div>
              {attribution.canopy.length === 0 ? (
                <p className="stats-note">Canopy's brain has not been used in this period.</p>
              ) : (
                <ul className="outcomes-attr" aria-label="Canopy brain spend by feature">
                  {attribution.canopy.slice(0, 8).map((c) => (
                    <li key={c.feature}>
                      <span className="outcomes-attr-name">{c.feature}</span>
                      <span className="stats-dim">{c.calls} calls</span>
                      <span className="stats-num">{fmtUsd(c.costUsd)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <p className="stats-note outcomes-privacy">
            Counted on this computer from the project ledger and git history. Nothing is sent to Canopy.
          </p>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="stats-metric" title={hint}>
      <span className="stats-metric-val">{value}</span>
      <span className="stats-metric-lbl">{label}</span>
    </div>
  );
}

function GroupRow({ r, label, maxCost }: { r: MetricRow; label: string; maxCost: number }) {
  const tip = [
    `${r.sessions} sessions, ${fmtUsd(r.costUsd)}`,
    `${r.merged} merged${r.costPerMerged != null ? ` (${fmtUsd(r.costPerMerged)} each)` : ""}`,
    `receipts: ${r.receipts.proven} proven of ${r.receipts.total}`,
    `${r.reverted} reverted, ${r.reworked} reworked`,
    `median review ${hours(r.medianReviewHours)}`,
  ].join("\n");
  return (
    <tr title={tip}>
      <th scope="row" className="outcomes-row-name">{label}</th>
      <td>
        <span className="outcomes-bar-cell">
          <span className="outcomes-bar" style={{ width: `${Math.max(2, (r.costUsd / maxCost) * 100)}%` }} />
          <span className="outcomes-bar-val">{fmtUsd(r.costUsd)}</span>
        </span>
      </td>
      <td className="stats-num">{r.merged}</td>
      <td className="stats-num">{pct(r.passRate)}</td>
      <td className="stats-num">{pct(r.reworkRate)}</td>
    </tr>
  );
}

function InsightCard({
  on,
  state,
  hasNumbers,
  onRefresh,
}: {
  on: boolean;
  state: InsightOutcome | { state: "loading" } | null;
  hasNumbers: boolean;
  onRefresh: () => void;
}) {
  if (!on) {
    return (
      <p className="stats-note outcomes-insight-off">
        The brain's weekly insight is off. Turn it on in Settings → Agents → Spend &amp; outcomes.
      </p>
    );
  }
  const shown =
    state && (state.state === "fresh" || state.state === "cached")
      ? { insight: state.insight, at: state.at }
      : state && (state.state === "failed" || state.state === "skipped") && state.cached
        ? { insight: state.cached.insight, at: state.cached.at }
        : null;
  let line: string | null = null;
  if (!hasNumbers || state?.state === "loading") line = "The brain is reading the numbers…";
  else if (state?.state === "skipped") line = "Not enough agent work recorded yet for an insight.";
  else if (state?.state === "failed") line = FAILURE_LINE[state.reason] ?? FAILURE_LINE.failed;

  return (
    <section className="outcomes-insight" aria-label="Brain insight" aria-live="polite">
      {shown && (
        <>
          <h3 className="outcomes-headline">{shown.insight.headline}</h3>
          <InsightList title="Working" items={shown.insight.wins} tone="ok" />
          <InsightList title="Watch" items={shown.insight.concerns} tone="warn" />
          <InsightList title="Try" items={shown.insight.suggestions} tone="info" />
        </>
      )}
      {line && <p className="outcomes-insight-state">{line}</p>}
      <div className="outcomes-insight-foot">
        <span>
          {shown
            ? `Written by your brain from these numbers · ${new Date(shown.at).toLocaleDateString()}`
            : "Written by your brain from these numbers, at most once a day"}
        </span>
        <Button size="sm" variant="ghost" onClick={onRefresh} disabled={!hasNumbers || state?.state === "loading"}>
          Refresh
        </Button>
      </div>
    </section>
  );
}

function InsightList({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  if (items.length === 0) return null;
  return (
    <div className={`outcomes-insight-list is-${tone}`}>
      <h4>{title}</h4>
      <ul>
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}
