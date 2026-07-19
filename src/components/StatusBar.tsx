// Bottom status tray: git branch, running agent, model, tokens, estimated
// cost. Token/model data comes from Claude Code session transcripts (path
// arrives via hook events); cost is an estimate from a static pricing map.
import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import type { AgentEventEntry } from "../types";

// $/MTok (input, output, cache-read ≈ 0.1× input). Estimates only.
const PRICING: [RegExp, { in: number; out: number }][] = [
  [/fable|mythos/i, { in: 10, out: 50 }],
  [/opus/i, { in: 5, out: 25 }],
  [/sonnet/i, { in: 3, out: 15 }],
  [/haiku/i, { in: 1, out: 5 }],
];

function estimateCost(s: ipc.ClaudeSessionStats): number | null {
  if (!s.model) return null;
  const price = PRICING.find(([re]) => re.test(s.model!))?.[1];
  if (!price) return null;
  return (
    (s.input_tokens + s.cache_creation_tokens * 1.25) * (price.in / 1e6) +
    s.cache_read_tokens * (price.in * 0.1) / 1e6 +
    s.output_tokens * (price.out / 1e6)
  );
}

const fmtMem = (bytes: number) =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;

const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`;

/** What `/model` in Claude Code accepts — aliases resolve to the CLI's own
 *  latest models, so this list doesn't go stale with each release. */
const MODELS: { id: string; label: string; hint: string }[] = [
  { id: "default", label: "Default", hint: "recommended" },
  { id: "opus", label: "Opus", hint: "most capable" },
  { id: "sonnet", label: "Sonnet", hint: "balanced" },
  { id: "sonnet[1m]", label: "Sonnet · 1M context", hint: "long sessions" },
  { id: "haiku", label: "Haiku", hint: "fast, cheapest" },
  { id: "opusplan", label: "Opus Plan", hint: "Opus plans, Sonnet codes" },
];

interface StatusBarProps {
  roots: string[];
  agents: { name: string; cpu: number }[];
  events: AgentEventEntry[];
  /** This project is the one on screen. Hidden projects freeze their polling
   *  (git status, transcript stats) instead of burning it in the background. */
  visible: boolean;
  /** Present when a Claude session is live in this project; switches its model. */
  onSetModel?: (model: string) => void;
}

export function StatusBar({ roots, agents, events, visible, onSetModel }: StatusBarProps) {
  const [branch, setBranch] = useState<string | null>(null);
  const [dirty, setDirty] = useState(0);
  const [app, setApp] = useState<ipc.AppStats | null>(null);
  const [stats, setStats] = useState<ipc.ClaudeSessionStats | null>(null);
  const [modelMenu, setModelMenu] = useState(false);
  const [confirmModel, setConfirmModel] = useState<{ id: string; label: string } | null>(null);

  // Whole-app footprint, pushed from the Rust monitor. Only the visible
  // project listens — every hidden StatusBar re-rendering on each tick is
  // work nobody can see.
  useEffect(() => {
    if (!visible) return;
    const sub = ipc.onAppStats(setApp);
    return () => void sub.then((fn) => fn());
  }, [visible]);

  // Latest Claude transcript for this project (hook events carry cwd + path).
  const transcript = (() => {
    for (let i = events.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(events[i].raw);
        if (
          typeof parsed.transcript_path === "string" &&
          typeof parsed.cwd === "string" &&
          roots.some((r) => parsed.cwd === r || parsed.cwd.startsWith(r + "/"))
        ) {
          return parsed.transcript_path as string;
        }
      } catch {
        // non-JSON hook line
      }
    }
    return null;
  })();

  // Both pollers gate on `visible`: each spawns a git subprocess / transcript
  // read per tick per project, and a backgrounded project doesn't need either.
  // Switching back re-runs the effect, which refreshes immediately.
  useEffect(() => {
    if (!roots[0] || !visible) return;
    let cancelled = false;
    const refresh = () => {
      void ipc.gitStatus(roots[0]).then((s) => {
        if (cancelled) return;
        setBranch(s.branch);
        setDirty(s.entries.filter((e) => e.status !== "!!").length);
      }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [roots[0], visible]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!transcript || !visible) return;
    let cancelled = false;
    const refresh = () => {
      void ipc.claudeSessionStats(transcript).then((s) => {
        if (!cancelled) setStats(s);
      }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 8_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [transcript, visible]);

  const cost = stats ? estimateCost(stats) : null;

  return (
    <div className="status-bar">
      {branch && (
        <span className="status-item" title={`git branch (${dirty} changed files)`}>
          ⎇ {branch}
          {dirty > 0 && <span className="status-dirty"> ±{dirty}</span>}
        </span>
      )}
      {agents.length > 0 && (
        <span className="status-item status-agent" title="running agents">
          ✳ {agents.map((a) => a.name).join(", ")}
        </span>
      )}
      <span className="status-spacer" />
      {app && (
        <span
          className="status-item status-res"
          title={
            `canopy: ${app.procs} process${app.procs === 1 ? "" : "es"} — ` +
            `Rust core, language servers, terminals and everything they spawned.\n\n` +
            `Does not include the WebView: macOS runs it in system-owned WebKit ` +
            `processes parented to launchd, which can't be attributed back to us.`
          }
        >
          {app.cpu.toFixed(0)}% cpu · {fmtMem(app.mem_bytes)}
        </span>
      )}
      {stats?.model && (
        <span className="status-item status-model-anchor">
          {onSetModel ? (
            <button
              className="status-model-btn"
              title="Change this session's model (/model)"
              onClick={() => setModelMenu((v) => !v)}
            >
              {stats.model.replace(/^claude-/, "")} ▾
            </button>
          ) : (
            <span title="model (from Claude session transcript)">
              {stats.model.replace(/^claude-/, "")}
            </span>
          )}
          {modelMenu && (
            <div className="status-menu" onMouseLeave={() => setModelMenu(false)}>
              {MODELS.map((m) => (
                <div
                  key={m.id}
                  className="cli-item"
                  onClick={() => {
                    setModelMenu(false);
                    setConfirmModel(m);
                  }}
                >
                  <span>{m.label}</span>
                  <span className="status-menu-hint">{m.hint}</span>
                </div>
              ))}
            </div>
          )}
        </span>
      )}
      {confirmModel && (
        <div className="confirm-backdrop" onMouseDown={() => setConfirmModel(null)}>
          <div className="confirm" onMouseDown={(e) => e.stopPropagation()}>
            <p>
              Switch this session to <strong>{confirmModel.label}</strong>?
            </p>
            <p className="confirm-sub">
              This types <code>/model {confirmModel.id}</code> into the Claude
              terminal and submits it. Claude applies it to the running session —
              if the new model has a smaller context window, Claude will warn or
              compact in the terminal, so check its response there. If you have
              unsent text typed in that session's input box, it will be submitted
              along with the command.
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setConfirmModel(null)}>
                Cancel
              </button>
              <button
                className="btn btn-accent"
                onClick={() => {
                  onSetModel?.(confirmModel.id);
                  setConfirmModel(null);
                }}
              >
                Switch model
              </button>
            </div>
          </div>
        </div>
      )}
      {stats && (stats.input_tokens > 0 || stats.output_tokens > 0) && (
        <span
          className="status-item"
          title={`in ${stats.input_tokens.toLocaleString()} · out ${stats.output_tokens.toLocaleString()} · cache read ${stats.cache_read_tokens.toLocaleString()} · ${stats.turns} turns`}
        >
          ↑{fmtTokens(stats.input_tokens + stats.cache_creation_tokens)} ↓
          {fmtTokens(stats.output_tokens)}
        </span>
      )}
      {cost != null && (
        <span className="status-item status-cost" title="estimated session cost">
          ~${cost.toFixed(2)}
        </span>
      )}
    </div>
  );
}
