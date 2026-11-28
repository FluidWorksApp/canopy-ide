// "All workspaces": a project this machine cannot open — one only another
// machine has, or one asleep here while another machine runs it. It shows
// those machines' live terminals and nothing else: no folders (they are on the
// other machine), no launching (a new terminal would start here), nothing
// saved. The full project view stays for projects this machine has awake.
import { useEffect, useRef, useState } from "react";
import { Term } from "./Term";
import { Button } from "./ui";
import { closedKey, THIS_MAC_ENV } from "../environments/allWorkspaceTabs";
import { localTabReconnect, remoteTabReconnect, type ReconnectResult } from "../environments/remoteReconnect";
import type { ForeignSession } from "../environments/allProjects";

type Reconnect = (env: string, sessionId: number) => Promise<ReconnectResult>;

const defaultReconnect: Reconnect = (env, sessionId) =>
  env === THIS_MAC_ENV ? localTabReconnect(sessionId) : remoteTabReconnect(env, sessionId);

interface Attached {
  key: string;
  alias: number;
  env: string;
  title: string;
  machineName: string;
}

export function AllWorkspacesView({
  name,
  machines,
  sessions,
  visible,
  onWake,
  reconnect = defaultReconnect,
}: {
  name: string;
  machines: string[];
  sessions: readonly ForeignSession[];
  visible: boolean;
  /** Set when the project is asleep on this machine: wake it here. */
  onWake?: () => void;
  reconnect?: Reconnect;
}) {
  const [attached, setAttached] = useState<Attached[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const joining = useRef(new Set<string>());
  const closed = useRef(new Set<string>());
  const attachedRef = useRef(attached);
  attachedRef.current = attached;

  useEffect(() => {
    if (!visible) return;
    const live = new Set(sessions.map((s) => closedKey(s.env, s.session.id)));
    // Ended on its machine, or no longer this project's: the tab goes, the
    // session (if any) is left alone.
    setAttached((prev) => {
      const kept = prev.filter((a) => live.has(a.key));
      return kept.length === prev.length ? prev : kept;
    });
    for (const key of [...closed.current]) if (!live.has(key)) closed.current.delete(key);
    for (const s of sessions) {
      const key = closedKey(s.env, s.session.id);
      if (closed.current.has(key) || joining.current.has(key) || attachedRef.current.some((a) => a.key === key)) continue;
      joining.current.add(key);
      void reconnect(s.env, s.session.id)
        .then((result) => {
          if (result.kind === "attached") {
            setFailed(null);
            setAttached((prev) =>
              prev.some((a) => a.key === key)
                ? prev
                : [...prev, { key, alias: result.alias, env: s.env, title: s.session.title || `terminal ${s.session.id}`, machineName: s.machineName }],
            );
          } else if (result.kind === "failed") {
            setFailed(result.reason);
            console.warn(`[all-workspaces] could not attach ${key}: ${result.reason}`);
          }
        })
        .finally(() => joining.current.delete(key));
    }
  }, [sessions, visible, reconnect]);

  const current = attached.find((a) => a.key === selected) ?? attached[0];
  return (
    <div className="project-view all-workspaces-view" style={{ display: visible ? "flex" : "none" }}>
      <div className="all-workspaces-head">
        <strong>{name}</strong>
        <span className="all-workspaces-where">
          {onWake ? `Asleep here · running on ${machines.join(", ")}` : `On ${machines.join(", ")} · not on this machine`}
        </span>
        {onWake && (
          <Button size="sm" onClick={onWake}>
            Wake here
          </Button>
        )}
      </div>
      {attached.length > 0 && (
        <div className="all-workspaces-tabs" role="tablist" aria-label={`${name} terminals`}>
          {attached.map((a) => (
            <div
              key={a.key}
              role="tab"
              aria-selected={a.key === current?.key}
              className={`all-workspaces-tab${a.key === current?.key ? " active" : ""}`}
              onClick={() => setSelected(a.key)}
            >
              <span>{a.title}</span>
              <span className="project-tab-machine">{a.machineName}</span>
              <button
                type="button"
                className="all-workspaces-tab-close"
                aria-label={`Close ${a.title}`}
                title="Close the tab; the terminal keeps running on its machine"
                onClick={(event) => {
                  event.stopPropagation();
                  closed.current.add(a.key);
                  setAttached((prev) => prev.filter((x) => x.key !== a.key));
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="all-workspaces-body">
        {attached.map((a) => (
          <div key={a.key} className="all-workspaces-term" style={{ display: a.key === current?.key ? "flex" : "none" }}>
            <Term
              attachId={a.alias}
              killAttachedOnClose={false}
              machine={a.env}
              active={visible && a.key === current?.key}
              streaming={visible}
              onSpawned={() => {}}
              onExited={() => setAttached((prev) => prev.filter((x) => x.key !== a.key))}
            />
          </div>
        ))}
        {attached.length === 0 && (
          <p className="all-workspaces-empty" role="status">
            {failed ? `Could not attach: ${failed}` : sessions.length ? "Attaching…" : "Nothing is running in this project."}
          </p>
        )}
      </div>
    </div>
  );
}
