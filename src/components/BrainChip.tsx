// The global brain chip: which CLI is the brain, whether it is answering, and
// what Canopy's own features have spent on it today.
//
// Sits beside the plan-usage chip because the two answer halves of one
// question: that chip says how much of the plan is left, this one says how much
// of it Canopy itself used and on what. Clicking while disconnected opens the
// connect flow — the one thing to do in that state — otherwise the popover with
// spend by feature, budgets, the last error and "Check again".

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useEscape } from "../useEscape";
import { placeAboveAnchor, type PopoverPlacement } from "../popoverPlacement";
import { Button } from "./ui";
import {
  brainSpendByFeature,
  startOfToday,
  subscribeBrainMeter,
  type BrainSpend,
} from "../brainMeter";
import { checkBrainConnection } from "../brainStatus";
import {
  brainNeedsConnect,
  brainStateText,
  featureLabel,
  parseBudget,
  openBrainConnect,
  useBrainConnection,
} from "../brainConnect";
import { getSettings, subscribeSettings, updateSettings } from "../settings";
import "./brainConnect.css";

const PANEL_WIDTH = 340;

const usd = (n: number): string => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

function useMeter(): Record<string, BrainSpend> {
  // Re-read per meter event, so the table re-renders only when a call lands.
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeBrainMeter(() => setTick((t) => t + 1)), []);
  return useMemo(() => {
    void tick;
    return brainSpendByFeature(startOfToday());
  }, [tick]);
}

/** One budget field, committed on blur or Enter. */
function BudgetInput({
  value,
  label,
  onCommit,
}: {
  value: number | null | undefined;
  label: string;
  onCommit: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : String(value)), [value]);
  const commit = () => {
    const v = parseBudget(draft);
    if (v !== undefined) onCommit(v);
    else setDraft(value == null ? "" : String(value));
  };
  return (
    <input
      className="ctl ctl-sm"
      inputMode="decimal"
      aria-label={label}
      placeholder="no cap"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

/**
 * Today's spend per feature with editable budgets. Shared by the chip's
 * popover and Settings → Agents → Brain so the two can never disagree.
 */
export function BrainSpendTable() {
  const spend = useMeter();
  const settings = useSyncExternalStore(subscribeSettings, getSettings, getSettings);
  const budgets = settings.brainFeatureBudgetsUsd;
  const features = [...new Set([...Object.keys(spend), ...Object.keys(budgets)])].sort(
    (a, b) => (spend[b]?.costUsd ?? 0) - (spend[a]?.costUsd ?? 0) || a.localeCompare(b),
  );
  const total = Object.values(spend).reduce(
    (t, s) => ({ calls: t.calls + s.calls, costUsd: t.costUsd + s.costUsd }),
    { calls: 0, costUsd: 0 },
  );
  const setFeatureBudget = (feature: string, v: number | null) => {
    const next = { ...getSettings().brainFeatureBudgetsUsd };
    if (v === null) delete next[feature];
    else next[feature] = v;
    updateSettings({ brainFeatureBudgetsUsd: next });
  };
  return (
    <table className="brain-spend">
      <thead>
        <tr>
          <th scope="col">Feature</th>
          <th scope="col">Calls</th>
          <th scope="col">Today</th>
          <th scope="col">Daily cap</th>
        </tr>
      </thead>
      <tbody>
        {features.length === 0 && (
          <tr>
            <td colSpan={4} className="brain-pop-empty">
              Nothing yet today.
            </td>
          </tr>
        )}
        {features.map((f) => (
          <tr key={f}>
            <td>{featureLabel(f)}</td>
            <td>{spend[f]?.calls ?? 0}</td>
            <td>{usd(spend[f]?.costUsd ?? 0)}</td>
            <td>
              {f === "connect-probe" ? (
                <span className="brain-pop-empty" title="Connection checks are never capped">
                  —
                </span>
              ) : (
                <BudgetInput
                  value={budgets[f]}
                  label={`${featureLabel(f)} daily cap in dollars`}
                  onCommit={(v) => setFeatureBudget(f, v)}
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>All features</td>
          <td>{total.calls}</td>
          <td>{usd(total.costUsd)}</td>
          <td>
            <BudgetInput
              value={settings.brainDailyBudgetUsd}
              label="Daily brain budget in dollars"
              onCommit={(v) => updateSettings({ brainDailyBudgetUsd: v })}
            />
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

export function BrainChip() {
  const conn = useBrainConnection();
  const text = brainStateText(conn);
  const needs = brainNeedsConnect(conn.state);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<PopoverPlacement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!anchorRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  useEscape(() => setOpen(false), open);
  // Fixed and measured, like the stats panel: the status bar clips its row.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      setPlace(
        placeAboveAnchor(
          r,
          { width: window.innerWidth, height: window.innerHeight },
          { width: PANEL_WIDTH, gap: 6, margin: 8 },
        ),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  const name = conn.label ?? "Brain";
  return (
    <span className="status-item status-brain-anchor" ref={anchorRef}>
      <button
        className={`status-brain-btn ${needs ? "is-cta" : ""}`}
        aria-haspopup={needs ? "dialog" : "true"}
        aria-expanded={needs ? undefined : open}
        title={`Brain: ${name} — ${text.short}`}
        aria-label={needs ? `Connect your brain (${text.short})` : `Brain: ${name}, ${text.short}`}
        onClick={() => {
          if (needs) openBrainConnect();
          else setOpen((v) => !v);
        }}
      >
        <span className={`brain-dot is-${text.tone}`} aria-hidden />
        <span>{needs ? "Connect your brain" : name}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="status-menu status-brain-menu"
            role="dialog"
            aria-label="Brain"
            style={
              place
                ? {
                    position: "fixed",
                    left: place.left,
                    bottom: place.bottom,
                    width: place.width,
                    maxHeight: place.maxHeight,
                  }
                : { visibility: "hidden" }
            }
          >
            <div className="brain-pop-head">
              <span className={`brain-dot is-${text.tone}`} aria-hidden />
              <strong>{name}</strong>
              <span>{text.short}</span>
            </div>
            <div className="brain-connect-detail">{text.detail}</div>
            {conn.message && conn.state !== "connected" && (
              <>
                <div className="brain-pop-section">Last error</div>
                <code className="brain-connect-error">{conn.message.slice(0, 400)}</code>
              </>
            )}
            <div className="brain-pop-section">Canopy's spend today</div>
            <BrainSpendTable />
            <div className="brain-pop-empty">
              Spend is what Canopy's own features used on your plan — not your agent tabs. A
              feature over its cap pauses until tomorrow.
            </div>
            <div className="brain-exception">
              <Button
                size="sm"
                disabled={conn.state === "checking"}
                onClick={() => void checkBrainConnection()}
              >
                Check again
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setOpen(false);
                  openBrainConnect();
                }}
              >
                Brain settings…
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
