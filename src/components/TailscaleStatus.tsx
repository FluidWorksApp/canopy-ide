// Settings → Remote access → Tailscale (the control under the "Tailscale" Item
// in SettingsDialog.tsx). Canopy uses the Tailscale app already on this
// machine: it reads its status and can open the app, and never signs in or
// changes Tailscale (tailnet.rs). Allow is per machine, off by default, and
// means that machine may connect in to terminals here; connecting out needs no
// switch.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as ipc from "../ipc";
import { openLink } from "../links";
import { Button, Switch } from "./ui";
import "./tailscaleSettings.css";

const DOWNLOAD = "https://tailscale.com/download";
/** The row follows Tailscale while it is on screen; there is no refresh button. */
const POLL_MS = 5000;

function Status({ tone, label }: { tone: "ok" | "warn" | "off"; label: string }) {
  return (
    <span className={`ts-status ts-status-${tone}`}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

const shortVersion = (v: string) => v.replace(/\.0$/, "");

export function TailscaleStatus({ pollMs = POLL_MS }: { pollMs?: number }) {
  const [view, setView] = useState<ipc.TailscaleView | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Bumped by every change made here, so a poll that started before it cannot
  // put the old answer back.
  const generation = useRef(0);
  const alive = useRef(true);

  const refresh = useCallback(async (force = false) => {
    if (inFlight.current && !force) return;
    inFlight.current = true;
    const started = generation.current;
    try {
      const next = await ipc.tailscaleStatus();
      if (alive.current && started === generation.current) {
        setView(next);
        setFailed(false);
      }
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [refresh, pollMs]);

  const setAllowed = async (machine: ipc.TailscaleMachine, allowed: boolean) => {
    const id = machine.stableId;
    if (!id) return;
    setPending(id);
    setError(null);
    try {
      await ipc.tailscaleAllowSet(id, allowed);
      generation.current += 1;
      setView((v) =>
        v && { ...v, machines: v.machines.map((m) => (m.stableId === id ? { ...m, allowed } : m)) },
      );
      void refresh(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(null);
    }
  };

  const openApp = () => {
    setError(null);
    void ipc
      .tailscaleOpenApp()
      .then(() => refresh(true))
      .catch((e) => setError(String(e)));
  };

  if (!view) {
    return failed ? (
      <span className="set-warn">Couldn't check Tailscale.</span>
    ) : (
      <span className="set-note">Checking…</span>
    );
  }

  const openButton = view.canOpenApp ? (
    <Button size="sm" onClick={openApp}>
      Open Tailscale
    </Button>
  ) : (
    <span className="set-note">Start Tailscale on this machine.</span>
  );
  const errorNote = error && (
    <span className="set-warn" role="alert">
      {error}
    </span>
  );

  switch (view.kind) {
    case "notInstalled":
      return (
        <div className="set-inline">
          <Status tone="off" label="Not installed" />
          <Button size="sm" onClick={() => openLink(DOWNLOAD, true)}>
            Get Tailscale ↗
          </Button>
        </div>
      );
    case "off":
      return (
        <div className="set-inline">
          <Status tone="off" label="Tailscale is off" />
          {openButton}
          {errorNote}
        </div>
      );
    case "needsLogin":
      return (
        <div className="set-inline">
          <Status tone="warn" label="Needs login" />
          <span className="set-warn">Sign in from the Tailscale app.</span>
          {openButton}
          {errorNote}
        </div>
      );
    case "needsApproval":
      return (
        <div className="set-inline">
          <Status tone="warn" label="Needs approval" />
          <span className="set-warn">An admin must approve this machine.</span>
          {openButton}
          {errorNote}
        </div>
      );
    case "starting":
      return (
        <div className="set-inline">
          <Status tone="off" label="Starting…" />
        </div>
      );
    case "tooOld":
      return (
        <div className="set-inline">
          <Status tone="warn" label="Too old" />
          {view.version && <span className="ts-mono">v{view.version}</span>}
          <span className="set-warn">Needs v{shortVersion(view.minVersion)} or newer.</span>
          <Button size="sm" onClick={() => openLink(DOWNLOAD, true)}>
            Update ↗
          </Button>
        </div>
      );
    case "running":
      return <Running view={view} pending={pending} errorNote={errorNote} onAllow={setAllowed} />;
  }
}

function Running({
  view,
  pending,
  errorNote,
  onAllow,
}: {
  view: ipc.TailscaleView;
  pending: string | null;
  errorNote: ReactNode;
  onAllow: (machine: ipc.TailscaleMachine, allowed: boolean) => void;
}) {
  const online = view.machines.filter((m) => m.online);
  const offline = view.machines.length - online.length;
  const me = view.thisMachine;
  return (
    <div className="ts-running">
      <div className="set-inline">
        <Status tone="ok" label="Running" />
        {view.version && <span className="ts-mono">v{view.version}</span>}
        {errorNote}
      </div>
      {me && (
        <div className="ts-me">
          <span className="ts-me-label">This machine</span>
          <span className="ts-me-name">{me.name}</span>
          <span className="ts-mono">{me.dnsName}</span>
          {me.ip && <span className="ts-mono">{me.ip}</span>}
        </div>
      )}
      {view.allowError && <span className="set-warn">{view.allowError}</span>}
      <div className="resume-block ts-machines">
        <div className="resume-head">
          <span>
            Online <span className="badge">{online.length}</span>
          </span>
          <span className="ts-col" title="May connect in to terminals on this machine">
            Allow
          </span>
        </div>
        {online.length === 0 && <div className="resume-row ts-empty">No other machines online.</div>}
        {online.map((m) => (
          <div className="resume-row" key={m.stableId ?? m.dnsName}>
            <span className="ts-dot" aria-hidden="true" />
            <span className="resume-prompt ts-name">{m.name}</span>
            <span className="resume-dir">{m.ip ? `${m.dnsName} · ${m.ip}` : m.dnsName}</span>
            <Switch
              checked={m.allowed}
              disabled={!m.stableId || !!view.allowError || pending === m.stableId}
              aria-label={`Allow ${m.name}`}
              onChange={(next) => onAllow(m, next)}
            />
            <span className="ts-connect" title="Coming soon">
              <Button size="sm" disabled>
                Connect
              </Button>
            </span>
          </div>
        ))}
        {offline > 0 && <div className="ts-foot">{offline} offline</div>}
      </div>
    </div>
  );
}
