// A T3 Code machine in Canopy: its projects, a file tree from
// projects.listEntries, files in Canopy's Monaco editor (saved through
// projects.writeFile), and terminals. A surface of its own, like
// RemoteWorkspaceApp, rather than a mode of ProjectView.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui";
import { CloseIcon, RestartIcon } from "../components/icons";
import { MonacoEditor } from "../components/MonacoEditor";
import { basename } from "../paths";
import { monaco } from "../monaco-setup";
import { connectT3Machine, grants, type T3Machine } from "./api";
import type { OrchestrationProjectShell, ProjectEntry } from "./contracts";
import { CANOPY_TERMINAL_THREAD_ID, listProjects, t3 } from "./methods";
import type { T3RpcClient } from "./rpc";
import { T3Terminal } from "./T3Terminal";
import { AGENT_CLIS } from "../projects";
import "./t3connect.css";

type View = { kind: "file"; path: string } | { kind: "terminal"; id: string } | null;

interface OpenFile {
  readonly path: string;
  readonly model: monaco.editor.ITextModel;
  readonly readOnly: boolean;
  readonly note: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function FileTree({ rpc, cwd, directory, depth, onOpen, selected }: {
  rpc: T3RpcClient; cwd: string; directory: string; depth: number; onOpen: (path: string) => void; selected: string | null;
}) {
  const [entries, setEntries] = useState<ProjectEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    t3.listEntries(rpc, { cwd, directoryPath: directory }).then(result => {
      if (cancelled) return;
      const sorted = [...result.entries].sort((a, b) =>
        a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "directory" ? -1 : 1);
      setEntries(sorted);
      setTruncated(result.truncated);
    }, error => { if (!cancelled) setError(message(error)); });
    return () => { cancelled = true; };
  }, [rpc, cwd, directory]);
  if (error) return <div className="t3-tree-note" role="alert" style={{ paddingLeft: depth * 12 }}>{error}</div>;
  if (!entries) return <div className="t3-tree-note" style={{ paddingLeft: depth * 12 }}>Loading…</div>;
  return <ul className="t3-tree" role={depth === 0 ? "tree" : "group"}>
    {entries.map(entry => {
      const name = basename(entry.path) || entry.path;
      const expanded = open.has(entry.path);
      return <li key={entry.path} role="treeitem" aria-expanded={entry.kind === "directory" ? expanded : undefined} aria-selected={selected === entry.path}>
        <button type="button" className={`t3-tree-row${selected === entry.path ? " is-selected" : ""}${entry.ignored ? " is-ignored" : ""}`} style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => {
            if (entry.kind === "file") { onOpen(entry.path); return; }
            setOpen(current => {
              const next = new Set(current);
              if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
              return next;
            });
          }}>
          <span aria-hidden="true" className="t3-tree-mark">{entry.kind === "directory" ? (expanded ? "▾" : "▸") : ""}</span>{name}
        </button>
        {entry.kind === "directory" && expanded && <FileTree rpc={rpc} cwd={cwd} directory={entry.path} depth={depth + 1} onOpen={onOpen} selected={selected} />}
      </li>;
    })}
    {truncated && <li className="t3-tree-note" style={{ paddingLeft: 8 + depth * 12 }}>More entries not shown</li>}
  </ul>;
}

