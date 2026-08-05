import { NO_ATTENTION, agentLife, bucketFor } from './agentLife'
// Shared domain model for Canopy's agent views — the single source of truth
// used by BOTH shells: the desktop app (src/, over Tauri IPC) and the mobile
// portal (portal/, over WebSocket). It is pure TypeScript: no React, no
// transport, no DOM beyond the small theme helper. Each shell feeds it the same
// three raw inputs (hook digests, live PTY stats, usage) and renders the fused
// rows however its layout demands.

export interface Component {
  label: string
  path: string
}
export interface Project {
  id: string
  name: string
  components: Component[]
}
export interface Workspace {
  projects: Project[]
  openIds?: string[]
  activeId?: string
}

/** A hook digest (~/.canopy/sessions/*.json), machine-global. */
export interface Digest {
  session_id?: string
  cwd?: string
  branch?: string
  agent?: string
  state?: 'working' | 'waiting' | 'idle' | 'ended'
  /** Which rung produced `state`; absent on pre-upgrade and store rows. */
  state_via?: string
  /** True for a row rebuilt from the CLI's own history, which records no
   *  lifecycle at all. Such a row is `unknown`, never `idle`. */
  store?: boolean
  prompts?: string[]
  files?: string[]
  surface?: string
  instance?: string
  updated?: number
  resumable?: boolean
  resume_cwd?: string
  launch_cwd?: string
  profile?: string
  micro?: boolean
  foreign?: boolean
  /** The session's working-time clock, kept by canopy_hook.rs — see
   *  agentDuration.ts. Absent on digests written before it existed. */
  active_secs?: number
  run_secs?: number
  run_started?: number
}

/** What a terminal is running, resolved from its foreground process by
 *  agentid.rs. Evidence, not a verdict — see src/agentIdentity.ts. */
export interface AgentHint {
  bin: string
  pkg: string | null
  path: string | null
  interactive: boolean
}

/** Live process-tree stats for one PTY this run (pty:stats event). */
export interface Stat {
  id: number
  title: string
  cwd: string
  total_cpu: number
  total_mem_bytes: number
  agent_hint?: AgentHint | null
  ports: number[]
  procs: { name: string; cmd: string }[]
  /** Milliseconds since this terminal last painted / was typed into. The
   *  signal that separates a model thinking from an agent at its prompt. */
  quiet_ms?: number | null
  since_input_ms?: number | null
}

/** A live PTY session, from the snapshot (authoritative liveness). */
export interface Pty {
  id: number
  cwd: string
  title: string
}

/** Token/cost roll-up per session (agent_usage). */
export interface Usage {
  session_id: string
  agent: string
  cwd: string
  input_tokens: number
  output_tokens: number
  cost: number
  model?: string
}

/** A fused agent row: digest + live stat + usage, correlated by PTY id. */
export interface AgentRow {
  key: string
  agent: string
  state: string
  branch?: string
  cwd?: string
  lastPrompt?: string
  /** A live PTY with no agent behind it — a plain terminal you can drive. */
  terminal?: boolean
  /** What the PTY is running (its tab title), shown in place of a prompt. */
  title?: string
  ptyId?: number
  live: boolean
  cpu?: number
  memBytes?: number
  cost?: number
  tokens?: number
  needsYou: boolean
  updated?: number
  /** The session's working-time clock, straight off the digest. Left raw here
   *  rather than resolved to a duration because resolving needs `now`, and
   *  buildRows is a pure fusion of its inputs — the card calls workingTime(). */
  activeSecs?: number
  runSecs?: number
  // For offline agents: history + one-tap resume.
  prompts?: string[]
  files?: string[]
  resumeCwd?: string
  sessionId?: string
  profile?: string
  resumable?: boolean
}

/** One companion exchange, projected for the portal: prose and provenance,
 *  no attachments (their paths are desktop-local and useless on a phone). */
export interface RemoteCompanionMessage {
  who: 'you' | 'ash'
  text: string
  failed?: boolean
  /** Names of tools the reply ran, for the provenance chips. */
  tools?: string[]
}

/** The companion's presence + transcript as the desktop pushes it to the
 *  portal — the same channel the theme uses, because the conversation lives in
 *  the desktop frontend and the Rust core never sees a word of it. */
export interface RemoteCompanion {
  status: 'off' | 'starting' | 'ready' | 'working' | 'failed' | 'unavailable'
  cliName: string
  generation: number
  messages: RemoteCompanionMessage[]
  error?: string | null
}

