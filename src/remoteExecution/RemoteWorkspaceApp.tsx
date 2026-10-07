import { setExecutionMode } from "../executionMode";
import { useEffect, useRef, useState } from "react";
import { RemoteExecutionClient, type RemoteWorkspace, type RemoteSession } from "./client";
import { RemoteTerminal } from "./RemoteTerminal";
import { RemoteDesktop } from "./RemoteDesktop";

export function RemoteWorkspaceApp() {
  const [endpoint, setEndpoint] = useState(localStorage.getItem("canopy.remote-endpoint") ?? "http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [client, setClient] = useState<RemoteExecutionClient | null>(null);
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [writable, setWritable] = useState(false);
  const [principal, setPrincipal] = useState("");
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [buildCommand, setBuildCommand] = useState("npm run build");
  const [inspection, setInspection] = useState("");
  const [analysis, setAnalysis] = useState("");
  const [command, setCommand] = useState("/bin/bash");
  const [account, setAccount] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [directory, setDirectory] = useState(".");
  const [files, setFiles] = useState<{ name: string; directory: boolean }[]>([]);
  const [file, setFile] = useState("");
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const dirty = text !== savedText;
  const spawnIntent = useRef<{ key: string; requestId: string } | null>(null);
  const version = useRef(0);
  const workspace = workspaces.find(w => w.id === workspaceId);

  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);

  useEffect(() => {
    if (!client || !workspaceId) return;
    version.current++;
    let cancelled = false;
    let timer: number | undefined;
    setSessions([]); setSessionId(null); setDesktop(false); setAccount("");
    setInspection(""); setAnalysis(""); setDirectory("."); setFile(""); setText(""); setSavedText(""); setFiles([]);
    const poll = async () => {
      try {
        const items = await client.workspace<RemoteSession[]>(workspaceId, "/sessions");
        if (!cancelled) { setSessions(items); setError(""); }
      } catch (err) { if (!cancelled) setError(String(err)); }
      finally { if (!cancelled) timer = window.setTimeout(() => void poll(), 5000); }
    };
    void client.workspace(workspaceId, "/open", {resume:true}).then(() => {
      if (!cancelled) void poll();
    }).catch(err => { if (!cancelled) { setError(String(err)); void poll(); } });
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [client, workspaceId]);

  useEffect(() => {
    if (!client || !workspaceId) return;
    let cancelled = false;
    void client.workspace<{ name: string; directory: boolean }[]>(workspaceId, "/files/list", { path: directory })
      .then(items => { if (!cancelled) setFiles(items); }).catch(err => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [client, workspaceId, directory]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); } catch (err) { setError(String(err)); } finally { setBusy(false); }
  };
  const startCommand = async (requested: string, kind = "terminal") => {
    if (!client) return;
    const key = JSON.stringify([workspaceId, requested, account, kind]);
    if (spawnIntent.current?.key !== key) spawnIntent.current = { key, requestId: crypto.randomUUID() };
    const generation = version.current;
    const session = await client.workspace<RemoteSession>(workspaceId, "/sessions", { command: requested, kind, accountId: account || undefined, requestId: spawnIntent.current.requestId });
    spawnIntent.current = null;
    if (generation !== version.current) return;
    setSessions(items => [...items.filter(item => item.id !== session.id), session]); setSessionId(session.id); setDesktop(false);
  };
  const discard = () => !dirty || window.confirm("Discard the unsaved remote file changes?");
  return <main className="remote-app">
    <header className="remote-header"><strong>Canopy</strong><span>Remote execution</span>
      <span className="remote-spacer" />
      {client && <><span>{principal}</span><button onClick={() => { if (discard()) { version.current++; setClient(null); setWorkspaces([]); setWorkspaceId(""); setSessions([]); setDesktop(false); } }}>Disconnect</button></>}
      <button onClick={() => { if (discard()) { void run(() => setExecutionMode("local")); } }}>Local IDE</button>
    </header>
    {!client ? <form className="remote-login" onSubmit={event => { event.preventDefault(); void run(async () => {
      const connection = new RemoteExecutionClient(endpoint, token);
      const result = await connection.list();
      localStorage.setItem("canopy.remote-endpoint", connection.endpoint);
      setToken(""); setPrincipal(result.principal); setWritable(result.scope !== "view"); setWorkspaces(result.workspaces);
      setWorkspaceId(result.workspaces[0]?.id ?? ""); setClient(connection);
    }); }}>
      <h1>Your workspace, on your host</h1><p>Agents, repositories, and accounts stay on the Linux VM. This client displays only the work you open.</p>
      <label>Host endpoint<input value={endpoint} onChange={event => setEndpoint(event.target.value)} required /></label>
      <label>Access token<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required /></label>
      <button disabled={busy}>Connect</button>
    </form> : <>
      <nav className="remote-toolbar">
        <label>Workspace <select disabled={busy} value={workspaceId} onChange={event => { if (discard()) { version.current++; setWorkspaceId(event.target.value); } }}>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {workspace && <span>{workspace.memoryMiB} MiB · {workspace.cpus} CPUs</span>}
        <button disabled={!workspaceId || !writable} onClick={() => setDesktop(!desktop)}>{desktop ? "Close desktop" : "Open desktop"}</button>
        {writable && <><label>Account <select value={account} onChange={event => setAccount(event.target.value)}><option value="">Workspace account</option>{workspace?.accounts.map(id => <option key={id}>{id}</option>)}</select></label>
          <input aria-label="Agent or shell command" value={command} onChange={event => setCommand(event.target.value)} />
          <button disabled={busy || !workspaceId || !command.trim()} onClick={() => void run(() => startCommand(command))}>Start agent / shell</button>
          <input aria-label="Remote build command" value={buildCommand} onChange={event => setBuildCommand(event.target.value)} />
          <button disabled={busy || !workspaceId || !buildCommand.trim()} onClick={() => void run(() => startCommand(buildCommand, "build"))}>Run build</button>
          <button disabled={busy || sessionId == null || sessions.find(s => s.id === sessionId)?.exitCode != null} onClick={() => void run(async () => { await client.workspace(workspaceId, `/sessions/${sessionId}/stop`, {}); })}>Stop selected</button></>}
        <button disabled={busy || !workspaceId} onClick={() => void run(async () => {
          const generation = version.current;
          const status = await client.workspace<{ text: string }>(workspaceId, "/git/status", {});
          const diff = await client.workspace<{ text: string }>(workspaceId, "/git/diff", {});
          if (generation === version.current) setInspection([status.text, diff.text].filter(Boolean).join("\n") || "Working tree clean");
        })}>Git changes</button>
      </nav>
      <div className="remote-body">
        <aside className="remote-sidebar"><h2>Sessions</h2>{sessions.map(session => <button className={sessionId === session.id ? "selected" : ""} key={session.id} onClick={() => { setSessionId(session.id); setDesktop(false); }}>{session.kind === "build" ? "Build: " : ""}{session.title}<small>{session.exitCode == null ? "Running" : session.exitCode === -1 ? "Interrupted by host restart" : `Exited ${session.exitCode}`}</small></button>)}
          <h2>Files</h2><button disabled={busy} onClick={() => { if (discard()) setDirectory(directory.split("/").slice(0, -1).join("/") || "."); }}>↑ Parent</button>
          <small>{directory}</small>{files.map(entry => <button disabled={busy} key={entry.name} onClick={() => {
            if (!discard()) return;
            const next = `${directory}/${entry.name}`;
            if (entry.directory) setDirectory(next);
            else void run(async () => {
              const generation = version.current;
              const result = await client.workspace<{ text: string }>(workspaceId, "/files/read", { path: next });
              if (generation !== version.current) return;
              setAnalysis(""); setFile(next); setText(result.text); setSavedText(result.text); setDesktop(false);
            });
          }}>{entry.directory ? "▸ " : ""}{entry.name}</button>)}
        </aside>
        <section className="remote-content">
          {desktop ? <RemoteDesktop key={workspaceId} client={client} workspaceId={workspaceId} /> : sessionId != null ? <RemoteTerminal key={`${workspaceId}:${sessionId}`} client={client} workspaceId={workspaceId} sessionId={sessionId} writable={writable} /> : <div className="remote-empty">Choose a session or start an agent. Closing Canopy does not stop remote work.</div>}
          {inspection && <section className="remote-inspection"><button onClick={() => setInspection("")}>Close Git changes</button><pre>{inspection}</pre></section>}
          {file && !desktop && <section className="remote-file"><div><strong>{file}{dirty ? " •" : ""}</strong><button disabled={!writable || busy || !/\.[cm]?[jt]sx?$/.test(file)} onClick={() => void run(async () => {
            const generation = version.current;
            const result = await client.workspace<{ diagnostics: { range: { start: { line: number; character: number } }; message: string }[]; complete: boolean }>(workspaceId, "/language/analyze", { path: file, text });
            if (generation === version.current) setAnalysis(result.diagnostics.map(d => `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`).join("\n") || (result.complete ? "No diagnostics" : "Analysis deadline reached; diagnostics are incomplete"));
          })}>Check file</button><button disabled={!writable || busy || !dirty} onClick={() => void run(async () => {
            const generation = version.current; const written = text;
            await client.workspace(workspaceId, "/files/write", { path: file, text: written });
            if (generation === version.current) setSavedText(written);
          })}>Save</button><button disabled={busy} onClick={() => { if (discard()) { setFile(""); setText(""); setSavedText(""); } }}>Close file</button></div><textarea aria-label={`Remote file ${file}`} readOnly={!writable} value={text} onChange={event => setText(event.target.value)} spellCheck={false} />{analysis && <pre className="remote-diagnostics">{analysis}</pre>}</section>}
        </section>
      </div>
    </>}
    {error && <div className="remote-error" role="alert">{error}</div>}
  </main>;
}
