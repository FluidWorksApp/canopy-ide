// Usage & cost across every session Canopy knows, all CLIs. The status tray
// (StatusBar) shows the one live session's tokens/cost; this rolls the same
// per-session numbers up into overall totals and per-CLI / per-model
// breakdowns. Data comes from ipc.agentUsage(); cost is an estimate except
// where the CLI reports its own (omp).
import { useEffect, useMemo, useState } from "react";
import * as ipc from "../ipc";
import { sessionCost } from "../pricing";
import { AGENT_CLIS } from "../projects";
import { AgentIcon } from "./icons";

const fmtTokens = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : `${n}`;

const fmtCost = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

const agentName = (id: string) => AGENT_CLIS.find((c) => c.id === id)?.name ?? id;

/** Tokens Canopy sent to the model (fresh input + both cache legs) vs received
 *  back (output). Matches the ↑/↓ split in the status tray. */
const sent = (u: ipc.AgentSessionUsage) =>
  u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens;
const received = (u: ipc.AgentSessionUsage) => u.output_tokens;

interface Group {
  key: string;
  sessions: number;
  sent: number;
  received: number;
  cost: number;
  /** True when at least one member's cost was estimated, not CLI-reported. */
  estimated: boolean;
  /** True when at least one member had a real cost we could show. */
  priced: boolean;
}

function groupBy(
  rows: ipc.AgentSessionUsage[],
  keyOf: (u: ipc.AgentSessionUsage) => string,
): Group[] {
  const map = new Map<string, Group>();
  for (const u of rows) {
    const key = keyOf(u);
    let g = map.get(key);
    if (!g) {
      g = { key, sessions: 0, sent: 0, received: 0, cost: 0, estimated: false, priced: false };
      map.set(key, g);
    }
    g.sessions += 1;
    g.sent += sent(u);
    g.received += received(u);
    const c = sessionCost(u);
    if (c != null) {
      g.cost += c;
      g.priced = true;
      if (u.cost == null) g.estimated = true;
    }
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost || b.sent - a.sent);
}

/** `$1.30` or `~$1.30` when any part of the figure is estimated. `—` when
 *  nothing in the group could be priced. */
function CostCell({ g }: { g: Pick<Group, "cost" | "estimated" | "priced"> }) {
  if (!g.priced) return <span className="stats-dim">—</span>;
  return (
    <span className="stats-cost">
      {g.estimated ? "~" : ""}
      {fmtCost(g.cost)}
    </span>
  );
}

