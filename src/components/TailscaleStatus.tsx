// Settings → Remote access → Tailscale (the control under the "Tailscale" Item
// in SettingsDialog.tsx). Canopy uses the Tailscale app already on this
// machine: it reads its status and can open the app, and never signs in or
// changes Tailscale (tailnet.rs). Allow is per machine, off by default, and
// means that machine may read and type into every terminal here (full trust),
// while Canopy runs; connecting out needs no switch. Connect opens the other
// machine's terminal list inline (commands in ipc.ts, state in
// tailnetRemote.ts); an opened terminal is a normal tab.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as ipc from "../ipc";
import { openLink } from "../links";
import { Button, Switch } from "./ui";
import {
  clearNotice,
  closeLink,
  linkFor,
  registerLink,
  TAILNET_OPEN_EVENT,
  useTailnetRemote,
  type TailnetOpenDetail,
} from "../tailnetRemote";
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

/** Why allowed machines cannot connect, when the listener could not start. */
function listenerProblem(l: ipc.TailscaleListener | undefined): string | null {
  switch (l?.state) {
    case "portInUse":
      return `Another program is using port ${l.port}, so allowed machines can't connect.`;
    case "noInterface":
      return "Tailscale has no network interface on this machine (userspace mode), so allowed machines can't connect.";
    case "unavailable":
      return "Canopy couldn't start listening for allowed machines.";
    default:
      return null;
  }
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
      return (
        <Running
          view={view}
          pending={pending}
          errorNote={errorNote}
          onAllow={setAllowed}
          onOpenApp={openApp}
          pollMs={pollMs}
        />
      );
  }
}

function Running({
  view,
  pending,
  errorNote,
  onAllow,
  onOpenApp,
  pollMs,
}: {
  view: ipc.TailscaleView;
  pending: string | null;
  errorNote: ReactNode;
  onAllow: (machine: ipc.TailscaleMachine, allowed: boolean) => void;
  onOpenApp: () => void;
  pollMs: number;
}) {
  const online = view.machines.filter((m) => m.online);
  const offline = view.machines.length - online.length;
  const me = view.thisMachine;
  const problem = listenerProblem(view.listener);
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
          <span
            className="ts-col"
            title="An allowed machine can read and type into every terminal on this machine"
          >
            Allow
          </span>
        </div>
        <div className="ts-foot">
          An allowed machine can read and type into every terminal on this machine, as you. Only
          allow machines you fully trust. It works only while Canopy is running.
        </div>
        {online.length === 0 && <div className="resume-row ts-empty">No other machines online.</div>}
        {online.map((m) => (
          <MachineRow
            key={m.stableId ?? m.dnsName}
            machine={m}
            view={view}
            pending={pending}
            onAllow={onAllow}
            onOpenApp={onOpenApp}
            pollMs={pollMs}
          />
        ))}
        {offline > 0 && <div className="ts-foot">{offline} offline</div>}
        {problem && online.some((m) => m.allowed) && (
          <div className="ts-foot set-warn" role="status">
            {problem}
          </div>
        )}
      </div>
    </div>
  );
}

type Conn =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; terminals: ipc.TailnetRemoteTerminal[] }
  | { kind: "failed"; reason: ipc.TailnetRemoteError };

/** Anything but the two named reasons is "didn't accept": no listener and a
 *  refusal look the same here on purpose (a stranger must not learn whether
 *  Allow is on), and so does a build whose backend has no such command yet. */
function failureOf(e: unknown): ipc.TailnetRemoteError {
  const text = e instanceof Error ? e.message : String(e);
  if (text.includes("tailscale_off")) return "tailscale_off";
  if (text.includes("older_canopy")) return "older_canopy";
  return "refused";
}

