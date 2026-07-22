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
  prompts?: string[]
  files?: string[]
  surface?: string
  instance?: string
  updated?: number
  resumable?: boolean
  resume_cwd?: string
}

/** Live process-tree stats for one PTY this run (pty:stats event). */
export interface Stat {
  id: number
  title: string
  cwd: string
  total_cpu: number
  total_mem_bytes: number
  ports: number[]
  procs: { name: string; cmd: string }[]
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
  ptyId?: number
  live: boolean
  cpu?: number
  memBytes?: number
  cost?: number
  tokens?: number
  needsYou: boolean
  updated?: number
  // For offline agents: history + one-tap resume.
  prompts?: string[]
  files?: string[]
  resumeCwd?: string
  sessionId?: string
}

/** The shell command that resumes an agent's saved session in its CLI. */
export function resumeCommand(agent: string, sessionId?: string): string {
  const id = sessionId?.trim()
  switch (agent) {
    case 'claude':
      return id ? `claude --resume ${id}` : 'claude --continue'
    case 'codex':
      return id ? `codex resume ${id}` : 'codex'
    default:
      return id ? `${agent} --resume ${id}` : `${agent} --resume`
  }
}

export const STATE_LABEL: Record<string, string> = {
  working: 'working',
  waiting: 'needs you',
  idle: 'idle',
  ended: 'ended',
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
  return s === 'working' ? 3 : s === 'waiting' ? 2 : s === 'idle' ? 1 : 0
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
): AgentRow[] {
  const usageBy = new Map(usage.map((u) => [u.session_id, u]))

  // Most-recent digest first, so when several digests share a PTY id only the
  // newest claims it as live.
  const ordered = sessions.filter((d) => d.agent).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
  const claimed = new Set<number>()

  return ordered
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
      return {
        key: d.session_id || `${d.instance ?? ''}:${d.surface ?? i}`,
        agent: d.agent!,
        state: d.state || 'idle',
        branch: d.branch,
        cwd: d.cwd,
        lastPrompt: lastHumanPrompt(d.prompts),
        ptyId: live ? surfaceId : undefined,
        live,
        cpu: liveStat?.total_cpu,
        memBytes: liveStat?.total_mem_bytes,
        cost: u?.cost,
        tokens: u ? u.input_tokens + u.output_tokens : undefined,
        needsYou: live && d.state === 'waiting',
        updated: d.updated,
        prompts: d.prompts,
        files: d.files,
        resumeCwd: d.resume_cwd ?? d.cwd,
        sessionId: d.session_id,
      }
    })
    .sort(sortRows)
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
  aider: { glyph: '◆', hue: '#14b8a6', label: 'Aider' },
  opencode: { glyph: '⬣', hue: '#a855f7', label: 'opencode' },
  amp: { glyph: '✺', hue: '#f97316', label: 'Amp' },
  omp: { glyph: '⬟', hue: '#ec4899', label: 'omp' },
  shell: { glyph: '❯', hue: '#8894a8', label: 'shell' },
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
