import { useEffect, useId, useMemo, useRef, type RefObject } from "react";
import { FLEET_REASON_LABELS, type FleetKind } from "../fleetState";
import type { FleetRouteSnapshot } from "../fleetSnapshot";
import { AgentIcon, ChevronIcon } from "./icons";

interface FleetProfileLabel {
  id: string;
  label: string;
}

export interface FleetReadinessPanelProps {
  rows: readonly FleetRouteSnapshot[];
  profiles: readonly FleetProfileLabel[];
  loading: boolean;
  error: string | null;
  open: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
}

const SEVERITY: Record<FleetKind, number> = {
  ready: 0,
  degraded: 1,
  unusable: 2,
};

interface FleetReadinessSummary {
  kind: FleetKind | null;
  label: string;
  ready: number;
  total: number;
}

/** The folded row must never make the fleet look healthier than any route in
 *  it. The right-hand state is therefore the worst live state, while the copy
 *  says exactly how many routes are ready. */
function summarizeFleetReadiness(
  rows: readonly FleetRouteSnapshot[],
  loading: boolean,
  error: string | null,
): FleetReadinessSummary {
  const total = rows.length;
  const ready = rows.filter((row) => row.state.kind === "ready").length;
  if (error && total === 0) {
    return { kind: null, label: "Fleet check unavailable", ready, total };
  }
  if (loading && total === 0) {
    return { kind: null, label: "Checking fleet…", ready, total };
  }
  if (total === 0) {
    return { kind: null, label: "No agent routes found", ready, total };
  }

  const kind = rows.reduce<FleetKind>(
    (worst, row) =>
      SEVERITY[row.state.kind] > SEVERITY[worst] ? row.state.kind : worst,
    "ready",
  );
  return {
    kind,
    label: ready === total ? `${total} routes ready` : `${ready} of ${total} routes ready`,
    ready,
    total,
  };
}

/** A disclosure, not a table: Settings needs the fleet verdict at a glance;
 *  route-by-route evidence is available without permanently spending the
 *  height of the page. */
export function FleetReadinessPanel({
  rows,
  profiles,
  loading,
  error,
  open,
  trigger,
  onOpenChange,
}: FleetReadinessPanelProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const profileLabels = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.label])),
    [profiles],
  );
  const summary = summarizeFleetReadiness(rows, loading, error);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) onOpenChange(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [onOpenChange, open]);

  return (
    <div className="fleet-disclosure" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className={`fleet-disclosure-trigger${open ? " open" : ""}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
      >
        <span className="fleet-disclosure-copy" aria-live="polite">
          <strong>{summary.label}</strong>
          <span>{open ? "Hide route details" : "Show every state and reason"}</span>
        </span>
        <span className="fleet-disclosure-status">
          <span
            className={`fleet-state${summary.kind ? ` fleet-state-${summary.kind}` : ""}`}
          >
            {summary.kind ?? (loading ? "checking" : error ? "unavailable" : "empty")}
          </span>
          <ChevronIcon size={16} className="fleet-disclosure-chevron" />
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          className="fleet-disclosure-panel"
          role="region"
          aria-label="Fleet route states and reasons"
        >
          {error && (
            <div className="fleet-readout-error" role="alert">
              Fleet check unavailable: {error}
            </div>
          )}
          {rows.length > 0 && (
            <div className="fleet-route-list" role="list">
              {rows.map((row) => (
                <div
                  className="fleet-route-row"
                  role="listitem"
                  key={`${row.cli.id}:${row.profile}`}
                >
                  <span className="fleet-route-identity">
                    <span className="fleet-route-name">
                      <AgentIcon id={row.cli.id} size={14} />
                      {row.cli.name}
                    </span>
                    <span className="fleet-route-profile">
                      {profileLabels.get(row.profile) ?? row.profile}
                    </span>
                  </span>
                  <span className={`fleet-state fleet-state-${row.state.kind}`}>
                    {row.state.kind}
                  </span>
                  <span className="fleet-reasons">
                    {row.state.reasons.length
                      ? row.state.reasons
                          .map((reason) => FLEET_REASON_LABELS[reason])
                          .join(" · ")
                      : "all checks ready"}
                  </span>
                </div>
              ))}
            </div>
          )}
          {loading && <div className="fleet-readout-loading">Checking fleet…</div>}
          {!loading && !error && rows.length === 0 && (
            <div className="fleet-readout-empty">No agent routes found.</div>
          )}
        </div>
      )}
    </div>
  );
}