export function StatsPanel({ visible }: { visible: boolean }) {
  const [usage, setUsage] = useState<ipc.AgentSessionUsage[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const refresh = () =>
      void ipc
        .agentUsage()
        .then((u) => {
          if (cancelled) return;
          setUsage(u);
          setLoaded(true);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible]);

  const supported = useMemo(() => usage.filter((u) => u.supported), [usage]);
  const unsupported = useMemo(
    () => [...new Set(usage.filter((u) => !u.supported).map((u) => u.agent))],
    [usage],
  );

  const total = useMemo(() => {
    const g: Group = {
      key: "all",
      sessions: supported.length,
      sent: 0,
      received: 0,
      cost: 0,
      estimated: false,
      priced: false,
    };
    for (const u of supported) {
      g.sent += sent(u);
      g.received += received(u);
      const c = sessionCost(u);
      if (c != null) {
        g.cost += c;
        g.priced = true;
        if (u.cost == null) g.estimated = true;
      }
    }
    return g;
  }, [supported]);

  const byCli = useMemo(() => groupBy(supported, (u) => u.agent), [supported]);
  const byModel = useMemo(
    () => groupBy(supported, (u) => u.model ?? "unknown"),
    [supported],
  );
  // Newest first — a stable order that doesn't reshuffle as live costs tick
  // (sorting by cost made rows swap places on every poll).
  const sessions = useMemo(
    () => [...supported].sort((a, b) => b.updated - a.updated),
    [supported],
  );

  return (
    <div className="stats-panel">
      <div className="ap-head">
        <span className="ap-title">Usage &amp; cost · all sessions</span>
        <span className="ap-head-spacer" />
      </div>

      {loaded && supported.length === 0 ? (
        <div className="stats-empty">
          No tracked sessions yet. Run an agent (Claude, Codex, or oh-my-pi) and
          its token usage shows up here.
        </div>
      ) : (
        <>
          <div className="stats-overview">
            <div className="stats-metric">
              <span className="stats-metric-val">{fmtCost(total.cost)}</span>
              <span className="stats-metric-lbl">
                {total.estimated ? "est. cost" : "cost"}
              </span>
            </div>
            <div className="stats-metric">
              <span className="stats-metric-val">↑ {fmtTokens(total.sent)}</span>
              <span className="stats-metric-lbl">sent</span>
            </div>
            <div className="stats-metric">
              <span className="stats-metric-val">↓ {fmtTokens(total.received)}</span>
              <span className="stats-metric-lbl">received</span>
            </div>
            <div className="stats-metric">
              <span className="stats-metric-val">{total.sessions}</span>
              <span className="stats-metric-lbl">sessions</span>
            </div>
          </div>

          <div className="ap-head stats-section-head">
            <span className="ap-title">By CLI</span>
          </div>
          <table className="stats-table">
            <colgroup>
              <col style={{ width: "34%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "17%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>CLI</th>
                <th className="stats-num">Sess</th>
                <th className="stats-num">↑ Sent</th>
                <th className="stats-num">↓ Recv</th>
                <th className="stats-num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {byCli.map((g) => (
                <tr key={g.key}>
                  <td>
                    <span className="stats-agent">
                      <AgentIcon id={g.key} size={13} />
                      <span className="stats-agent-name">{agentName(g.key)}</span>
                    </span>
                  </td>
                  <td className="stats-num">{g.sessions}</td>
                  <td className="stats-num">{fmtTokens(g.sent)}</td>
                  <td className="stats-num">{fmtTokens(g.received)}</td>
                  <td className="stats-num">
                    <CostCell g={g} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="ap-head stats-section-head">
            <span className="ap-title">By model</span>
          </div>
          <table className="stats-table">
            <colgroup>
              <col style={{ width: "40%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "22%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Model</th>
                <th className="stats-num">↑ Sent</th>
                <th className="stats-num">↓ Recv</th>
                <th className="stats-num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((g) => (
                <tr key={g.key}>
                  <td className="stats-model" title={g.key}>
                    {g.key === "unknown" ? "—" : g.key}
                  </td>
                  <td className="stats-num">{fmtTokens(g.sent)}</td>
                  <td className="stats-num">{fmtTokens(g.received)}</td>
                  <td className="stats-num">
                    <CostCell g={g} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="ap-head stats-section-head">
            <span className="ap-title">Sessions</span>
          </div>
          <table className="stats-table">
            <colgroup>
              <col style={{ width: "40%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "22%" }} />
            </colgroup>
            <tbody>
              {sessions.slice(0, 40).map((u) => {
                const c = sessionCost(u);
                return (
                  <tr key={`${u.agent}:${u.session_id}`}>
                    <td>
                      <span className="stats-agent">
                        <AgentIcon id={u.agent} size={12} />
                        <span className="stats-sess-title" title={u.cwd}>
                          {u.title || u.cwd.split("/").pop() || u.session_id.slice(0, 8)}
                        </span>
                      </span>
                    </td>
                    <td className="stats-num stats-dim">{fmtTokens(sent(u))}</td>
                    <td className="stats-num stats-dim">{fmtTokens(received(u))}</td>
                    <td className="stats-num">
                      {c == null ? (
                        <span className="stats-dim">—</span>
                      ) : (
                        <span className="stats-cost">
                          {u.cost == null ? "~" : ""}
                          {fmtCost(c)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {unsupported.length > 0 && (
        <div className="stats-note">
          Not tracked: {unsupported.map(agentName).join(", ")} — usage isn't
          readable locally (server-side threads or no machine-readable log).
        </div>
      )}
    </div>
  );
}
