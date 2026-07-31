// Canopy Remote.
//
// One socket, one state, two shells. Everything below the shell split is shared:
// the same panels, the same detail views, the same fused agent rows out of
// `shared/model`. What differs above it is only navigation — panes on a desk, a
// stack on a phone — because those are genuinely different, and pretending
// otherwise is what produced a wide layout that was just a stretched phone.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Wire, auth, savedToken, clearToken, type Msg } from './wire'
import { wsTransport } from './wsTransport'
import { makeRpc, type Rpc } from './rpc'
import { useViewportFit, useWide } from './useMedia'
import { alertFor, notifyState, registerWorker, showAlert, wantsNotifications } from './notify'
import { CompactShell } from './shells/CompactShell'
import { WideShell } from './shells/WideShell'
import { PANELS } from './panels'
import { targetKey, type PanelCtx, type Target } from './panels/types'
import { NewAgentSheet } from './NewAgentSheet'
import {
  applyTheme,
  buildRows,
  type Digest,
  type Project,
  type Pty,
  type Stat,
  type Usage,
  type Workspace,
} from '@shared/model'
import { derivePending, parseAgentEvent, type AgentEventEntry } from '@shared/notifications'
import type { Transport } from '@shared/transport'

export default function App() {
  const [token, setToken] = useState<string | null>(savedToken())
  useViewportFit()
  if (!token) return <PinGate onToken={setToken} />
  return (
    <Console
      token={token}
      onLogout={() => {
        clearToken()
        setToken(null)
      }}
    />
  )
}

function PinGate({ onToken }: { onToken: (t: string) => void }) {
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      onToken(await auth(pin))
    } catch {
      setErr('Incorrect PIN')
      setPin('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="gate">
      <div className="gate-glow" />
      <div className="gate-card">
        <div className="mark big">
          <span className="mark-dot" />
          CANOPY<span className="mark-thin">·REMOTE</span>
        </div>
        <p className="gate-sub">Your workspace, wherever you are.</p>
        <form onSubmit={submit} autoComplete="off">
          <div className="pin-wrap">
            <input
              className="pin"
              name="canopy-pin"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              enterKeyHint="go"
              autoFocus
              placeholder="••••••"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
          {err && <div className="err">{err}</div>}
          <button className="primary block" disabled={busy || pin.length < 4}>
            {busy ? 'Verifying…' : 'Connect'}
          </button>
        </form>
        <p className="gate-hint">Canopy → Settings → Remote access</p>
      </div>
    </div>
  )
}

/** How many hook events to keep for `derivePending`. It only ever looks
 *  backwards until each session's last resolving event, so a bounded tail is
 *  enough — and unbounded growth on a page left open all day is not. */
const EVENT_TAIL = 400