function MachineRow({
  machine: m,
  view,
  pending,
  onAllow,
  onOpenApp,
  pollMs,
}: {
  machine: ipc.TailscaleMachine;
  view: ipc.TailscaleView;
  pending: string | null;
  onAllow: (machine: ipc.TailscaleMachine, allowed: boolean) => void;
  onOpenApp: () => void;
  pollMs: number;
}) {
  const id = m.stableId;
  const { links, notices } = useTailnetRemote();
  const [conn, setConn] = useState<Conn>({ kind: "idle" });
  // A newer Connect, Disconnect or failure outranks a list still on its way.
  const attempt = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const notice = id ? notices[id] : undefined;
  const revoked = notice?.kind === "revoked";
  const state: Conn = revoked ? { kind: "idle" } : conn;

  const connect = async () => {
    if (!id) return;
    const mine = ++attempt.current;
    clearNotice(id);
    setConn({ kind: "connecting" });
    try {
      const terminals = await ipc.tailnetRemoteList(id);
      if (alive.current && mine === attempt.current) setConn({ kind: "connected", terminals });
    } catch (e) {
      if (alive.current && mine === attempt.current) setConn({ kind: "failed", reason: failureOf(e) });
    }
  };

  const connected = state.kind === "connected";
  useEffect(() => {
    if (!connected || !id) return;
    const timer = window.setInterval(() => {
      const mine = attempt.current;
      ipc.tailnetRemoteList(id).then(
        (terminals) => {
          if (alive.current && mine === attempt.current) setConn({ kind: "connected", terminals });
        },
        (e) => {
          if (alive.current && mine === attempt.current) setConn({ kind: "failed", reason: failureOf(e) });
        },
      );
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [connected, id, pollMs]);

  const disconnect = () => {
    if (!id) return;
    attempt.current += 1;
    for (const link of links.values()) if (link.stableId === id) closeLink(link.ptyId);
    setConn({ kind: "idle" });
  };

  const open = async (t: ipc.TailnetRemoteTerminal) => {
    if (!id) return;
    const show = (ptyId: number) =>
      window.dispatchEvent(
        new CustomEvent<TailnetOpenDetail>(TAILNET_OPEN_EVENT, {
          detail: { ptyId, cwd: t.cwd, title: t.title, machine: m.name },
        }),
      );
    // Already open here: go to that tab, never a second link.
    const existing = linkFor(id, t.remoteId);
    if (existing) return show(existing.ptyId);
    try {
      const opened = await ipc.tailnetRemoteOpen(id, t.remoteId);
      registerLink({ ptyId: opened.ptyId, stableId: id, remoteId: t.remoteId, machine: m.name });
      show(opened.ptyId);
    } catch (e) {
      if (!alive.current) return;
      attempt.current += 1;
      setConn({ kind: "failed", reason: failureOf(e) });
    }
  };

  const button =
    state.kind === "connecting" ? (
      <Button size="sm" disabled>
        Connecting…
      </Button>
    ) : connected ? (
      <Button size="sm" onClick={disconnect}>
        Disconnect
      </Button>
    ) : (
      <Button size="sm" disabled={!id} onClick={() => void connect()}>
        Connect
      </Button>
    );

  return (
    <>
      <div className="resume-row">
        <span className="ts-dot" aria-hidden="true" />
        <span className="resume-prompt ts-name">{m.name}</span>
        <span className="resume-dir">{m.ip ? `${m.dnsName} · ${m.ip}` : m.dnsName}</span>
        <Switch
          checked={m.allowed}
          disabled={!id || !!view.allowError || pending === id}
          aria-label={`Allow ${m.name}`}
          onChange={(next) => onAllow(m, next)}
        />
        <span className="ts-connect">{button}</span>
      </div>
      {state.kind === "failed" && (
        <div className="ts-detail ts-fail" role="alert">
          {state.reason === "tailscale_off" && (
            <>
              <span className="set-warn">Tailscale is off on this Mac.</span>
              {view.canOpenApp && (
                <Button size="sm" onClick={onOpenApp}>
                  Open Tailscale
                </Button>
              )}
            </>
          )}
          {state.reason === "older_canopy" && (
            <span className="set-warn">
              {m.name} runs an older Canopy that can't share terminals. Update it.
            </span>
          )}
          {state.reason === "refused" && (
            <>
              <span className="ts-fail-text">
                <span className="set-warn">{m.name} didn't accept the connection.</span>
                <span className="set-note">
                  Canopy may not be running there, or {m.name} hasn't allowed this Mac.
                </span>
                <span className="set-note">
                  On {m.name}: Settings → Remote access → turn Allow on for this Mac.
                </span>
              </span>
              <Button size="sm" onClick={() => void connect()}>
                Try again
              </Button>
            </>
          )}
        </div>
      )}
      {revoked && (
        <div className="ts-detail ts-fail" role="alert">
          <span className="set-warn">{m.name} turned Allow off. Your tabs were closed.</span>
        </div>
      )}
      {notice?.kind === "ended" && !revoked && (
        <div className="ts-detail">
          <span className="set-note">
            This terminal ended on {notice.machine}
            {notice.exitCode != null ? ` (exit ${notice.exitCode})` : ""}.
          </span>
        </div>
      )}
      {state.kind === "connected" && id && (
        <div className="ts-detail ts-terminals">
          <div className="ts-terminals-head">
            <span>Terminals on {m.name}</span>
            <span className="badge">{state.terminals.length}</span>
          </div>
          {state.terminals.length === 0 && <div className="ts-terminal ts-empty">No terminals open.</div>}
          {state.terminals.map((t) => {
            const inUse = !!linkFor(id, t.remoteId);
            const running = t.status === "running";
            return (
              <div className="ts-terminal" key={t.remoteId}>
                <span className="ts-terminal-title">{t.title}</span>
                <span className="resume-dir ts-terminal-cwd">{t.cwd}</span>
                <span className="ts-terminal-status">
                  {running ? (inUse ? "running · in use here" : "running") : "exited"}
                </span>
                {running ? (
                  <Button size="sm" onClick={() => void open(t)} aria-label={`Open ${t.title} ${t.cwd}`}>
                    Open
                  </Button>
                ) : (
                  <span className="ts-terminal-none" aria-hidden="true" />
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
