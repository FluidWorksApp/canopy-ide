// Tools: every MCP server your agents can reach, from every CLI, as one list.
//
// The CLIs each keep their own registry and people configure the same server in
// several of them, so read one at a time these are seven partial answers to the
// same question. This is the whole answer, folded on what each entry actually
// launches — which means a row is a *server*, and the CLIs that configure it are
// a property of that row rather than seven rows that happen to look alike.
//
// It owns no discovery logic: `mcpServers()` reads the configs in Rust, where
// the credentials in them are stripped before anything crosses into the webview.
// This file has no values to leak because it is never given any.
import { useCallback, useEffect, useState } from "react";
import { mcpServers, type McpServer, type McpSource } from "../ipc";
import { ChevronIcon, PlugIcon, RestartIcon } from "./icons";
import { Button } from "./ui";

interface McpToolsPanelProps {
  /** The project's component roots, for their `.mcp.json` and the CLIs'
   *  per-project registries. Joined by the caller into a stable string so a new
   *  array identity each render does not re-read eight configs. */
  rootsKey: string;
  /** In front. Discovery is file-only and cheap, but a panel nobody is looking
   *  at should still not re-read eight configs when the project changes. */
  visible: boolean;
  /** Open this server's own tab — where its tools live. The row is the summary;
   *  the tab is the server. */
  onOpen: (server: McpServer) => void;
}

/** Which CLIs can actually reach this server, so the panel can say "Claude has
 *  this one and Codex doesn't" without the user reading every row.
 *
 *  Enabled only — the same bar the Rust side sets `enabled` by. A `pending`
 *  source is a `.mcp.json` server nobody has approved, which is not a CLI that
 *  can reach it; counting it here would put a CLI in the reachable list on a
 *  row whose own summary says "not reachable". */
function agentsOf(server: McpServer): string[] {
  const seen: string[] = [];
  for (const s of server.sources) {
    const cli = s.label.replace(/ \(.*\)$/, "");
    if (s.status === "enabled" && !seen.includes(cli)) seen.push(cli);
  }
  return seen;
}

/** The reachable CLIs as they fit on a 280px row.
 *
 *  Two names fit; four do not, and the truncation lands on exactly the rows the
 *  panel exists for — the heavily-shared ones. A count says the thing the names
 *  were there to say ("this one server is four CLIs' server") and leaves the
 *  names to the tooltip and the expansion, where there is room for them. */
function summarise(agents: string[]): string {
  if (agents.length === 0) return "not reachable";
  if (agents.length <= 2) return agents.join(" · ");
  return `${agents.length} CLIs`;
}

/** What this server would actually run, in one line. Already redacted upstream;
 *  this only assembles it. */
function launchLine(server: McpServer): string {
  if (server.url) return server.url;
  return [server.command ?? "", ...server.args].join(" ").trim();
}

const STATUS_TITLE: Record<McpSource["status"], string> = {
  enabled: "enabled",
  disabled: "switched off here",
  pending: "waiting for approval — this CLI has not been told whether to trust it",
};

function SourceRow({ source }: { source: McpSource }) {
  return (
    <div className={`mcp-source mcp-source-${source.status}`} title={source.config_path}>
      <span className="mcp-source-label">{source.label}</span>
      {/* The name only earns a place when it differs from the row's — which is
          often, and is the thing that makes two rows look like one server. */}
      <span className="mcp-source-name">{source.name}</span>
      <span className="mcp-source-status" title={STATUS_TITLE[source.status]}>
        {source.status === "enabled" ? "" : source.status}
      </span>
    </div>
  );
}

export function McpToolsPanel({ rootsKey, visible, onOpen }: McpToolsPanelProps) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    mcpServers(rootsKey ? rootsKey.split("\n") : []).then(
      (list) => {
        setServers(list);
        setError(null);
      },
      (e) => setError(String(e)),
    );
  }, [rootsKey]);

  // On the way in and on project change, never on a timer: these are files a
  // human edits, so a poll would spend a read a second to catch an event that
  // happens twice a month.
  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const reachable = servers?.filter((s) => s.enabled).length ?? 0;

  return (
    <div className="mcp-panel">
      <div className="side-panel-head">
        <span>Tools</span>
        <span className="servers-head-actions">
          {servers && servers.length > 0 && (
            <span className="mcp-count">
              {reachable} of {servers.length} live
            </span>
          )}
          <Button icon title="Re-read the configs" onClick={load}>
            <RestartIcon size={13} />
          </Button>
        </span>
      </div>

      {error && <div className="mcp-error">{error}</div>}

      {servers && servers.length === 0 && (
        <div className="servers-empty">
          <p>No MCP servers configured.</p>
          <p>
            Servers registered with any of your agent CLIs — Claude Code, Codex,
            Antigravity, OpenCode, Amp, Cursor, Windsurf — show up here as one list,
            with the same server listed once however many CLIs have it.
          </p>
        </div>
      )}

      {servers?.map((server) => {
        const open = expanded.has(server.key);
        const agents = agentsOf(server);
        return (
          <div key={server.key} className="mcp-server">
            <div
              className={`mcp-row ${server.enabled ? "" : "mcp-row-off"}`}
              /* The row opens the server, because a server is a thing you look
                 at rather than a thing you unfold. The chevron keeps the
                 configs, which is the one question answerable without starting
                 anything — and the reason it stays a separate hit target. */
              onClick={() => onOpen(server)}
              title={`${launchLine(server)}\n\nOpen this server`}
            >
              <span
                className={`tree-chevron ${open ? "tree-chevron-open" : ""}`}
                title={open ? "Hide where it's configured" : "Where it's configured"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(server.key);
                }}
              >
                <ChevronIcon />
              </span>
              <PlugIcon size={13} className="mcp-row-icon" />
              <span className="mcp-name">{server.name}</span>
              {server.transport !== "stdio" && (
                <span className="mcp-transport">{server.transport}</span>
              )}
              {/* The count is the point of the whole panel: it says this one
                  server is the same server in four places. */}
              <span
                className="mcp-agents"
                title={server.sources.map((s) => `${s.label} — ${s.name}`).join("\n")}
              >
                {summarise(agents)}
              </span>
            </div>

            {open && (
              <div className="mcp-detail">
                <div className="mcp-launch">{launchLine(server)}</div>
                {server.env_keys.length > 0 && (
                  /* Names, never values — the values are dropped in Rust and
                     this component is never given them. Shown because "which
                     credentials does this need" is a real question and the
                     answer is not a secret; the credentials themselves are. */
                  <div className="mcp-env" title="Environment variables this server is given (names only)">
                    {server.env_keys.map((k) => (
                      <span key={k} className="mcp-env-key">
                        {k}
                      </span>
                    ))}
                  </div>
                )}
                {server.sources.map((s) => (
                  <SourceRow key={`${s.agent}:${s.config_path}:${s.name}`} source={s} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Said once, at the end, rather than under every row: it is a fact about
          the panel, not about any one server. */}
      {servers && servers.length > 0 && (
        <div className="mcp-pending-note">
          Open a server to see the tools it exposes. That means starting it —
          nothing here runs until you do.
        </div>
      )}
    </div>
  );
}