/** One attention-channel item (src/attention.ts), projected for the portal by
 *  src/remoteAttention.ts. The desktop's `where` deep link is deliberately
 *  dropped — it names desktop surfaces a browser cannot land on. */
export interface RemoteAttentionItem {
  id: string
  kind: 'fyi' | 'question'
  tone: 'info' | 'success' | 'warn' | 'error'
  title: string
  body?: string
  source: string
  projectId?: string
  projectName?: string
  ts: number
  /** Questions only: set once answered or withdrawn. Unset = waiting on you. */
  resolvedAt?: number
  resolution?: string
  /** Identity of the asker, carried so the portal can fold out the items the
   *  desktop derives from the same hook stream the portal already renders
   *  (`agent:<sessionId>` — see App.tsx's blocked-agents post). */
  dedupeKey?: string
}

/** Outstanding = a question nobody has resolved — the same predicate the
 *  desktop's badge uses, so the two shells cannot disagree. */
export const isRemoteOutstanding = (item: RemoteAttentionItem): boolean =>
  item.kind === 'question' && item.resolvedAt == null

export const SESSION_ID_TOKEN = '__CANOPY_SESSION_ID__'

/** The desktop's resolved CLI registry, projected into a browser-safe shape. */
export interface RemoteCli {
  id: string
  name: string
  command: string
  resumeTemplate?: string
  available: boolean
  custom?: boolean
}

/** Build only verified resume commands. Unknown CLIs never get a guessed flag. */
export function commandToResume(cli: RemoteCli | undefined, sessionId?: string): string | null {
  const id = sessionId?.trim()
  if (!id || !cli?.resumeTemplate?.includes(SESSION_ID_TOKEN)) return null
  return cli.resumeTemplate.replaceAll(SESSION_ID_TOKEN, id)
}

export const STATE_LABEL: Record<string, string> = {
  starting: 'starting',
  working: 'working',
  waiting: 'needs you',
  idle: 'idle',
  ended: 'ended',
  // Said rather than hidden. Every row read from a CLI's own history used to
  // arrive here as `d.state || 'idle'` — an invented answer for a record that
  // holds no lifecycle at all.
  unknown: 'no signal',
}

export function lastHumanPrompt(prompts?: string[]): string | undefined {
  if (!prompts?.length) return undefined
  for (let i = prompts.length - 1; i >= 0; i--) {
    const p = prompts[i]?.trim()
    if (p && !p.startsWith('<')) return p
  }
  return prompts[prompts.length - 1]
}

function rank(s: string): number {
  return s === 'waiting' ? 3 : s === 'working' ? 2 : s === 'idle' ? 1 : 0
}

const normCwd = (p?: string): string => (p ?? '').replace(/\/+$/, '')

function sortRows(a: AgentRow, b: AgentRow): number {
  return (
    Number(b.needsYou) - Number(a.needsYou) ||
    Number(b.live) - Number(a.live) ||
    rank(b.state) - rank(a.state) ||
    (b.updated ?? 0) - (a.updated ?? 0)
  )
}

/**
 * Fuse the sources into ranked agent rows. `instance` is the current app
 * launch's token; a digest is "live" (attachable) when it belongs to this
 * instance AND its `surface` id is a currently-running PTY — known
 * authoritatively from `livePtys` (the snapshot), with the `stats` event as a
 * fallback and the source of CPU/mem. `stats` also overlays live resource use.
 */
