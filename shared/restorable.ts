import {
  bestProjectId,
  commandToResume,
  lastHumanPrompt,
  type AgentRow,
  type Digest,
  type Project,
  type RemoteCli,
} from './model'

export interface RestorableSession {
  digest: Digest
  superseded: Digest[]
  agentId: string
  cwd: string
  command: string
  prompt: string
  profile: string
}

export function digestResumeCwd(digest: Digest): string {
  return digest.resume_cwd ?? digest.launch_cwd ?? digest.cwd ?? ''
}

/** Pure remote projection of resumable history. User-close policy remains a
 * desktop concern: this function never guesses intent from digest lifecycle. */
export function restorableSessions(
  digests: Digest[],
  rows: AgentRow[],
  clis: RemoteCli[],
  project: Project,
  projects: Project[],
  forgotten: Record<string, number> = {},
): RestorableSession[] {
  const liveIds = new Set(rows.filter((row) => row.live).map((row) => row.sessionId).filter(Boolean))
  const livePlaces = new Set(
    rows.filter((row) => row.live).map((row) => `${row.agent}\0${row.cwd?.replace(/\/+$/, '')}`),
  )
  const groups = new Map<string, RestorableSession>()

  for (const digest of [...digests].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))) {
    const sessionId = digest.session_id?.trim()
    const agentId = digest.agent?.trim()
    const cwd = digestResumeCwd(digest).replace(/\/+$/, '')
    if (!sessionId || !agentId || !cwd || digest.micro || digest.resumable === false) continue
    if ((digest.updated ?? 0) <= (forgotten[sessionId] ?? -1)) continue
    if (bestProjectId(cwd, projects) !== project.id) continue
    if (liveIds.has(sessionId) || livePlaces.has(`${agentId}\0${cwd}`)) continue
    if (agentId === 'claude' && !lastHumanPrompt(digest.prompts)) continue
    const command = commandToResume(clis.find((cli) => cli.id === agentId), sessionId)
    if (!command) continue
    const profile = digest.profile?.trim() || 'default'
    const key = `${agentId}\0${profile}\0${cwd}`
    const held = groups.get(key)
    if (held) {
      held.superseded.push(digest)
      continue
    }
    groups.set(key, {
      digest,
      superseded: [],
      agentId,
      cwd,
      command,
      prompt: lastHumanPrompt(digest.prompts) ?? '',
      profile,
    })
  }
  return [...groups.values()]
}
