// One MCP server, opened as a tab: who uses it, what it exposes, and a way to
// try any of it.
//
// The panel answers "what is configured"; this answers "what is actually there",
// which needs the server running. Connecting happens on open rather than behind
// a button — you opened the tab to see the tools, and a screen whose only
// content is a Connect button is a step that exists to be clicked through.
//
// The layout follows the two questions in order. The consumers are a row of
// tags at the top, because "which of my agents has this" is a glance, not a
// study. Everything below is the tools, because that is what the server is.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import {
  fieldsOf,
  initialValues,
  missingRequired,
  needsConfirm,
  renderContent,
  toArguments,
  toolBadges,
  type Field,
} from "../mcpForm";
import { ChevronIcon, PlugIcon, RestartIcon } from "./icons";

interface McpViewProps {
  server: ipc.McpServer;
  onNotice?: (message: string) => void;
}

/** What this server would run, in one line. Already redacted in Rust. */
function launchLine(server: ipc.McpServer): string {
  if (server.url) return server.url;
  return [server.command ?? "", ...server.args].join(" ").trim();
}

/** The CLI's name without the scope suffix the label carries. */
function cliOf(label: string): string {
  return label.replace(/ \(.*\)$/, "");
}

/** One config that points at this server, as a tag.
 *
 *  The name is repeated only when it differs from the row's — that difference is
 *  the whole reason these are one server and not four, so it earns the space
 *  exactly when it exists. */
function SourceTag({
  source,
  serverName,
}: {
  source: ipc.McpSource;
  serverName: string;
}) {
  const scope = source.scope === "project" ? "project" : "global";
  const title = [
    `${cliOf(source.label)} — ${source.status}`,
    `named "${source.name}" here`,
    source.config_path,
  ].join("\n");
  return (
    <span className={`mcp-tag mcp-tag-${source.status}`} title={title}>
      <span className="mcp-tag-cli">{cliOf(source.label)}</span>
      <span className="mcp-tag-scope">{scope}</span>
      {source.name !== serverName && (
        <span className="mcp-tag-alias">{source.name}</span>
      )}
    </span>
  );
}

/** One argument's control. Uncontrolled would lose what the user typed when the
 *  tool list re-renders, so every field is bound. */