export function buildRows(
  sessions: Digest[],
  usage: Usage[],
  stats: Map<number, Stat>,
  _instance: string,
  livePtys: Pty[],
  clis: readonly RemoteCli[] = [],
): AgentRow[] {
  const usageBy = new Map(usage.map((u) => [u.session_id, u]))

  // Most-recent digest first, so when several digests share a PTY id only the
  // newest claims it as live.
  const ordered = sessions.filter((d) => d.agent).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
  const claimed = new Set<number>()

  const agents: AgentRow[] = ordered
    .map((d, i) => {
      const surfaceId = d.surface !== undefined ? Number(d.surface) : NaN
      // Live/attachable iff a currently-running PTY matches BOTH the digest's
      // surface id AND its cwd. The cwd check (not id alone) is what stops a
      // stale digest whose reused pty-id collides with a current one from
      // showing up live under the wrong project.
      const livePty = Number.isFinite(surfaceId)
        ? livePtys.find(
            (p) => p.id === surfaceId && normCwd(p.cwd) === normCwd(d.cwd) && !claimed.has(p.id),
          )
        : undefined
      const live = !!livePty
      if (live) claimed.add(surfaceId)
      const liveStat = live ? stats.get(surfaceId) : undefined
      const u = d.session_id ? usageBy.get(d.session_id) : undefined
      // The one ladder, over evidence that was already in this object literal
      // and going unread: the digest's own recorded state and rung, the live
      // stat's CPU and quiet time, and whether a terminal is still there.
      const life = agentLife({
        digest: { ...d, store: d.store } as never,
        pty: live
          ? {
              kind: 'live',
              hint: { bin: d.agent ?? '', interactive: true },
              cpu: liveStat?.total_cpu ?? 0,
              quietForMs: liveStat?.quiet_ms ?? undefined,
              sinceInputMs: liveStat?.since_input_ms ?? undefined,
            }
          : undefined,
        now: Date.now() / 1000,
      })
      return {
        key: d.session_id || `${d.instance ?? ''}:${d.surface ?? i}`,
        agent: d.agent!,
        state: life.state,
        branch: d.branch,
        cwd: d.cwd,
        lastPrompt: lastHumanPrompt(d.prompts),
        title: livePty?.title?.trim() || undefined,
        ptyId: live ? surfaceId : undefined,
        live,
        cpu: liveStat?.total_cpu,
        memBytes: liveStat?.total_mem_bytes,
        cost: u?.cost,
        tokens: u ? u.input_tokens + u.output_tokens : undefined,
        needsYou: bucketFor(life, NO_ATTENTION) === 'attention',
        updated: d.updated,
        activeSecs: d.active_secs,
        runSecs: d.run_secs,
        prompts: d.prompts,
        files: d.files,
        resumeCwd: d.resume_cwd ?? d.cwd,
        sessionId: d.session_id,
        profile: d.profile,
        resumable: d.resumable,
      }
    })

  // Plain terminals: every live PTY that no digest claimed. They carry no hook
  // session — no prompts, no usage, nothing to resume — but they are running
  // and attachable, which is the whole point of reaching them from a phone. A
  // just-started agent CLI also lands here for the second before its first
  // digest is written; naming it from the PTY title keeps it from flickering
  // in as "shell" and out as "Claude".
  const terminals: AgentRow[] = livePtys
    .filter((p) => !claimed.has(p.id))
    .map((p) => {
      const stat = stats.get(p.id)
      // Who is in this terminal: the foreground process's own binary first —
      // the same rung the desktop's identity ladder trusts most — then the
      // title. A pty running an agent whose hooks never wired up (or whose
      // digest predates this app run) is still that agent, not a plain shell;
      // classifying it by "has a digest" is what put Claudes under Terminals.
      const agent = agentFromHint(stat?.agent_hint, clis) ?? agentFromTitle(p.title, clis) ?? 'shell'
      // A terminal with no digest is not "idle" — that was a hard-coded string
      // sitting two lines above a CPU reading it ignored, and it let the portal
      // call a terminal idle while the desktop called the same pty working. The
      // process rungs answer it honestly.
      const life = agentLife({
        pty: {
          kind: 'live',
          hint: { bin: agent, interactive: true },
          cpu: stat?.total_cpu ?? 0,
          quietForMs: stat?.quiet_ms ?? undefined,
          sinceInputMs: stat?.since_input_ms ?? undefined,
        },
        now: Date.now() / 1000,
      })
      return {
        key: `pty:${p.id}`,
        agent,
        state: life.state,
        cwd: p.cwd,
        title: p.title?.trim() || undefined,
        terminal: true,
        ptyId: p.id,
        live: true,
        cpu: stat?.total_cpu,
        memBytes: stat?.total_mem_bytes,
        needsYou: false,
      }
    })

  return [...agents, ...terminals].sort(sortRows)
}

/** The registry id `word` names, matched exactly against ids, known agents,
 *  and each CLI's command head. A near-miss is nobody: no brand from a guess. */
function agentForWord(word: string | undefined, clis: readonly RemoteCli[]): string | undefined {
  if (!word || word === 'shell') return undefined
  if (word in AGENT_META) return word
  const match = clis.find((cli) => {
    const command = cli.command.trim()
    const head = command.startsWith("'")
      ? command.slice(1, command.indexOf("'", 1))
      : command.startsWith('"')
        ? command.slice(1, command.indexOf('"', 1))
        : command.split(/\s+/)[0]
    return cli.id === word || head?.split(/[/\\]/).pop()?.toLowerCase() === word
  })
  return match?.id
}