function Console({ token, onLogout }: { token: string; onLogout: () => void }) {
  const wide = useWide()

  // ---- live state from the socket ----
  const [up, setUp] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<Digest[]>([])
  const [usage, setUsage] = useState<Usage[]>([])
  const [instance, setInstance] = useState('')
  const [roots, setRoots] = useState<string[]>([])
  const [stats, setStats] = useState<Map<number, Stat>>(new Map())
  const [livePtys, setLivePtys] = useState<Pty[]>([])
  const [events, setEvents] = useState<AgentEventEntry[]>([])

  // ---- navigation ----
  const [projectId, setProjectId] = useState<string>()
  const [panelId, setPanelId] = useState(PANELS[0].id)
  const [tabs, setTabs] = useState<Target[]>([])
  const [activeKey, setActiveKey] = useState<string>()
  const [newAgent, setNewAgent] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const wireRef = useRef<Wire | null>(null)
  const transportRef = useRef<Transport | null>(null)
  const rpcRef = useRef<Rpc | null>(null)

  const openTarget = useCallback((t: Target) => {
    const key = targetKey(t)
    setTabs((prev) => (prev.some((x) => targetKey(x) === key) ? prev : [...prev, t]))
    setActiveKey(key)
  }, [])

  useEffect(() => {
    const wire = new Wire(token)
    wireRef.current = wire
    transportRef.current = wsTransport(wire)
    rpcRef.current = makeRpc(wire)
    wire.onStatus = (ok) => {
      setUp(ok)
      // A dropped socket means the server has forgotten every in-flight action
      // id; leaving those promises hanging would wedge a panel until timeout.
      if (!ok) rpcRef.current?.reset('connection lost')
    }
    wire.onAuthFail = onLogout
    wire.on((m: Msg) => {
      if (m.t === 'snapshot') {
        const ws = (m.projects as Workspace) || { projects: [] }
        const all = ws?.projects ?? []
        const openIds = ws?.openIds
        // Only the projects open in the IDE (its tabs), not every one ever
        // registered — the same scope the server now applies to sessions.
        setProjects(openIds && openIds.length ? all.filter((p) => openIds.includes(p.id)) : all)
        setSessions((m.sessions as Digest[]) ?? [])
        setUsage((m.usage as Usage[]) ?? [])
        setInstance(m.instance ?? '')
        setRoots((m.roots as string[]) ?? [])
        setLivePtys((m.ptys as Pty[]) ?? [])
        applyTheme(m.theme as Record<string, string> | undefined)
      } else if (m.t === 'event') {
        if (m.name === 'pty:stats') {
          setStats(new Map(((m.payload as Stat[]) ?? []).map((s) => [s.id, s])))
        } else if (m.name === 'pty:exit') {
          const id = m.payload?.id
          if (typeof id === 'number')
            setStats((prev) => {
              const next = new Map(prev)
              next.delete(id)
              return next
            })
        } else if (m.name === 'agent:event') {
          // The raw hook line, parsed exactly once, exactly as the desktop
          // parses it — see shared/notifications.ts.
          const raw = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)
          const data = parseAgentEvent(raw)
          if (data) setEvents((prev) => [...prev, { ts: Date.now(), data }].slice(-EVENT_TAIL))
        }
      } else if (m.t === 'spawned') {
        setNewAgent(false)
        openTarget({ kind: 'terminal', pty: m.pty })
      } else if (m.t === 'spawn-error') {
        setNewAgent(false)
        setNotice(m.message || 'Could not start the agent.')
      }
    })
    wire.connect()
    const poll = setInterval(() => wire.send({ t: 'refresh' }), 4000)
    return () => {
      clearInterval(poll)
      wire.close()
    }
  }, [token, onLogout, openTarget])

  // A notification tap (handled by the service worker) asks the live tab to open
  // that agent rather than opening a second one.
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.data?.t === 'open-pty' && typeof e.data.pty === 'number') {
        openTarget({ kind: 'terminal', pty: e.data.pty })
      }
    }
    navigator.serviceWorker?.addEventListener('message', on)
    if (notifyState() === 'granted' && wantsNotifications()) void registerWorker()
    return () => navigator.serviceWorker?.removeEventListener('message', on)
  }, [openTarget])

  // Deep link from a cold notification tap: /remote/#pty=12.
  useEffect(() => {
    const m = /^#pty=(\d+)$/.exec(location.hash)
    if (m) {
      openTarget({ kind: 'terminal', pty: Number(m[1]) })
      history.replaceState(null, '', location.pathname)
    }
  }, [openTarget])

  const rows = useMemo(
    () => buildRows(sessions, usage, stats, instance, livePtys),
    [sessions, usage, stats, instance, livePtys],
  )
  const pending = useMemo(() => derivePending(events), [events])

  // Fire an OS notification for every card this device has not seen yet. A ref,
  // not state: firing must not wait on a render, and a re-render must not
  // re-fire what already buzzed.
  const notified = useRef(new Set<string>())
  useEffect(() => {
    for (const item of pending) {
      if (notified.current.has(item.key)) continue
      notified.current.add(item.key)
      void showAlert(alertFor(item))
    }
    // Keys are per-session-per-event, so the set would grow all day otherwise.
    if (notified.current.size > 500) notified.current = new Set(pending.map((p) => p.key))
  }, [pending])

  const project = useMemo(
    () => projects.find((p) => p.id === projectId) ?? projects[0],
    [projects, projectId],
  )

  const closeTab = useCallback((key: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => targetKey(t) !== key)
      setActiveKey((cur) =>
        cur !== key ? cur : next.length ? targetKey(next[next.length - 1]) : undefined,
      )
      return next
    })
  }, [])

  const spawn = useCallback((cwd: string, command?: string) => {
    wireRef.current?.send({ t: 'spawn', cwd, command })
  }, [])

  if (!transportRef.current || !rpcRef.current) return null

  const ctx: PanelCtx = {
    rpc: rpcRef.current,
    transport: transportRef.current,
    projects,
    project,
    roots,
    rows,
    stats,
    pending,
    openKey: activeKey,
    open: openTarget,
    spawn,
  }

  const shellProps = {
    ctx,
    up,
    panelId,
    onPanel: setPanelId,
    tabs,
    activeKey,
    onSelectTab: setActiveKey,
    onCloseTab: closeTab,
    projects,
    onProject: setProjectId,
    onNewAgent: () => setNewAgent(true),
    onLogout,
  }

  return (
    <>
      {wide ? <WideShell {...shellProps} /> : <CompactShell {...shellProps} />}
      {notice && (
        <div className="notice" onClick={() => setNotice(null)}>
          {notice} <span className="notice-x">✕</span>
        </div>
      )}
      {newAgent && (
        <NewAgentSheet
          projects={projects}
          initialProjectId={project?.id}
          onLaunch={spawn}
          onClose={() => setNewAgent(false)}
        />
      )}
    </>
  )
}