export function T3MachineView({ machine, onClose }: { machine: T3Machine; onClose: () => void }) {
  const [rpc, setRpc] = useState<T3RpcClient | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState("");
  const [projects, setProjects] = useState<OrchestrationProjectShell[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [view, setView] = useState<View>(null);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [terminals, setTerminals] = useState<string[]>([]);
  /** Terminals opened as an agent: what to type, and the tab's name. */
  const [agentTabs, setAgentTabs] = useState<Record<string, { label: string; command: string }>>({});
  const [agentId, setAgentId] = useState<string>(() => {
    try { return localStorage.getItem("canopy.t3Agent") ?? ""; } catch { return ""; }
  });
  const fileRef = useRef<OpenFile | null>(null);
  fileRef.current = file;
  const canRead = grants(machine, "filesystem:read");
  const canWrite = grants(machine, "filesystem:write");
  const canTerminal = grants(machine, "terminal:operate");
  const project = projects?.find(item => item.id === projectId) ?? null;

  useEffect(() => {
    let cancelled = false;
    let client: T3RpcClient | null = null;
    setStatus("Connecting…"); setError(""); setRpc(null);
    connectT3Machine(machine.id).then(connected => {
      client = connected;
      if (cancelled) { connected.close(); return; }
      connected.onClose(reason => { if (!cancelled) { setStatus("Disconnected"); setError(reason); setRpc(null); } });
      setRpc(connected);
      setStatus("Connected");
      return listProjects(connected).then(items => {
        if (cancelled) return;
        setProjects(items);
        setProjectId(current => current && items.some(item => item.id === current) ? current : items[0]?.id ?? null);
      });
    }).catch(error => { if (!cancelled) { setStatus("Not connected"); setError(message(error)); } });
    return () => { cancelled = true; client?.close(); };
  }, [machine.id, attempt]);

  useEffect(() => () => fileRef.current?.model.dispose(), []);

  const discardOk = () => !dirty || window.confirm(`Discard unsaved changes to ${file?.path}?`);
  const closeFile = () => { file?.model.dispose(); setFile(null); setDirty(false); };

  const openFile = useCallback(async (path: string) => {
    if (!rpc || !project) return;
    if (fileRef.current?.path === path) { setView({ kind: "file", path }); return; }
    setError("");
    try {
      const result = await t3.readFile(rpc, { cwd: project.workspaceRoot, relativePath: path });
      fileRef.current?.model.dispose();
      const uri = monaco.Uri.from({ scheme: "t3", authority: machine.environmentId, path: `/${project.id}/${path}` });
      monaco.editor.getModel(uri)?.dispose();
      const model = monaco.editor.createModel(result.contents, undefined, uri);
      const readOnly = !canWrite || result.truncated;
      setFile({ path, model, readOnly, note: result.truncated ? `Read-only: showing the first ${result.contents.length.toLocaleString()} characters of ${result.byteLength.toLocaleString()} bytes` : !canWrite ? "Read-only: this machine did not grant filesystem:write" : "" });
      setDirty(false);
      setView({ kind: "file", path });
    } catch (error) {
      setError(message(error));
    }
  }, [rpc, project, machine.environmentId, canWrite]);

  const save = useCallback(async () => {
    const current = fileRef.current;
    if (!rpc || !project || !current || current.readOnly) return;
    setSaving(true); setError("");
    const contents = current.model.getValue();
    try {
      await t3.writeFile(rpc, { cwd: project.workspaceRoot, relativePath: current.path, contents });
      if (fileRef.current === current && current.model.getValue() === contents) setDirty(false);
    } catch (error) {
      setError(message(error));
    } finally {
      setSaving(false);
    }
  }, [rpc, project]);

  const newTerminal = (agent?: { name: string; bin: string }) => {
    const id = `canopy-${crypto.randomUUID().slice(0, 8)}`;
    if (agent) setAgentTabs(tabs => ({ ...tabs, [id]: { label: agent.name, command: agent.bin } }));
    setTerminals(items => [...items, id]);
    setView({ kind: "terminal", id });
  };
  const closeTerminal = (id: string) => {
    if (rpc) void t3.terminalClose(rpc, { threadId: CANOPY_TERMINAL_THREAD_ID, terminalId: id, deleteHistory: true }).catch(error => setError(message(error)));
    setTerminals(items => items.filter(item => item !== id));
    setView(current => current?.kind === "terminal" && current.id === id ? null : current);
  };

  const agentChoice = AGENT_CLIS.find(cli => cli.id === agentId) ?? AGENT_CLIS[0] ?? { id: "", name: "Agent", bin: "" };

  const tabs = useMemo(() => [
    ...(file ? [{ key: `file:${file.path}`, label: `${basename(file.path)}${dirty ? " •" : ""}`, view: { kind: "file", path: file.path } as View }] : []),
    ...terminals.map((id, index) => ({ key: `terminal:${id}`, label: agentTabs[id]?.label ?? `Terminal ${index + 1}`, view: { kind: "terminal", id } as View })),
  ], [file, dirty, terminals, agentTabs]);

  return <div className="t3-machine">
    <div className="side-panel-head">
      <span className="remote-desktop-heading"><span>T3 Code · {machine.label}</span><span role="status">{status}</span></span>
      <span className="side-head-actions">
        <Button size="sm" variant="ghost" icon title="Reconnect" aria-label="Reconnect to the T3 machine" onClick={() => { if (discardOk()) { closeFile(); setTerminals([]); setView(null); setAttempt(value => value + 1); } }}><RestartIcon /></Button>
        <Button size="sm" variant="ghost" icon title="Close" aria-label="Close T3 machine" onClick={() => { if (discardOk()) onClose(); }}><CloseIcon /></Button>
      </span>
    </div>
    <div className="t3-machine-body">
      <aside className="t3-machine-sidebar" aria-label="Projects and files">
        <h3>Projects</h3>
        {projects === null ? <p className="t3-tree-note">{rpc ? "Loading…" : "—"}</p>
          : projects.length === 0 ? <p className="t3-tree-note">No projects on this machine yet. Add one in T3 Code.</p>
            : <div className="t3-projects">{projects.map(item => <button type="button" key={item.id} title={item.workspaceRoot}
              className={`t3-tree-row${item.id === projectId ? " is-selected" : ""}`}
              onClick={() => { if (item.id !== projectId && discardOk()) { closeFile(); setView(null); setProjectId(item.id); } }}>{item.title}</button>)}</div>}
        {project && <>
          <h3>Files</h3>
          {!canRead ? <p className="t3-tree-note">This machine did not grant filesystem:read.</p>
            : rpc && <FileTree key={`${project.id}:${attempt}`} rpc={rpc} cwd={project.workspaceRoot} directory="" depth={0} selected={file?.path ?? null} onOpen={path => { if (path === file?.path || discardOk()) void openFile(path); }} />}
        </>}
      </aside>
      <section className="t3-machine-main">
        <div className="t3-machine-tabs" role="tablist" aria-label="Open files and terminals">
          {tabs.map(tab => <span key={tab.key} className={`t3-machine-tab${JSON.stringify(view) === JSON.stringify(tab.view) ? " is-active" : ""}`}>
            <button type="button" role="tab" aria-selected={JSON.stringify(view) === JSON.stringify(tab.view)} onClick={() => setView(tab.view)}>{tab.label}</button>
            <button type="button" aria-label={`Close ${tab.label}`} onClick={() => {
              if (tab.view?.kind === "terminal") closeTerminal(tab.view.id);
              else if (discardOk()) { closeFile(); setView(null); }
            }}>×</button>
          </span>)}
          <span className="t3-spacer" />
          {file && view?.kind === "file" && !file.readOnly && <Button size="sm" disabled={!dirty || saving || !rpc} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>}
          <Button size="sm" variant="ghost" disabled={!rpc || !project || !canTerminal} title={canTerminal ? "Open a shell in this project on the T3 machine" : "This machine did not grant terminal:operate"} onClick={() => newTerminal()}>＋ Terminal</Button>
          {canTerminal && AGENT_CLIS.length > 0 && (
            <>
              <select className="t3-agent-select" aria-label="Agent CLI to launch on the T3 machine" value={agentChoice.id} onChange={event => { setAgentId(event.target.value); try { localStorage.setItem("canopy.t3Agent", event.target.value); } catch { /* remembered only as a convenience */ } }}>
                {AGENT_CLIS.map(cli => <option key={cli.id} value={cli.id}>{cli.name}</option>)}
              </select>
              <Button size="sm" variant="ghost" disabled={!rpc || !project} title={`Open a shell in this project and start ${agentChoice.name} there. It must be installed on the T3 machine.`} onClick={() => newTerminal(agentChoice)}>＋ Agent</Button>
            </>
          )}
        </div>
        {file && view?.kind === "file" && file.note && <p className="t3-machine-note">{file.note}</p>}
        <div className="t3-machine-content">
          {file && <div className="t3-machine-pane" hidden={view?.kind !== "file"}><MonacoEditor active={view?.kind === "file"} model={file.model} readOnly={file.readOnly} onSave={() => void save()} onDirty={setDirty} /></div>}
          {rpc && project && terminals.map(id => <div key={id} className="t3-machine-pane" hidden={!(view?.kind === "terminal" && view.id === id)}><T3Terminal rpc={rpc} cwd={project.workspaceRoot} terminalId={id} writable={canTerminal} startup={agentTabs[id]?.command} /></div>)}
          {!view && <div className="remote-empty">{rpc ? "Pick a file, or open a terminal. Files and shells stay on the T3 machine." : error ? "Not connected." : "Connecting…"}</div>}
        </div>
      </section>
    </div>
    {error && <div className="workspace-feedback error" role="alert">{error}</div>}
  </div>;
}