function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: string;
  onChange: (next: string) => void;
}) {
  switch (field.kind) {
    case "boolean":
      return (
        <select
          className="mcp-input"
          value={value || "false"}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
      );
    case "enum":
      return (
        <select
          className="mcp-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "number":
      return (
        <input
          className="mcp-input"
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "text":
    case "json":
      return (
        <textarea
          className="mcp-input mcp-input-area"
          rows={field.kind === "json" ? 4 : 3}
          spellCheck={false}
          placeholder={field.kind === "json" ? "JSON" : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return (
        <input
          className="mcp-input"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** The form for one tool, its Run button, and the last thing it answered.
 *
 *  Keyed on the tool by the caller, so switching tools starts clean rather than
 *  carrying the previous tool's half-filled arguments into a different schema.
 */
function ToolRunner({
  serverKey,
  tool,
  onNotice,
}: {
  serverKey: string;
  tool: ipc.McpTool;
  onNotice?: (message: string) => void;
}) {
  const fields = useMemo(() => fieldsOf(tool.input_schema), [tool.input_schema]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialValues(fields),
  );
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState("{}");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ipc.McpCallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSchema, setShowSchema] = useState(false);

  const missing = missingRequired(fields, values);
  const badges = toolBadges(tool.annotations);

  const run = useCallback(() => {
    let args: Record<string, unknown>;
    if (raw) {
      try {
        const parsed = JSON.parse(rawText || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setError("Arguments must be a JSON object.");
          return;
        }
        args = parsed as Record<string, unknown>;
      } catch (e) {
        setError(`That isn't valid JSON: ${String(e)}`);
        return;
      }
    } else {
      args = toArguments(fields, values);
    }
    // The server's own word that this changes something. A test call is easy
    // to make by accident precisely because this panel makes calls easy.
    if (needsConfirm(tool.annotations)) {
      const ok = window.confirm(
        `${tool.name} is marked destructive by the server. Run it for real?`,
      );
      if (!ok) return;
    }
    setRunning(true);
    setError(null);
    ipc
      .mcpCallTool(serverKey, tool.name, args)
      .then(
        (r) => {
          setResult(r);
          setError(null);
        },
        (e) => {
          setResult(null);
          setError(String(e));
          onNotice?.(`${tool.name} failed`);
        },
      )
      .finally(() => setRunning(false));
  }, [fields, values, raw, rawText, serverKey, tool, onNotice]);

  /** Switching to raw carries the form's arguments over, so the JSON box opens
   *  on what you already filled in rather than on `{}`. */
  const toggleRaw = () => {
    if (!raw) setRawText(JSON.stringify(toArguments(fields, values), null, 2));
    setRaw((r) => !r);
  };

  const text = result ? renderContent(result.content) : "";

  return (
    <div className="mcp-tool-detail">
      <div className="mcp-tool-head">
        <h2 className="mcp-tool-name">{tool.title ?? tool.name}</h2>
        {tool.title && <code className="mcp-tool-id">{tool.name}</code>}
        {badges.map((b) => (
          <span key={b.label} className={`mcp-badge mcp-badge-${b.tone}`}>
            {b.label}
          </span>
        ))}
      </div>
      {tool.description && (
        <p className="mcp-tool-desc">{tool.description}</p>
      )}

      <div className="mcp-args-head">
        <span>Arguments</span>
        <button className="mcp-link-btn" onClick={toggleRaw}>
          {raw ? "form" : "raw JSON"}
        </button>
      </div>

      {raw ? (
        <textarea
          className="mcp-input mcp-input-area"
          rows={8}
          spellCheck={false}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
        />
      ) : fields.length === 0 ? (
        <p className="mcp-tool-desc mcp-dim">This tool takes no arguments.</p>
      ) : (
        <div className="mcp-fields">
          {fields.map((field) => (
            <label key={field.name} className="mcp-field">
              <span className="mcp-field-label">
                {field.name}
                {field.required && <span className="mcp-req">required</span>}
                <span className="mcp-field-type">
                  {field.options ? "enum" : field.kind}
                </span>
              </span>
              {field.description && (
                <span className="mcp-field-desc">{field.description}</span>
              )}
              <FieldInput
                field={field}
                value={values[field.name] ?? ""}
                onChange={(next) =>
                  setValues((prev) => ({ ...prev, [field.name]: next }))
                }
              />
            </label>
          ))}
        </div>
      )}

      <div className="mcp-run-row">
        <button
          className="btn btn-primary"
          disabled={running || (!raw && missing.length > 0)}
          title={
            missing.length > 0 && !raw
              ? `Fill in ${missing.join(", ")} first`
              : `Call ${tool.name} on this server`
          }
          onClick={run}
        >
          {running ? "Running…" : "Run"}
        </button>
        {result && (
          <span className="mcp-dim">{result.elapsed_ms} ms</span>
        )}
        <span className="status-spacer" />
        <button
          className="mcp-link-btn"
          onClick={() => setShowSchema((s) => !s)}
        >
          {showSchema ? "hide schema" : "schema"}
        </button>
      </div>

      {showSchema && (
        <pre className="mcp-schema">
          {JSON.stringify(tool.input_schema, null, 2)}
          {tool.output_schema
            ? `\n\n// output\n${JSON.stringify(tool.output_schema, null, 2)}`
            : ""}
        </pre>
      )}

      {/* A call that never happened and a tool that refused are different
          outcomes and are shown differently — the first is our problem, the
          second is the tool's answer. */}
      {error && <div className="mcp-error">{error}</div>}
      {result && (
        <div className={`mcp-result ${result.is_error ? "mcp-result-err" : ""}`}>
          <div className="mcp-result-head">
            {result.is_error ? "The tool returned an error" : "Result"}
          </div>
          {text && <pre className="mcp-result-body">{text}</pre>}
          {result.structured !== null && result.structured !== undefined && (
            <pre className="mcp-result-body">
              {JSON.stringify(result.structured, null, 2)}
            </pre>
          )}
          {!text && result.structured == null && (
            <div className="mcp-dim">The tool returned nothing.</div>
          )}
        </div>
      )}
    </div>
  );
}

export function McpView({ server, onNotice }: McpViewProps) {
  const [session, setSession] = useState<ipc.McpSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Survives StrictMode's double-mount, which would otherwise start the server
  // twice and leave one of them orphaned.
  const started = useRef(false);

  const connect = useCallback(
    (refresh: boolean) => {
      setConnecting(true);
      setError(null);
      ipc.mcpConnect(server.key, refresh).then(
        (s) => {
          setSession(s);
          setConnecting(false);
          setSelected((prev) =>
            prev && s.tools.some((t) => t.name === prev)
              ? prev
              : (s.tools[0]?.name ?? null),
          );
        },
        (e) => {
          setError(String(e));
          setConnecting(false);
        },
      );
    },
    [server.key],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    connect(false);
  }, [connect]);

  const tools = useMemo(() => {
    const all = session?.tools ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (t) =>
        t.name.toLowerCase().includes(needle) ||
        (t.description ?? "").toLowerCase().includes(needle),
    );
  }, [session, filter]);

  const current = session?.tools.find((t) => t.name === selected) ?? null;

  return (
    <div className="mcp-view">
      <div className="mcp-view-head">
        <div className="mcp-view-title">
          <PlugIcon size={15} className="mcp-view-mark" />
          <span>{server.name}</span>
          {session?.server_name && session.server_name !== server.name && (
            // The server's own name for itself. Worth showing when it differs:
            // it is the identity the tools actually belong to.
            <span className="mcp-view-realname">{session.server_name}</span>
          )}
          {session?.server_version && (
            <span className="mcp-view-version">v{session.server_version}</span>
          )}
          <span className="status-spacer" />
          <button
            className="btn-icon"
            title="Restart this server and re-read its tools"
            disabled={connecting}
            onClick={() => connect(true)}
          >
            <RestartIcon size={13} />
          </button>
        </div>

        <div className="mcp-view-meta">
          <span className="mcp-view-transport">{server.transport}</span>
          <code className="mcp-view-launch" title={launchLine(server)}>
            {launchLine(server)}
          </code>
        </div>

        {/* Who reaches this server. The question the panel could only answer
            as a count now has room for the names. */}
        <div className="mcp-tags">
          {server.sources.map((s) => (
            <SourceTag
              key={`${s.agent}:${s.config_path}:${s.name}`}
              source={s}
              serverName={server.name}
            />
          ))}
          {server.env_keys.map((k) => (
            <span
              key={k}
              className="mcp-tag mcp-tag-env"
              title="An environment variable this server is given. Names only — Canopy never reads the values into the UI."
            >
              {k}
            </span>
          ))}
        </div>
      </div>

      {connecting && !session && (
        <div className="mcp-view-status">
          Starting {server.name}… the first run can take a while if the package
          has to be fetched.
        </div>
      )}

      {error && (
        <div className="mcp-view-status">
          <div className="mcp-error">{error}</div>
          <button className="btn" onClick={() => connect(true)}>
            Try again
          </button>
        </div>
      )}

      {session && (
        <div className="mcp-view-body">
          <div className="mcp-tool-list">
            <div className="mcp-tool-list-head">
              <input
                className="mcp-filter"
                placeholder={`Filter ${session.tools.length} tool${
                  session.tools.length === 1 ? "" : "s"
                }`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            {tools.map((tool) => (
              <button
                key={tool.name}
                className={`mcp-tool-row ${
                  tool.name === selected ? "mcp-tool-row-on" : ""
                }`}
                onClick={() => setSelected(tool.name)}
              >
                <span className="mcp-tool-row-name">{tool.name}</span>
                {tool.description && (
                  <span className="mcp-tool-row-desc">{tool.description}</span>
                )}
              </button>
            ))}
            {session.tools.length === 0 && (
              <div className="mcp-dim mcp-tool-empty">
                This server exposes no tools.
              </div>
            )}

            {/* Named for completeness: a server whose point is its resources
                looked empty when only tools were counted. Not driven from here
                — reading one is the agent's job, not the panel's. */}
            {session.resources.length > 0 && (
              <div className="mcp-sublist">
                <div className="mcp-sublist-head">
                  {session.resources.length} resource
                  {session.resources.length === 1 ? "" : "s"}
                </div>
                {session.resources.slice(0, 50).map((r) => (
                  <div key={r.uri ?? r.name} className="mcp-sublist-row" title={r.uri ?? ""}>
                    {r.name}
                  </div>
                ))}
              </div>
            )}
            {session.prompts.length > 0 && (
              <div className="mcp-sublist">
                <div className="mcp-sublist-head">
                  {session.prompts.length} prompt
                  {session.prompts.length === 1 ? "" : "s"}
                </div>
                {session.prompts.map((p) => (
                  <div key={p.name} className="mcp-sublist-row" title={p.description ?? ""}>
                    {p.name}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mcp-tool-pane">
            {session.instructions && (
              <details className="mcp-instructions">
                <summary>
                  <ChevronIcon /> What this server tells agents about itself
                </summary>
                <p>{session.instructions}</p>
              </details>
            )}
            {current ? (
              <ToolRunner
                // Remounts per tool: a fresh schema deserves a fresh form.
                key={current.name}
                serverKey={server.key}
                tool={current}
                onNotice={onNotice}
              />
            ) : (
              <div className="mcp-dim mcp-tool-empty">
                {session.tools.length === 0
                  ? "Nothing to call here."
                  : "Pick a tool."}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
