// The agent control panel: every agent working in Canopy, as one live picture.
//
// Two views of one dataset. The graph draws each agent session as a node in
// its project's group, with an edge wherever the mesh has recorded traffic
// between two terminals — spawn openings establish the primary family tree,
// ordinary traffic stays secondary, and a pulse rides the edge when a message
// flows. Sever/reconnect has its own guarded control at the mesh store's one
// write door. The table is the same rows flat: status, agent, the prompt that
// started it, and what it is working on now.
//
// Honesty rules, inherited: statuses are shared/agentLife verbatim (`unknown`
// is never dressed up as idle), edges exist only where messages were recorded,
// and a lead→worker arrow comes from a spawn opening first, one-sided briefing
// inference second. Data arrives by subscription — pty:stats pushes, the mesh
// speaks over the store-change channel — never by a polling loop here.
import { useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import { basename } from "../paths";
import { LIFE_META } from "../../shared/agentLife";
import type { Life } from "../../shared/agentLife";
import { agentDisplayName, type TabName } from "../agentDisplayName";
import { useAgentSessions, workingOnNow, type SessionRow } from "../agentSessions";
import {
  checkoutKey,
  deriveEdges,
  initialPrompt,
  isSevered,
  lineageLayers,
  nodeLabel,
  severedOnlyEdges,
  subscribeMesh,
  type MeshEdge,
} from "../meshLinks";
import { AgentIcon, TerminalIcon } from "./icons";
import { AgentNameEditor } from "./AgentNameEditor";

export type ControlPanelMode = "graph" | "table";

interface Node {
  row: SessionRow;
  life: Life;
  group: string;
  groupLabel: string;
  groupTitle: string;
}

interface Pulse {
  key: string;
  d: string;
}

/** Graph geometry: project groups sit side by side; within one, parents own
 *  a horizontal band above a horizontal band of their children. */
const GROUP_GAP = 28;
const GROUP_PAD_X = 28;
const NODE_GAP_X = 216;
const LAYER_GAP_Y = 116;
const GRAPH_PAD_X = 24;
const Y0 = 96;
const NODE_R = 44;

/** Resolve a terminal to the Canopy project that owns its component root.
 *  A project may contain several independent repositories; grouping by each
 *  checkout and then labelling every box with the project name produced the
 *  repeated CORAA frames this surface used to show. The project index is the
 *  identity (names need not be unique), while the longest matching root wins
 *  when projects are nested. Unowned terminals retain checkout grouping. */
function graphGroup(
  cwd: string,
  projects: { name: string; roots: string[] }[],
): { key: string; label: string; title: string } {
  const cleanCwd = cwd.replace(/\/+$/, "") || "/";
  let match: { projectIndex: number; root: string } | undefined;
  projects.forEach((project, projectIndex) => {
    for (const rawRoot of project.roots) {
      const root = rawRoot.replace(/\/+$/, "") || "/";
      if (
        (cleanCwd === root || cleanCwd.startsWith(`${root}/`)) &&
        (!match || root.length > match.root.length)
      ) {
        match = { projectIndex, root };
      }
    }
  });
  if (match) {
    const project = projects[match.projectIndex];
    return {
      key: `project:${match.projectIndex}`,
      label: project.name,
      title: project.roots.join("\n"),
    };
  }
  const checkout = checkoutKey(cleanCwd);
  return {
    key: `checkout:${checkout}`,
    label: basename(checkout) || checkout,
    title: checkout,
  };
}

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
      agentSessions.map((row) => {
        const group = graphGroup(row.session.cwd, allProjects);
        return {
          row,
          life: lifeOf(row),
          group: group.key,
          groupLabel: group.label,
          groupTitle: group.title,
        };
      }),
    [agentSessions, lifeOf, allProjects],
  );

  const livePtyIds = useMemo(
    () => new Set(nodes.map((n) => n.row.session.id)),
    [nodes],
  );
  const edges = useMemo(() => {
    const observed = deriveEdges(messages, instance, livePtyIds);
    return observed.concat(severedOnlyEdges(severed, instance, livePtyIds, observed));
  }, [messages, instance, livePtyIds, severed]);

  // Membership stays stable (group key, then pty id) so a stats tick never
  // shuffles the picture. Geometry below then turns recorded lineage into
  // parent/child bands rather than flattening every member into one column.
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
        label: members[0].groupLabel,
        title: members[0].groupTitle,
        members: members.sort((a, b) => a.row.session.id - b.row.session.id),
      }));
  }, [nodes]);

  const layout = useMemo(() => {
    const at = new Map<number, { x: number; y: number }>();
    let left = GRAPH_PAD_X;
    let deepest = 1;
    const placedGroups = groups.map((group) => {
      const byId = new Map(group.members.map((node) => [node.row.session.id, node]));
      const layers = lineageLayers([...byId.keys()], edges);
      const widest = Math.max(1, ...layers.map((layer) => layer.length));
      const width = widest * NODE_GAP_X + GROUP_PAD_X * 2;
      layers.forEach((layer, depth) => {
        layer.forEach((id, index) => {
          at.set(id, {
            x: left + width / 2 + (index - (layer.length - 1) / 2) * NODE_GAP_X,
            y: Y0 + depth * LAYER_GAP_Y,
          });
        });
      });
      deepest = Math.max(deepest, layers.length);
      const placed = { ...group, left, width, layers };
      left += width + GROUP_GAP;
      return placed;
    });
    return {
      positions: at,
      groups: placedGroups,
      width: Math.max(1, left - GROUP_GAP + GRAPH_PAD_X),
      height: Y0 + deepest * LAYER_GAP_Y,
    };
  }, [groups, edges]);
  const { positions, width, height } = layout;

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

  const toggleConnection = (e: MeshEdge) => {
    const cut = isSevered(severed, instance, e.a, e.b);
    if (
      !cut &&
      !window.confirm(
        `Sever the connection between terminals #${e.a} and #${e.b}?\n\nMessages between them will be refused until you reconnect it.`,
      )
    ) {
      return;
    }
    void ipc
      .meshSever(e.a, e.b, !cut)
      .then(setSevered)
      .catch(() => {});
  };

  const [selectedPtyId, setSelectedPtyId] = useState<number | null>(null);

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
                    <AgentNameEditor
                      ptyId={row.session.id}
                      name={row.session.name ?? label.primary}
                      className="acp-agent-name"
                    />
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
                  {workingOnNow(row, tabNames) ?? <em>{life.note}</em>}
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
          const relationship =
            e.relation === "spawn"
              ? `spawn lineage from #${e.lead}`
              : e.relation === "inferred"
                ? `lead inferred from one-sided briefs by #${e.lead}`
                : "message traffic";
          const title = cut
            ? `Severed — messages between #${e.a} and #${e.b} are refused.`
            : `${e.count} message${e.count === 1 ? "" : "s"} between #${e.a} and #${e.b} — ${relationship}.`;
          const d = wireD(from, to);
          return (
            <g
              key={`${e.a}:${e.b}`}
              className={`acp-edge acp-edge-${e.relation} ${
                cut ? "acp-edge-severed" : ""
              }`}
              style={{ pointerEvents: "none" }}
            >
              <title>{title}</title>
              <path
                className="acp-edge-wire"
                d={d}
                markerEnd={!cut && e.lead != null ? "url(#acp-lead)" : undefined}
                strokeDasharray={!cut && e.relation === "traffic" ? "3 7" : undefined}
                style={{
                  opacity: cut
                    ? 1
                    : e.relation === "spawn"
                      ? 1
                      : e.relation === "inferred"
                        ? 0.72
                        : 0.42,
                  strokeWidth:
                    e.relation === "spawn"
                      ? 2.25
                      : e.relation === "inferred"
                        ? 1.35
                        : 1,
                }}
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
      {layout.groups.map((g) => (
        <div
          key={g.key}
          className="acp-group"
          style={{
            left: g.left,
            top: Y0 - NODE_R - 34,
            width: g.width,
            height: Math.max(1, g.layers.length) * LAYER_GAP_Y + 30,
          }}
        >
          <span className="acp-group-name" title={g.title}>
            {g.label}
          </span>
        </div>
      ))}
      {edges.map((edge) => {
        const a = positions.get(edge.a);
        const b = positions.get(edge.b);
        if (!a || !b) return null;
        const cut = isSevered(severed, instance, edge.a, edge.b);
        return (
          <button
            key={`action:${edge.a}:${edge.b}`}
            type="button"
            aria-label={`${cut ? "Reconnect" : "Sever"} connection between terminals #${edge.a} and #${edge.b}`}
            title={
              cut
                ? `Reconnect #${edge.a} and #${edge.b}`
                : `Sever #${edge.a} and #${edge.b}`
            }
            onClick={() => toggleConnection(edge)}
            style={{
              position: "absolute",
              left: (a.x + b.x) / 2,
              top: (a.y + b.y) / 2,
              zIndex: 2,
              transform: "translate(-50%, -50%)",
              width: 20,
              height: 20,
              padding: 0,
              border: "1px solid var(--border-strong)",
              borderRadius: 999,
              background: "var(--bg-raised)",
              color: cut ? "var(--accent)" : "var(--text-dim)",
              font: "inherit",
              fontSize: 11,
              lineHeight: "18px",
              cursor: "pointer",
            }}
          >
            {cut ? "↻" : "✕"}
          </button>
        );
      })}
      {nodes.map(({ row, life }) => {
        const at = positions.get(row.session.id);
        if (!at) return null;
        const st = LIFE_META[life.state];
        const label = labelFor(row, tabNames);
        return (
          <button
            key={row.session.id}
            className={`acp-node ${st.cls}`}
            style={{
              left: at.x,
              top: at.y,
              outline:
                selectedPtyId === row.session.id
                  ? "2px solid color-mix(in srgb, var(--accent) 72%, transparent)"
                  : undefined,
              outlineOffset: selectedPtyId === row.session.id ? 2 : undefined,
            }}
            aria-pressed={selectedPtyId === row.session.id}
            title={`${label.primary}${label.detail ? ` (${label.detail})` : ""} — ${
              life.note || st.label
            }\n${row.session.cwd}`}
            onClick={() => {
              setSelectedPtyId(row.session.id);
              onJumpToPty?.(row.session.id);
            }}
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
    // The naming substrate is now live on SessionStats. Keep the PTY id as the
    // credential everywhere else; this is display identity only.
    name: row.session.name,
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

/** A top-down family-tree curve between two node centres. Cross-checkout
 *  traffic can still run sideways, where the horizontal fallback is clearer. */
function wireD(from: { x: number; y: number }, to: { x: number; y: number }) {
  if (from.y !== to.y) {
    const dy = (to.y - from.y) / 2;
    return `M ${from.x} ${from.y} C ${from.x} ${from.y + dy}, ${to.x} ${to.y - dy}, ${to.x} ${to.y}`;
  }
  const dx = (to.x - from.x) / 2;
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}
