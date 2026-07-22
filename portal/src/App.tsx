import { useEffect, useMemo, useRef, useState } from 'react'
import { Wire, auth, savedToken, clearToken, type Msg } from './wire'
import { wsTransport } from './wsTransport'
import {
  type Digest,
  type Project,
  type Stat,
  type Usage,
  type Pty,
  type Workspace,
  type AgentRow,
  buildRows,
  agentsForProject,
  applyTheme,
} from '@shared/model'
import { AgentCard, ProjectCard, Metric } from '@shared/components'
import { AgentTerminal } from '@shared/AgentTerminal'
import type { Transport } from '@shared/transport'

export default function App() {
  const [token, setToken] = useState<string | null>(savedToken())
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
      <div className="gate-card">
        <div className="mark">
          <span className="mark-dot" />
          CANOPY<span className="mark-thin"> REMOTE</span>
        </div>
        <p className="gate-sub">Mission control for your agents.</p>
        <form onSubmit={submit}>
          <input
            className="pin"
            inputMode="numeric"
            pattern="[0-9]*"
            autoFocus
            placeholder="••••••"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          {err && <div className="err">{err}</div>}
          <button className="primary" disabled={busy || pin.length < 4}>
            {busy ? 'Verifying…' : 'Connect'}
          </button>
        </form>
        <p className="gate-hint">Canopy → Settings → Remote access</p>
      </div>
    </div>
  )
}

type Route = { name: 'home' } | { name: 'project'; id: string } | { name: 'agent'; pty: number }

function Console({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [up, setUp] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<Digest[]>([])
  const [usage, setUsage] = useState<Usage[]>([])
  const [instance, setInstance] = useState('')
  const [stats, setStats] = useState<Map<number, Stat>>(new Map())
  const [livePtys, setLivePtys] = useState<Pty[]>([])
  const [route, setRoute] = useState<Route>({ name: 'home' })
  const [newAgent, setNewAgent] = useState<{ open: boolean; projectId?: string }>({ open: false })
  const [notice, setNotice] = useState<string | null>(null)
  const wireRef = useRef<Wire | null>(null)
  const transportRef = useRef<Transport | null>(null)

  useEffect(() => {
    const wire = new Wire(token)
    wireRef.current = wire
    transportRef.current = wsTransport(wire)
    wire.onStatus = setUp
    wire.onAuthFail = onLogout
    wire.on((m: Msg) => {
      if (m.t === 'snapshot') {
        const ws = (m.projects as Workspace) || { projects: [] }
        setProjects(ws?.projects ?? [])
        setSessions((m.sessions as Digest[]) ?? [])
        setUsage((m.usage as Usage[]) ?? [])
        setInstance(m.instance ?? '')
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
        }
      } else if (m.t === 'spawned') {
        setNewAgent({ open: false })
        setRoute({ name: 'agent', pty: m.pty })
      } else if (m.t === 'spawn-error') {
        setNewAgent({ open: false })
        setNotice(m.message || 'Could not start the agent.')
      }
    })
    wire.connect()
    const poll = setInterval(() => wire.send({ t: 'refresh' }), 4000)
    return () => {
      clearInterval(poll)
      wire.close()
    }
  }, [token, onLogout])

  const rows = useMemo(
    () => buildRows(sessions, usage, stats, instance, livePtys),
    [sessions, usage, stats, instance, livePtys],
  )
  const live = rows.filter((r) => r.live)
  const needs = live.filter((r) => r.needsYou).length
  const spawn = (cwd: string, command?: string) =>
    wireRef.current?.send({ t: 'spawn', cwd, command })

  if (route.name === 'agent' && transportRef.current) {
    const row = rows.find((r) => r.ptyId === route.pty)
    return (
      <Detail
        transport={transportRef.current}
        pty={route.pty}
        row={row}
        onBack={() => setRoute({ name: 'home' })}
      />
    )
  }

  if (route.name === 'project') {
    const project = projects.find((p) => p.id === route.id)
    if (project) {
      return (
        <ProjectDetail
          project={project}
          rows={agentsForProject(project, rows)}
          onBack={() => setRoute({ name: 'home' })}
          onOpen={(pty) => setRoute({ name: 'agent', pty })}
        />
      )
    }
  }

  return (
    <div className="app">
      <div className="scanline" aria-hidden />
      <header className="bar">
        <div className="mark small">
          <span className={`mark-dot ${up ? 'live' : 'down'}`} />
          CANOPY<span className="mark-thin"> REMOTE</span>
        </div>
        <button className="ghost" onClick={onLogout}>
          Sign out
        </button>
      </header>

      <div className="statline">
        <Metric n={live.length} label="live" tone="ok" />
        <Metric n={needs} label="need you" tone={needs ? 'warn' : ''} />
        <Metric n={projects.length} label="projects" />
        <span className={`conn ${up ? 'on' : 'off'}`}>{up ? 'connected' : 'reconnecting'}</span>
      </div>

      {live.length > 0 && (
        <section className="block">
          <div className="subhead">
            Active now<span className="subhead-n">{live.length}</span>
          </div>
          <div className="list">
            {live.map((r, i) => (
              <AgentCard
                key={r.key}
                row={r}
                index={i}
                onOpen={(pty) => setRoute({ name: 'agent', pty })}
              />
            ))}
          </div>
        </section>
      )}

      <section className="block">
        <div className="subhead">
          Projects<span className="subhead-n">{projects.length}</span>
        </div>
        {projects.length === 0 ? (
          <div className="empty">No projects open in Canopy.</div>
        ) : (
          <div className="list">
            {projects.map((p, i) => (
              <ProjectCard
                key={p.id}
                project={p}
                agents={agentsForProject(p, rows)}
                index={i}
                onOpen={() => setRoute({ name: 'project', id: p.id })}
              />
            ))}
          </div>
        )}
      </section>

      <button className="fab" onClick={() => setNewAgent({ open: true })}>
        + New agent
      </button>
      {notice && (
        <div className="notice" onClick={() => setNotice(null)}>
          {notice} <span className="notice-x">✕</span>
        </div>
      )}
      {newAgent.open && (
        <NewAgentSheet
          projects={projects}
          initialProjectId={newAgent.projectId}
          onLaunch={spawn}
          onClose={() => setNewAgent({ open: false })}
        />
      )}
    </div>
  )
}

