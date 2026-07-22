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
  agentMeta,
  applyTheme,
  resumeCommand,
} from '@shared/model'
import { AgentCard, ProjectCard, AgentBadge } from '@shared/components'
import { AgentTerminal } from '@shared/AgentTerminal'
import {
  IconBack,
  IconBolt,
  IconBranch,
  IconFile,
  IconFolder,
  IconPlus,
  IconPower,
  IconResume,
  IconSend,
  IconStop,
  IconTerminal,
} from '@shared/icons'
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
      <div className="gate-glow" />
      <div className="gate-card">
        <div className="mark big">
          <span className="mark-dot" />
          CANOPY<span className="mark-thin">·REMOTE</span>
        </div>
        <p className="gate-sub">Mission control for your agents.</p>
        <form onSubmit={submit}>
          <div className="pin-wrap">
            <input
              className="pin"
              inputMode="numeric"
              pattern="[0-9]*"
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

type Route =
  | { name: 'home' }
  | { name: 'project'; id: string }
  | { name: 'agent'; pty: number }
  | { name: 'history'; key: string }

/** A single instrument readout in the deck header. */
function Gauge({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className={`gauge ${tone ?? ''} ${n === 0 ? 'zero' : ''}`}>
      <span className="gauge-n">{n}</span>
      <span className="gauge-l">{label}</span>
    </div>
  )
}

function SubHead({ icon, title, n, dim }: { icon: React.ReactNode; title: string; n: number; dim?: boolean }) {
  return (
    <div className={`subhead ${dim ? 'dim' : ''}`}>
      <span className="subhead-i">{icon}</span>
      {title}
      <span className="subhead-n">{n}</span>
    </div>
  )
}

