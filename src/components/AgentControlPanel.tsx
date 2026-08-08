// The agent control panel: every agent working in Canopy, as one live picture.
//
// Two views of one dataset. The graph draws each agent session as a node in
// its checkout's group, with an edge wherever the mesh has recorded traffic
// between two terminals — a pulse rides the edge when a message flows, and
// clicking an edge severs (or reconnects) that pair at the mesh store's own
// write door. The table is the same rows flat: status, agent, the prompt that
// started it, and what it is working on now.
//
// Honesty rules, inherited: statuses are shared/agentLife verbatim (`unknown`
// is never dressed up as idle), edges exist only where messages were recorded,
// and the lead→worker arrow renders only when every brief on the edge came
// from one side. Data arrives by subscription — pty:stats pushes, the mesh
// speaks over the store-change channel — never by a polling loop here.
import { useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import { basename } from "../paths";
import { LIFE_META } from "../../shared/agentLife";
import type { Life } from "../../shared/agentLife";
import { agentDisplayName, type TabName } from "../agentDisplayName";
import { useAgentSessions, lastHumanPrompt, type SessionRow } from "../agentSessions";
import {
  checkoutKey,
  deriveEdges,
  initialPrompt,
  isSevered,
  nodeLabel,
  severedOnlyEdges,
  subscribeMesh,
  type MeshEdge,
} from "../meshLinks";
import { AgentIcon, TerminalIcon } from "./icons";

export type ControlPanelMode = "graph" | "table";

interface Node {
  row: SessionRow;
  life: Life;
  group: string;
}

interface Pulse {
  key: string;
  d: string;
}

/** Graph geometry: groups are columns, nodes stack inside their group. */
const COL_W = 250;
const ROW_H = 104;
const X0 = 140;
const Y0 = 96;
const NODE_R = 44;

export interface AgentControlPanelProps {
  /** This surface is in front; everything that subscribes is gated on it. */
  active: boolean;
  mode: ControlPanelMode;
  /** Every open project, because this panel is app-wide — the graph must not
   *  stop at the project whose tab it lives in. */
  allProjects: { name: string; roots: string[] }[];
  onJumpToPty?: (ptyId: number) => void;
  tabNames?: Map<number, TabName>;
}

export function AgentControlPanel({
  active,
  mode,
  allProjects,
  onJumpToPty,
  tabNames,
}: AgentControlPanelProps) {
  // App-wide terminals, from the monitor's own push — the project-scoped stats
  // the Agents page uses are filtered at its door, and this panel must not be.
  const [stats, setStats] = useState<ipc.SessionStats[]>([]);
  useEffect(() => {
    if (!active) return;
    void ipc.ptyStats().then(setStats).catch(() => {});
    let cancelled = false;
    let un: (() => void) | undefined;
    void ipc.onPtyStats((all) => setStats(all)).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [active]);

  const roots = useMemo(() => allProjects.flatMap((p) => p.roots), [allProjects]);
  const { agentSessions, lifeOf } = useAgentSessions({
    visible: active,
    roots,
    stats,
    liveSessionIds: [],
  });

  const [instance, setInstance] = useState<string | null>(null);
  useEffect(() => {
    void ipc.instanceId().then(setInstance).catch(() => {});
  }, []);

  // The mesh: messages and severed pairs, refetched when the store says it
  // moved. The write boundary pulses (mesh.rs), so there is nothing to poll.
  const [messages, setMessages] = useState<ipc.MeshMessage[]>([]);
  const [severed, setSevered] = useState<ipc.SeveredPair[]>([]);
  useEffect(() => {
    if (!active) return;
    const load = () => {
      void ipc.contextMessages().then(setMessages).catch(() => {});
      void ipc.meshSevered().then(setSevered).catch(() => {});
    };
    load();
    return subscribeMesh(load);
  }, [active]);

  const nodes: Node[] = useMemo(
    () =>
      agentSessions.map((row) => ({
        row,
        life: lifeOf(row),
        group: checkoutKey(row.session.cwd),
      })),
    [agentSessions, lifeOf],
  );

  const livePtyIds = useMemo(
    () => new Set(nodes.map((n) => n.row.session.id)),
    [nodes],
  );
  const edges = useMemo(() => {
    const observed = deriveEdges(messages, instance, livePtyIds);
    return observed.concat(severedOnlyEdges(severed, instance, livePtyIds, observed));
  }, [messages, instance, livePtyIds, severed]);

  // Layout: one column per group, stable order (group key, then pty id) so a
  // stats tick never shuffles the picture.
  const groups = useMemo(() => {
    const byKey = new Map<string, Node[]>();
    for (const n of nodes) {
      const list = byKey.get(n.group) ?? [];
      list.push(n);
      byKey.set(n.group, list);
    }
    return [...byKey.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, members]) => ({
        key,
        members: members.sort((a, b) => a.row.session.id - b.row.session.id),
      }));
  }, [nodes]);

  const positions = useMemo(() => {
    const at = new Map<number, { x: number; y: number }>();
    groups.forEach((g, gi) => {
      g.members.forEach((n, ni) => {
        at.set(n.row.session.id, { x: X0 + gi * COL_W, y: Y0 + ni * ROW_H });
      });
    });
    return at;
  }, [groups]);
  const width = Math.max(1, groups.length) * COL_W + 40;
  const height =
    Math.max(1, ...groups.map((g) => g.members.length)) * ROW_H + Y0 + 20;

  // A transmission pulse per newly observed message, riding its edge from the
  // sender's end. Driven by the store-change refetch above, cleared by its own
  // one-shot timer — never a polling loop.
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const seenLast = useRef(new Map<string, string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const fresh: Pulse[] = [];
    for (const e of edges) {
      const key = `${e.a}:${e.b}`;
      if (!e.lastId || e.lastFrom == null) continue;
      const prev = seenLast.current.get(key);
      seenLast.current.set(key, e.lastId);
      if (prev === undefined || prev === e.lastId) continue;
      if (isSevered(severed, instance, e.a, e.b)) continue;
      const from = positions.get(e.lastFrom);
      const to = positions.get(e.lastFrom === e.a ? e.b : e.a);
      if (!from || !to) continue;
      fresh.push({ key: e.lastId, d: wireD(from, to) });
    }
    if (fresh.length === 0) return;
    setPulses((p) => [...p, ...fresh]);
    // One-shot removal per batch, deliberately not cancelled when the effect
    // re-runs: cleanup here would strand every pulse the next send interrupts.
    const keys = new Set(fresh.map((p) => p.key));
    window.setTimeout(() => {
      if (alive.current) setPulses((p) => p.filter((x) => !keys.has(x.key)));
    }, 1500);
  }, [edges, positions, severed, instance]);

  const sever = (e: MeshEdge) => {
    void ipc
      .meshSever(e.a, e.b, !isSevered(severed, instance, e.a, e.b))
      .then(setSevered)
      .catch(() => {});
  };

  const groupLabel = (key: string) => {
    const project = allProjects.find((p) =>
      p.roots.some((r) => key === r || key.startsWith(r + "/")),
    );
    return project?.name ?? basename(key) ?? key;
  };

  if (nodes.length === 0) {
    return (
      <p className="acp-empty">
        No agents are running anywhere in Canopy — the graph draws itself as
        they start.
      </p>
    );
  }

  if (mode === "table") {
    return (
      <table className="acp-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Status</th>
            <th>Initial prompt</th>
            <th>Working on now</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map(({ row, life }) => {
            const st = LIFE_META[life.state];
            const label = labelFor(row, tabNames);
            return (
              <tr key={row.session.id} onClick={() => onJumpToPty?.(row.session.id)}>
                <td>
                  <span className="acp-agent" title={row.session.cwd}>
                    {row.agent?.id ? (
                      <AgentIcon id={row.agent.id} size={14} />
                    ) : (
                      <TerminalIcon size={13} />
                    )}
                    <span className="acp-agent-name">{label.primary}</span>
                    {label.detail && <span className="acp-dim">{label.detail}</span>}
                  </span>
                </td>
                <td>
                  <span className={`acp-state ${st.cls}`} title={life.note}>
                    {st.label}
                  </span>
                </td>
                <td className="acp-prompt">
                  {initialPrompt(row.digest) ?? <em>none recorded</em>}
                </td>
                <td className="acp-prompt">
                  {lastHumanPrompt(row.digest?.prompts) ?? <em>{life.note}</em>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <div className="acp-graph" style={{ width, height }}>
      <svg
        className="acp-wires"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <marker
            id="acp-lead"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 9 5 L 0 9 z" />
          </marker>
        </defs>
        {edges.map((e) => {
          const a = positions.get(e.a);
          const b = positions.get(e.b);
          if (!a || !b) return null;
          const cut = isSevered(severed, instance, e.a, e.b);
          // Lead end first, so the arrow at the path's end points at the
          // worker. Undirected edges keep a-b order and no marker.
          const from = e.lead === e.b ? b : a;
          const to = e.lead === e.b ? a : b;
          const title = cut
            ? `Severed — messages between #${e.a} and #${e.b} are refused. Click to reconnect.`
            : `${e.count} message${e.count === 1 ? "" : "s"} between #${e.a} and #${e.b}` +
              (e.lead != null ? ` — briefs flow from #${e.lead}` : "") +
              ". Click to sever this connection.";
          return (
            <g
              key={`${e.a}:${e.b}`}
              className={`acp-edge ${cut ? "acp-edge-severed" : ""}`}
              onClick={() => sever(e)}
            >
              <title>{title}</title>
              <path className="acp-edge-hit" d={wireD(from, to)} />
              <path
                className="acp-edge-wire"
                d={wireD(from, to)}
                markerEnd={!cut && e.lead != null ? "url(#acp-lead)" : undefined}
              />
              {cut && (
                <text
                  className="acp-edge-cut"
                  x={(a.x + b.x) / 2}
                  y={(a.y + b.y) / 2 + 4}
                  textAnchor="middle"
                >
                  ✕
                </text>
              )}
            </g>
          );
        })}
        {pulses.map((p) => (
          <circle key={p.key} className="acp-pulse" r="5">
            <animateMotion dur="1.1s" repeatCount="1" fill="freeze" path={p.d} />
          </circle>
        ))}
      </svg>
      {groups.map((g, gi) => (
        <div
          key={g.key}
          className="acp-group"
          style={{
            left: X0 + gi * COL_W - COL_W / 2 + 16,
            top: Y0 - NODE_R - 34,
            width: COL_W - 32,
            height: g.members.length * ROW_H + 30,
          }}
        >
          <span className="acp-group-name" title={g.key}>
            {groupLabel(g.key)}
          </span>
        </div>
      ))}
      {nodes.map(({ row, life }) => {
        const at = positions.get(row.session.id);
        if (!at) return null;
        const st = LIFE_META[life.state];
        const label = labelFor(row, tabNames);
        return (
          <button
            key={row.session.id}
            className={`acp-node ${st.cls}`}
            style={{ left: at.x, top: at.y }}
            title={`${label.primary}${label.detail ? ` (${label.detail})` : ""} — ${
              life.note || st.label
            }\n${row.session.cwd}`}
            onClick={() => onJumpToPty?.(row.session.id)}
          >
            <span className="acp-node-head">
              {row.agent?.id ? (
                <AgentIcon id={row.agent.id} size={16} />
              ) : (
                <TerminalIcon size={14} />
              )}
              <span className="acp-node-name">{label.primary}</span>
            </span>
            {label.detail && <span className="acp-node-detail">{label.detail}</span>}
            <span className={`acp-state ${st.cls}`}>{st.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The identity a node or table row leads with: the strongest the record has
 *  today (CLI kind + terminal id, then tab title and branch), assembled by
 *  `nodeLabel` so the substrate's normalized `name`, when it lands, replaces
 *  the composite without touching either view. */
function labelFor(row: SessionRow, tabNames?: Map<number, TabName>) {
  return nodeLabel({
    agentLabel: row.agent?.label,
    ptyId: row.session.id,
    tabTitle: agentDisplayName({
      tab: tabNames?.get(row.session.id),
      agentLabel: row.agent?.label,
      sessionTitle: row.session.title,
    }),
    branch: row.digest?.branch,
  });
}

/** A gentle horizontal-biased curve between two node centres. */
function wireD(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = (to.x - from.x) / 2;
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}
