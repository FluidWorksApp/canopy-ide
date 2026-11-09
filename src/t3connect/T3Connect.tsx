// "Connect to a T3 Code machine…": paste a pairing link, see which machine it
// reaches, then save it. Saved machines open in T3MachineView.
import { useEffect, useState } from "react";
import { Button, TextInput } from "../components/ui";
import { describeT3Link, listT3Machines, pairT3Machine, removeT3Machine, type T3Machine, type T3Preview } from "./api";
import { parseT3PairingLink } from "./pairing";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function T3Connect({ onOpen }: { onOpen: (machine: T3Machine) => void }) {
  const [machines, setMachines] = useState<T3Machine[]>([]);
  const [link, setLink] = useState("");
  const [preview, setPreview] = useState<T3Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    listT3Machines().then(items => { if (!cancelled) setMachines(items); }, error => { if (!cancelled) setError(message(error)); });
    return () => { cancelled = true; };
  }, []);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const check = () => run(async () => {
    // Parsed here first so a typo is named before anything is contacted.
    parseT3PairingLink(link);
    setPreview(await describeT3Link(link.trim()));
  });
  const save = () => run(async () => {
    if (!preview) return;
    const saved = await pairT3Machine(link.trim(), preview.environmentId);
    setMachines(items => [...items.filter(item => item.id !== saved.id && item.httpBaseUrl !== saved.httpBaseUrl), saved]);
    setLink(""); setPreview(null);
    setNotice(`${saved.label} saved. Its access token is in this computer's credential store.`);
  });

  return <div className="t3-connect">
    <p className="workspace-description">Paste a pairing link from T3 Code (Settings → Connections, or <code>t3 pair</code>). It works over any network that reaches the machine: LAN, Tailscale, a tunnel or a T3 Connect address. No T3 account is needed.</p>
    <label>Pairing link<TextInput width="full" type="url" autoComplete="off" spellCheck={false} placeholder="https://…/pair#token=…" value={link} disabled={busy}
      onChange={event => { setLink(event.target.value); setPreview(null); setError(""); }} /></label>
    {!preview ? <Button disabled={busy || !link.trim()} onClick={() => void check()}>{busy ? "Checking…" : "Check link"}</Button>
      : <div className="t3-connect-preview" role="group" aria-label="T3 machine found">
        <div><strong>{preview.label}</strong><small>{preview.httpBaseUrl} · T3 Code {preview.serverVersion}{preview.platform?.os ? ` · ${preview.platform.os}` : ""}</small></div>
        <div className="workspace-inline-actions">
          <Button variant="accent" disabled={busy} onClick={() => void save()}>{busy ? "Connecting…" : `Connect to ${preview.label}`}</Button>
          <Button disabled={busy} onClick={() => setPreview(null)}>Cancel</Button>
        </div>
      </div>}
    {notice && <p className="workspace-feedback" role="status">✓ {notice}</p>}
    {error && <p className="workspace-feedback error" role="alert">{error}</p>}
    {machines.length > 0 && <ul className="t3-connect-list" aria-label="Saved T3 machines">
      {machines.map(machine => <li key={machine.id}>
        <div><strong>{machine.label}</strong><small>{machine.httpBaseUrl}</small></div>
        <Button size="sm" variant="accent" disabled={busy} onClick={() => onOpen(machine)}>Open</Button>
        <Button size="sm" disabled={busy} onClick={() => void run(async () => {
          await removeT3Machine(machine.id);
          setMachines(items => items.filter(item => item.id !== machine.id));
        })}>Remove</Button>
      </li>)}
    </ul>}
  </div>;
}