const CLIS = ['claude', 'codex', 'aider', 'gemini', 'opencode', 'amp', 'omp']

/** Pick a project → component (cwd) → agent CLI, and launch a fresh terminal. */
function NewAgentSheet({
  projects,
  initialProjectId,
  onLaunch,
  onClose,
}: {
  projects: Project[]
  initialProjectId?: string
  onLaunch: (cwd: string, command?: string) => void
  onClose: () => void
}) {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? '')
  const project = projects.find((p) => p.id === projectId) ?? projects[0]
  const comps = project?.components ?? []
  const [path, setPath] = useState(comps[0]?.path ?? '')
  const [cli, setCli] = useState('claude')

  const launch = () => {
    const cwd = path || comps[0]?.path
    if (!cwd) return
    onLaunch(cwd, cli === 'shell' ? undefined : cli)
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <h3>New agent</h3>

        <label>Project</label>
        <select
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value)
            const p = projects.find((x) => x.id === e.target.value)
            setPath(p?.components?.[0]?.path ?? '')
          }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <label>Folder</label>
        <select value={path} onChange={(e) => setPath(e.target.value)}>
          {comps.map((c) => (
            <option key={c.path} value={c.path}>
              {c.label}
            </option>
          ))}
        </select>

        <label>Agent</label>
        <div className="cli-grid">
          {[...CLIS, 'shell'].map((c) => (
            <button
              key={c}
              className={`cli ${cli === c ? 'on' : ''}`}
              onClick={() => setCli(c)}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="sheet-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={launch} disabled={!path}>
            Launch {cli}
          </button>
        </div>
      </div>
    </div>
  )
}

function ProjectDetail({
  project,
  rows,
  onBack,
  onOpen,
}: {
  project: Project
  rows: AgentRow[]
  onBack: () => void
  onOpen: (pty: number) => void
}) {
  const live = rows.filter((r) => r.live)
  const offline = rows.filter((r) => !r.live)
  return (
    <div className="app">
      <div className="scanline" aria-hidden />
      <header className="bar">
        <button className="ghost back" onClick={onBack}>
          ‹
        </button>
        <div className="crumb">
          <span className="crumb-name">{project.name}</span>
          <span className="crumb-sub">
            {live.length} live · {rows.length} agent{rows.length === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      <div className="chips indent">
        {(project.components ?? []).map((c, j) => (
          <span className="chip" key={j}>
            {c.label}
          </span>
        ))}
      </div>

      {rows.length === 0 && (
        <div className="empty big">
          <div className="empty-mark">◇</div>
          No agents in this project yet.
        </div>
      )}

      {live.length > 0 && (
        <section className="block">
          <div className="subhead">
            Active<span className="subhead-n">{live.length}</span>
          </div>
          <div className="list">
            {live.map((r, i) => (
              <AgentCard key={r.key} row={r} index={i} onOpen={onOpen} />
            ))}
          </div>
        </section>
      )}

      {offline.length > 0 && (
        <section className="block">
          <div className="subhead dim">
            Recent<span className="subhead-n">{offline.length}</span>
          </div>
          <div className="list">
            {offline.map((r, i) => (
              <AgentCard key={r.key} row={r} index={live.length + i} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

const KEYS: [string, string][] = [
  ['return', '\r'],
  ['esc', '\x1b'],
  ['tab', '\t'],
  ['^C', '\x03'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
]

function Detail({
  transport,
  pty,
  row,
  onBack,
}: {
  transport: Transport
  pty: number
  row?: AgentRow
  onBack: () => void
}) {
  const [text, setText] = useState('')
  const send = () => {
    if (!text) return
    transport.writePty(pty, text + '\r')
    setText('')
  }
  return (
    <div className="detail">
      <header className="bar detail-bar">
        <button className="ghost back" onClick={onBack}>
          ‹
        </button>
        <div className="detail-title">
          <span className={`dot ${row?.state ?? 'idle'}`} />
          <span className="mono">{row?.agent ?? 'agent'}</span>
          {row?.branch && <span className="chip mono">⎇ {row.branch}</span>}
        </div>
        <button className="danger" onClick={() => transport.killPty(pty)}>
          Stop
        </button>
      </header>

      <AgentTerminal transport={transport} pty={pty} />

      <div className="keys">
        {KEYS.map(([label, data]) => (
          <button key={label} onClick={() => transport.writePty(pty, data)}>
            {label}
          </button>
        ))}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message the agent…"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button className="primary send" type="submit" aria-label="Send">
          ↑
        </button>
      </form>
    </div>
  )
}