/** The agent CLI a terminal is running, read off its title ("claude",
 *  "codex — canopy"). Undefined for an ordinary shell. */
export function agentFromTitle(title?: string, clis: readonly RemoteCli[] = []): string | undefined {
  return agentForWord(title?.trim().toLowerCase().split(/[\s—:/\\]+/)[0], clis)
}

/** The agent CLI a terminal is running, from its foreground process's own
 *  binary — the strongest evidence pty:stats carries, and the same rung the
 *  desktop's identity ladder reads before it ever looks at a title. */
export function agentFromHint(
  hint: AgentHint | null | undefined,
  clis: readonly RemoteCli[] = [],
): string | undefined {
  return agentForWord(hint?.bin?.split(/[/\\]/).pop()?.toLowerCase(), clis)
}

/** The single project an agent belongs to: the one with the deepest (most
 *  specific) matching component path — so a broad path like ~/Documents never
 *  steals an agent from a nested project. */
export function bestProjectId(cwd: string | undefined, projects: Project[]): string | undefined {
  const c = normCwd(cwd)
  if (!c) return undefined
  let bestId: string | undefined
  let bestLen = -1
  for (const p of projects) {
    for (const comp of p.components ?? []) {
      const r = normCwd(comp.path)
      if (r && (c === r || c.startsWith(r + '/')) && r.length > bestLen) {
        bestLen = r.length
        bestId = p.id
      }
    }
  }
  return bestId
}

/** Agents that belong to `project` — i.e. whose deepest matching project is it. */
export function agentsForProject(
  project: Project,
  rows: AgentRow[],
  projects: Project[],
): AgentRow[] {
  return rows.filter((r) => bestProjectId(r.cwd, projects) === project.id)
}

// ---- agent identity -------------------------------------------------------

/** Per-agent brand identity: a monochrome glyph (inherits the hue, so it tints
 *  the badge) and a signature colour. The colour is the ONE place the portal
 *  steps outside the pushed Canopy theme — it's the agent's identity, not the
 *  app's chrome — which is what makes a list of agents read as distinct faces
 *  rather than one grey column. Unknown agents fall back to the app accent. */
export interface AgentMeta {
  glyph: string
  hue: string
  label: string
}
export const AGENT_META: Record<string, AgentMeta> = {
  claude: { glyph: '✳', hue: '#d97757', label: 'Claude' },
  codex: { glyph: '⬢', hue: '#10a37f', label: 'Codex' },
  gemini: { glyph: '✦', hue: '#6d7cf5', label: 'Gemini' },
  agy: { glyph: '◇', hue: '#f59e0b', label: 'Antigravity' },
  aider: { glyph: '◆', hue: '#14b8a6', label: 'Aider' },
  opencode: { glyph: '⬣', hue: '#a855f7', label: 'opencode' },
  amp: { glyph: '✺', hue: '#f97316', label: 'Amp' },
  omp: { glyph: '⬟', hue: '#ec4899', label: 'omp' },
  shell: { glyph: '❯', hue: '#8894a8', label: 'Terminal' },
}
export function agentMeta(agent: string): AgentMeta {
  return (
    AGENT_META[agent?.toLowerCase?.() ?? ''] ?? {
      glyph: '◈',
      hue: 'var(--accent, #5b9dff)',
      label: agent || 'agent',
    }
  )
}

// ---- formatters -----------------------------------------------------------

export function fmtMem(bytes?: number): string {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`
}
export function fmtTokens(n?: number): string {
  if (!n) return ''
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}
export function basename(p?: string): string {
  if (!p) return ''
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

// ---- theme ----------------------------------------------------------------

/** Apply Canopy theme tokens (pushed from the desktop) onto CSS variables. The
 *  portal uses the same variable names Canopy uses, so it just inherits. */
export function applyTheme(theme?: Record<string, string>): void {
  if (!theme || typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.portalTheme = isLight(theme.bg) ? 'light' : 'dark'
  for (const [k, v] of Object.entries(theme)) {
    if (v) root.style.setProperty(`--${k}`, v)
  }
}
function isLight(bg?: string): boolean {
  const m = bg && /^#?([0-9a-f]{6})$/i.exec(bg.trim())
  if (!m) return false
  const n = parseInt(m[1], 16)
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 140
}