function Console({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [up, setUp] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<Digest[]>([])
  const [usage, setUsage] = useState<Usage[]>([])
  const [instance, setInstance] = useState('')
  const [stats, setStats] = useState<Map<number, Stat>>(new Map())
  const [livePtys, setLivePtys] = useState<Pty[]>([])
  const [route, setRoute] = useState<Route>({ name: 'home' })
  const [tab, setTab] = useState<'agents' | 'projects'>('agents')
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
        const all = ws?.projects ?? []
        const openIds = ws?.openIds
        // Show only the projects open in the IDE (its tabs), not every one ever
        // registered.
        setProjects(openIds && openIds.length ? all.filter((p) => openIds.includes(p.id)) : all)
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
  const offline = rows.filter((r) => !r.live)
  const needs = live.filter((r) => r.needsYou).length
  const idle = rows.length - live.length
  const spawn = (cwd: string, command?: string) =>
    wireRef.current?.send({ t: 'spawn', cwd, command })
  // Live agent → its terminal; offline agent → its history (with one-tap resume).
  const openAgent = (row: AgentRow) =>
    row.live && row.ptyId !== undefined
      ? setRoute({ name: 'agent', pty: row.ptyId })
      : setRoute({ name: 'history', key: row.key })
  const resume = (row: AgentRow) => {
    if (row.resumeCwd) spawn(row.resumeCwd, resumeCommand(row.agent, row.sessionId))
  }

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

  if (route.name === 'history') {
    const row = rows.find((r) => r.key === route.key)
    if (row) {
      return <HistoryView row={row} onBack={() => setRoute({ name: 'home' })} onResume={() => resume(row)} />
    }
  }

  if (route.name === 'project') {
    const project = projects.find((p) => p.id === route.id)
    if (project) {
      return (
        <ProjectDetail
          project={project}
          rows={agentsForProject(project, rows, projects)}
          onBack={() => setRoute({ name: 'home' })}
          onOpen={openAgent}
          onNew={() => setNewAgent({ open: true, projectId: project.id })}
        />
      )
    }
  }

  return (
    <div className="app">
      <header className="deck">
        <div className="deck-top">
          <div className="mark">
            <span className={`mark-dot ${up ? 'live' : 'down'}`} />
            Canopy<span className="mark-thin">Remote</span>
          </div>
          <span className={`conn ${up ? 'on' : ''}`}>{up ? 'Connected' : 'Connecting…'}</span>
          <button className="iconbtn" onClick={onLogout} aria-label="Sign out">
            <IconPower s={17} />
          </button>
        </div>
        <div className="gauges">
          <Gauge n={live.length} label="live" tone="ok" />
          <Gauge n={needs} label="needs you" tone="warn" />
          <Gauge n={idle} label="idle" />
        </div>
      </header>

      <div className="segmented" role="tablist">
        <button
          role="tab"
          className={tab === 'agents' ? 'on' : ''}
          onClick={() => setTab('agents')}
        >
          <IconBolt s={14} /> Agents<span className="seg-n">{rows.length}</span>
        </button>
        <button
          role="tab"
          className={tab === 'projects' ? 'on' : ''}
          onClick={() => setTab('projects')}
        >
          <IconFolder s={14} /> Projects<span className="seg-n">{projects.length}</span>
        </button>
      </div>

      {tab === 'agents' ? (
        rows.length === 0 ? (
          <div className="empty big">
            <div className="empty-mark">
              <IconTerminal s={30} />
            </div>
            No agents running. Start one below.
          </div>
        ) : (
          <>
            {live.length > 0 && (
              <section className="block">
                <SubHead icon={<IconBolt s={13} />} title="Active now" n={live.length} />
                <div className="list">
                  {live.map((r, i) => (
                    <AgentCard key={r.key} row={r} index={i} onOpen={() => openAgent(r)} />
                  ))}
                </div>
              </section>
            )}
            {offline.length > 0 && (
              <section className="block">
                <SubHead icon={<IconTerminal s={13} />} title="Recent" n={offline.length} dim />
                <div className="list">
                  {offline.map((r, i) => (
                    <AgentCard key={r.key} row={r} index={live.length + i} onOpen={() => openAgent(r)} />
                  ))}
                </div>
              </section>
            )}
          </>
        )
      ) : (
        <section className="block">
          {projects.length === 0 ? (
            <div className="empty">No projects open in Canopy.</div>
          ) : (
            <div className="list">
              {projects.map((p, i) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  agents={agentsForProject(p, rows, projects)}
                  index={i}
                  onOpen={() => setRoute({ name: 'project', id: p.id })}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'agents' && (
        <button className="fab" onClick={() => setNewAgent({ open: true })}>
          <IconPlus s={19} /> New agent
        </button>
      )}
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

const CLIS = ['claude', 'codex', 'gemini', 'aider', 'opencode', 'amp', 'omp']

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
        <h3>
          <IconBolt s={17} /> New agent
        </h3>

        <label>Project</label>
        <div className="field">
          <IconFolder s={15} />
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
        </div>

        {comps.length > 1 && (
          <>
            <label>Folder</label>
            <div className="field">
              <IconTerminal s={15} />
              <select value={path} onChange={(e) => setPath(e.target.value)}>
                {comps.map((c) => (
                  <option key={c.path} value={c.path}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        <label>Agent</label>
        <div className="cli-grid">
          {[...CLIS, 'shell'].map((c) => {
            const m = agentMeta(c)
            return (
              <button
                key={c}
                className={`cli ${cli === c ? 'on' : ''}`}
                style={{ ['--hue' as string]: m.hue }}
                onClick={() => setCli(c)}
              >
                <AgentBadge agent={c} sz={26} />
                <span>{m.label}</span>
              </button>
            )
          })}
        </div>

        <div className="sheet-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={launch} disabled={!path}>
            Launch {agentMeta(cli).label}
          </button>
        </div>
      </div>
    </div>
  )
}

function CrumbBar({
  onBack,
  badge,
  name,
  sub,
  trailing,
}: {
  onBack: () => void
  badge?: React.ReactNode
  name: string
  sub?: React.ReactNode
  trailing?: React.ReactNode
}) {
  return (
    <header className="bar">
      <button className="iconbtn back" onClick={onBack} aria-label="Back">
        <IconBack s={19} />
      </button>
      {badge}
      <div className="crumb">
        <span className="crumb-name">{name}</span>
        {sub && <span className="crumb-sub">{sub}</span>}
      </div>
      {trailing}
    </header>
  )
}

function ProjectDetail({
  project,
  rows,
  onBack,
  onOpen,
  onNew,
}: {
  project: Project
  rows: AgentRow[]
  onBack: () => void
  onOpen: (row: AgentRow) => void
  onNew: () => void
}) {
  const live = rows.filter((r) => r.live)
  const offline = rows.filter((r) => !r.live)
  return (
    <div className="app">
      <CrumbBar
        onBack={onBack}
        name={project.name}
        sub={
          <>
            {live.length} live · {rows.length} agent{rows.length === 1 ? '' : 's'}
          </>
        }
      />

      <div className="chips indent">
        {(project.components ?? []).map((c, j) => (
          <span className="chip" key={j}>
            <IconFolder s={12} /> {c.label}
          </span>
        ))}
      </div>

      {rows.length === 0 && (
        <div className="empty big">
          <div className="empty-mark">
            <IconTerminal s={30} />
          </div>
          No agents in this project yet.
        </div>
      )}

      {live.length > 0 && (
        <section className="block">
          <SubHead icon={<IconBolt s={13} />} title="Active" n={live.length} />
          <div className="list">
            {live.map((r, i) => (
              <AgentCard key={r.key} row={r} index={i} onOpen={() => onOpen(r)} />
            ))}
          </div>
        </section>
      )}

      {offline.length > 0 && (
        <section className="block">
          <SubHead icon={<IconTerminal s={13} />} title="Recent" n={offline.length} dim />
          <div className="list">
            {offline.map((r, i) => (
              <AgentCard key={r.key} row={r} index={live.length + i} onOpen={() => onOpen(r)} />
            ))}
          </div>
        </section>
      )}

      <button className="fab" onClick={onNew}>
        <IconPlus s={19} /> New agent
      </button>
    </div>
  )
}

/** An offline agent's saved history, with one-tap resume (spawns its CLI's
 *  resume command in this Canopy — so a session from any instance can be
 *  revived and driven right here). */
function HistoryView({
  row,
  onBack,
  onResume,
}: {
  row: AgentRow
  onBack: () => void
  onResume: () => void
}) {
  const m = agentMeta(row.agent)
  const prompts = (row.prompts ?? []).filter((p) => p.trim() && !p.trim().startsWith('<'))
  return (
    <div className="app">
      <CrumbBar
        onBack={onBack}
        badge={<AgentBadge agent={row.agent} sz={30} />}
        name={m.label}
        sub={
          row.branch ? (
            <span className="crumb-sub mono">
              <IconBranch s={12} /> {row.branch}
            </span>
          ) : undefined
        }
        trailing={
          row.resumeCwd ? (
            <button className="primary sm" onClick={onResume}>
              <IconResume s={14} /> Resume
            </button>
          ) : undefined
        }
      />

      <section className="block">
        <SubHead icon={<IconTerminal s={13} />} title="Conversation" n={prompts.length} />
        {prompts.length === 0 ? (
          <div className="empty">No saved prompts for this session.</div>
        ) : (
          <div className="history">
            {prompts.map((p, i) => (
              <div className="hprompt" key={i}>
                {p}
              </div>
            ))}
          </div>
        )}
      </section>

      {row.files && row.files.length > 0 && (
        <section className="block">
          <SubHead icon={<IconFile s={13} />} title="Files touched" n={row.files.length} />
          <div className="hfiles">
            {row.files.map((f, i) => (
              <span className="hfile" key={i}>
                <IconFile s={13} />
                <code className="mono">{f}</code>
              </span>
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
  const m = agentMeta(row?.agent ?? 'shell')
  const send = () => {
    if (!text) return
    transport.writePty(pty, text + '\r')
    setText('')
  }
  return (
    <div className="detail">
      <header className="bar detail-bar">
        <button className="iconbtn back" onClick={onBack} aria-label="Back">
          <IconBack s={19} />
        </button>
        <AgentBadge agent={row?.agent ?? 'shell'} sz={30} />
        <div className="detail-title">
          <span className="detail-name">{m.label}</span>
          <span className="detail-sub">
            <span className={`dot ${row?.state ?? 'idle'}`} />
            {row?.branch ? (
              <span className="mono">
                <IconBranch s={11} /> {row.branch}
              </span>
            ) : (
              <span>{row?.state ?? 'idle'}</span>
            )}
          </span>
        </div>
        <button className="danger sm" onClick={() => transport.killPty(pty)}>
          <IconStop s={13} /> Stop
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
          <IconSend s={18} />
        </button>
      </form>
    </div>
  )
}
