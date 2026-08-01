// Which agent CLIs are wired into Canopy, and the one click that wires them.
//
// The panel shows this behind a "?" because it is narrow and this is a table;
// the agents page shows it outright because that is what a management page is
// for. Same rows either way — a CLI reported as hooked in one place and silent
// in the other is exactly the confusion this replaces.
import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import { AgentIcon } from "./icons";
import { Button } from "./ui";

/** Every CLI with an auto-setup arm, in the order the integrations list shows
 *  them. Mirrors SUPPORTED_AGENTS in agents.rs. */
export const AGENT_LABELS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "agy", label: "Antigravity" },
  { id: "aider", label: "Aider" },
  { id: "opencode", label: "OpenCode" },
  { id: "omp", label: "oh-my-pi" },
  { id: "amp", label: "Amp" },
];

const HEALTH_TONE: Record<string, string> = {
  ours: "hs-ok",
  missing: "hs-warn",
  foreign: "hs-warn",
  unreadable: "hs-warn",
  unsupported: "hs-none",
};

/** Spelled out because "foreign" and "unsupported" look like problems and only
 *  one of them is. */
const HEALTH_HELP: Record<string, Record<string, string>> = {
  hooks: {
    ours: "This CLI's config points its events at Canopy",
    missing: "No Canopy hooks in this CLI's config — nothing will stream in",
  },
  mcp: {
    ours: "The Canopy MCP server is registered for this CLI",
    missing: "Not registered — this CLI's agents can't ask the IDE for context",
    foreign:
      "An MCP server named 'canopy' exists here that Canopy didn't write. It is left alone — rename or remove it, then set up again.",
    unreadable: "This CLI's MCP config exists but can't be parsed",
    unsupported: "This CLI has no MCP configuration Canopy can write",
  },
};

export interface Integrations {
  health: ipc.IntegrationHealth[];
  /** What the last setup run reported, per CLI, as one block of text. */
  result: string | null;
  /** Run auto-setup for one CLI or several, then re-read the health. */
  setUp: (agents: string | string[]) => Promise<void>;
}

/**
 * Read the per-CLI integration state while `active`, and keep it fresh.
 *
 * Re-read whenever the startup pass reports in, so a repair that happened while
 * the surface was open shows up without a manual refresh.
 */
export function useIntegrations(active: boolean): Integrations {
  const [health, setHealth] = useState<ipc.IntegrationHealth[]>([]);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    void ipc.agentIntegrationHealth().then(setHealth).catch(() => {});
    let un: (() => void) | undefined;
    void ipc.onIntegrationHealth((r) => setHealth(r.agents)).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [active]);

  // allSettled, not all: one CLI whose config can't be written must not erase
  // the report for the others. `Promise.all` rejected on the first failure and
  // showed that error alone, so a single unparseable registry made a setup that
  // wired up three CLIs look like it had done nothing at all.
  const setUp = async (agents: string | string[]) => {
    const ids = Array.isArray(agents) ? agents : [agents];
    const results = await Promise.allSettled(ids.map((a) => ipc.setupAgentHooks(a)));
    setResult(
      results
        .map((r, i) =>
          r.status === "fulfilled" ? r.value.summary : `${ids[i]}: ${String(r.reason)}`,
        )
        .join("\n"),
    );
    await ipc.agentIntegrationHealth().then(setHealth).catch(() => {});
  };

  return { health, result, setUp };
}

/** One row per CLI, stating what is actually on disk. A registration that
 *  silently failed used to be invisible here, which is how one survived
 *  unnoticed until a user asked why an agent was quiet. */
export function IntegrationsList({
  health,
  onSetUp,
  spacious = false,
}: {
  health: ipc.IntegrationHealth[];
  onSetUp: (agent: string) => void;
  /** The page's density: a brand mark per row and room to breathe. The panel
   *  gets neither — it is a column 300px wide. */
  spacious?: boolean;
}) {
  return (
    <div className={`hook-setup-list ${spacious ? "hook-setup-roomy" : ""}`}>
      {AGENT_LABELS.map((a) => {
        const h = health.find((x) => x.agent === a.id);
        return (
          <div key={a.id} className="hook-setup-row">
            {spacious && <AgentIcon id={a.id} size={15} className="hook-setup-mark" />}
            <span className="hook-setup-name">{a.label}</span>
            {h && !h.cli_installed && (
              <span className="hook-setup-state" title="This CLI isn't on your PATH">
                not installed
              </span>
            )}
            {h?.cli_installed && (
              <>
                <span
                  className={`hook-setup-state ${HEALTH_TONE[h.hooks] ?? ""}`}
                  title={HEALTH_HELP.hooks[h.hooks] ?? h.hooks}
                >
                  hooks {h.hooks}
                </span>
                <span
                  className={`hook-setup-state ${HEALTH_TONE[h.mcp] ?? ""}`}
                  title={HEALTH_HELP.mcp[h.mcp] ?? h.mcp}
                >
                  MCP {h.mcp}
                </span>
              </>
            )}
            <Button variant="accent" onClick={() => onSetUp(a.id)}>
              Set up
            </Button>
          </div>
        );
      })}
    </div>
  );
}
