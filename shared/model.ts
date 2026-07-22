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

function sortRows(a: AgentRow, b: AgentRow): number {
  return (
    Number(b.needsYou) - Number(a.needsYou) ||
    Number(b.live) - Number(a.live) ||
    rank(b.state) - rank(a.state) ||
    (b.updated ?? 0) - (a.updated ?? 0)
  )
}

/**
 * Fuse the three sources into ranked agent rows. `instance` is the current app
 * launch's token; a digest is "live" only when it belongs to this instance AND
 * a matching PTY appears in `stats` (correlated by the digest's `surface` id).
 */
export function buildRows(
  sessions: Digest[],
  usage: Usage[],
  stats: Map<number, Stat>,
  instance: string,
): AgentRow[] {
  const usageBy = new Map(usage.map((u) => [u.session_id, u]))
  return sessions
    .filter((d) => d.agent)
    .map((d, i) => {
      const ptyId = d.instance === instance && d.surface ? Number(d.surface) : undefined
      const liveStat = ptyId !== undefined ? stats.get(ptyId) : undefined
      const live = liveStat !== undefined
      const u = d.session_id ? usageBy.get(d.session_id) : undefined
      return {
        key: d.session_id || `${d.instance ?? ''}:${d.surface ?? i}`,
        agent: d.agent!,
        state: d.state || 'idle',
        branch: d.branch,
        cwd: d.cwd,
        lastPrompt: lastHumanPrompt(d.prompts),
        ptyId: live ? ptyId : undefined,
        live,
        cpu: liveStat?.total_cpu,
        memBytes: liveStat?.total_mem_bytes,
        cost: u?.cost,
        tokens: u ? u.input_tokens + u.output_tokens : undefined,
        needsYou: live && d.state === 'waiting',
        updated: d.updated,
      }
    })
    .sort(sortRows)
}

/** Agents whose cwd sits inside one of a project's component directories. */
export function agentsForProject(project: Project, rows: AgentRow[]): AgentRow[] {
  const roots = (project.components ?? []).map((c) => (c.path ?? '').replace(/\/+$/, ''))
  return rows.filter((r) => {
    const cwd = r.cwd ?? ''
    return roots.some((root) => root && (cwd === root || cwd.startsWith(root + '/')))
  })
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
