import { useState } from 'react';
import { Button, Checkbox, Segmented, TextInput } from '../components/ui';
import { CloudIcon, CopyIcon, DesktopIcon } from '../components/icons';
import { writeClipboardText } from '../terminalClipboard';
import { RemoteExecutionClient, type RemoteWorkspace } from './client';
import { CANOPY_HOST_COMMAND, connectError, maskedLink, parseConnectLink, routeLabel } from './connectLink';
import { CreateWorkspace } from './CreateWorkspace';
import { ManagedWorkspaces } from './ManagedWorkspaces';

type Host = { endpoint: string; token: string };
export type OpenMachine = (workspace: RemoteWorkspace, host: Host, copyAccounts: boolean) => Promise<void>;

/** "Add a workspace": a Canopy cloud workspace, or a machine running canopy-host. */
export function AddWorkspace({ onCancel, onCreated, onOpen }: { onCancel: () => void; onCreated: () => void; onOpen: OpenMachine }) {
  const [tab, setTab] = useState<'cloud' | 'machine'>('cloud');
  return <div className="workspace-tools add-workspace">
    <Segmented aria-label="Where it runs" value={tab} onChange={setTab} options={[
      { id: 'cloud', label: <span className="add-workspace-tab"><CloudIcon size={14}/>Canopy cloud</span> },
      { id: 'machine', label: <span className="add-workspace-tab"><DesktopIcon size={14}/>Your own machine</span> },
    ]}/>
    {tab === 'cloud'
      ? <><ManagedWorkspaces showList={false}/><CreateWorkspace onCreated={onCreated} onCancel={onCancel}/></>
      : <ConnectMachine onCancel={onCancel} onOpen={onOpen}/>}
  </div>;
}

function ConnectMachine({ onCancel, onOpen }: { onCancel: () => void; onOpen: OpenMachine }) {
  const [link, setLink] = useState('');
  const [copyAccounts, setCopyAccounts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choices, setChoices] = useState<{ host: Host; hostName?: string; workspaces: RemoteWorkspace[] } | null>(null);
  const [picked, setPicked] = useState('');
  const [copied, setCopied] = useState(false);
  let parsed: Host | null = null;
  try { parsed = link.trim() ? parseConnectLink(link) : null; } catch { parsed = null; }
  const shown = maskedLink(link);

  // The machine's own name reads better in the list than its folder ("work").
  const named = (workspace: RemoteWorkspace, hostName: string | undefined, count: number) =>
    hostName ? { ...workspace, name: count === 1 ? hostName : `${hostName} · ${workspace.name}` } : workspace;

  async function open(workspace: RemoteWorkspace, host: Host) {
    await onOpen(workspace, host, copyAccounts);
  }

  async function connect() {
    setError('');
    let host: Host;
    try { host = parseConnectLink(link); } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    setBusy(true);
    try {
      const listed = await new RemoteExecutionClient(host.endpoint, host.token).list();
      const workspaces = listed.workspaces;
      if (!workspaces.length) { setError('This machine has no workspaces you can open.'); return; }
      if (workspaces.length === 1) { await open(named(workspaces[0], listed.host, 1), host); return; }
      setChoices({ host, hostName: listed.host, workspaces });
      setPicked(workspaces[0].id);
    } catch (e) { setError(connectError(e, host.endpoint)); }
    finally { setBusy(false); }
  }

  async function openPicked() {
    if (!choices) return;
    const workspace = choices.workspaces.find(w => w.id === picked);
    if (!workspace) return;
    setBusy(true); setError('');
    try { await open(named(workspace, choices.hostName, choices.workspaces.length), choices.host); }
    catch (e) { setError(connectError(e, choices.host.endpoint)); }
    finally { setBusy(false); }
  }

  if (choices) {
    const host = new URL(choices.host.endpoint).hostname;
    return <div className="add-workspace-machine">
      <p className="add-workspace-ok" role="status">✓ Connected to {host}</p>
      <fieldset className="add-workspace-choices">
        <legend>Which workspace do you want to open?</legend>
        {choices.workspaces.map(w => <label key={w.id} className={picked === w.id ? 'is-selected' : undefined}>
          <input type="radio" name="add-workspace-pick" checked={picked === w.id} onChange={() => setPicked(w.id)}/>
          <span className="add-workspace-choice-name">{w.name}</span>
          {w.root && <code>{w.root}</code>}
        </label>)}
      </fieldset>
      {error && <p className="workspace-feedback error" role="alert">{error}</p>}
      <footer className="add-workspace-footer"><span/><div className="workspace-inline-actions">
        <Button disabled={busy} onClick={() => { setChoices(null); setError(''); }}>Back</Button>
        <Button variant="accent" disabled={busy || !picked} onClick={() => void openPicked()}>{busy ? 'Opening…' : 'Open'}</Button>
      </div></footer>
    </div>;
  }

  return <div className="add-workspace-machine">
    <ol className="add-workspace-steps">
      <li><strong>On the machine, run</strong>
        <div className="add-workspace-command"><code>{CANOPY_HOST_COMMAND}</code>
          <Button size="sm" variant="ghost" onClick={() => { void writeClipboardText(CANOPY_HOST_COMMAND).then(ok => { if (!ok) return; setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}><CopyIcon size={13}/> {copied ? 'Copied' : 'Copy'}</Button>
        </div>
        <small>Linux with Node 22. No root or Docker needed.</small>
      </li>
      <li><label htmlFor="add-workspace-link"><strong>Paste the link it prints</strong></label>
        <TextInput id="add-workspace-link" width="full" value={shown} placeholder="http://…/connect#token=…" autoComplete="off" spellCheck={false}
          // A hidden token can't be edited in place, so changing a link that shows one starts over.
          onChange={e => { const value = e.target.value; setError(''); setLink(shown !== link && value.includes('•') ? '' : value); }}
          onKeyDown={e => { if (e.key === 'Enter' && parsed && !busy) void connect(); }}/>
        {parsed && !error && <p className="add-workspace-ok">✓ {routeLabel(parsed.endpoint)}</p>}
        {busy && parsed && <p className="add-workspace-busy" role="status">Connecting to {new URL(parsed.endpoint).hostname}…</p>}
        {error && <p className="workspace-feedback error" role="alert">{error}</p>}
      </li>
    </ol>
    <Checkbox checked={copyAccounts} onChange={setCopyAccounts} label="Copy my Claude and Codex sign-ins to it"/>
    <footer className="add-workspace-footer"><span/><div className="workspace-inline-actions">
      <Button disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button variant="accent" disabled={busy || !link.trim()} onClick={() => void connect()}>{busy ? 'Connecting…' : error ? 'Try again' : 'Connect'}</Button>
    </div></footer>
  </div>;
}
