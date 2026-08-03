// Issues, research, MCP tools, instruction files. Four small lists that all
// answer "what does this project know?" — the reading half of the IDE, which is
// exactly the half that survives the trip to a phone intact.

import { IconBook, IconIssue, IconPlug, ResearchIcon } from '@shared/icons'
import { useAsync } from '../useAsync'
import { AsyncBody, Pill, Row, SubHead } from './ui'
import { repoOf, type PanelDef } from './types'

interface TicketInfo {
  id: string
  title: string
  state: string
  state_type: string
  assignee?: string | null
  mine: boolean
  url: string
}

// All four mirror their Rust structs (research.rs, mcp.rs, instructions.rs).
interface ResearchSummary {
  id: string
  title: string
  status: string
  digest: string
  tags: string[]
  agent: string
  updated_at: number
  pr_count: number
  superseded_by?: string | null
}

interface McpSource {
  agent: string
  label: string
  scope: string
  status?: string
}

interface McpServer {
  key: string
  name: string
  transport: string
  command?: string | null
  url?: string | null
  sources: McpSource[]
  enabled: boolean
}

interface InstructionFile {
  path: string
  kind: string
  scope: string
  agents: string[]
  label: string
  root: string
  exists: boolean
  bytes: number
}

export const ticketsPanel: PanelDef = {
  id: 'tickets',
  title: 'Issues',
  Icon: IconIssue,
  scope: 'project',
  List({ ctx }) {
    const repo = repoOf(ctx)
    const state = useAsync<TicketInfo[]>(
      () =>
        repo
          ? ctx.rpc.call<TicketInfo[]>('gh_issue_list', { repo })
          : Promise.reject(new Error('No repo in this project.')),
      [repo],
    )
    if (!repo) return <div className="panel-empty">This project has no git repo.</div>
    return (
      <AsyncBody state={state} empty="No open issues.">
        {(tickets) => (
          <>
            <SubHead title="Open" n={tickets.length} />
            {tickets.map((t) => (
              <Row
                key={t.id}
                icon={<IconIssue s={15} />}
                title={t.title}
                sub={
                  <>
                    <span className="mono">{t.id}</span>
                    {t.assignee ? ` · ${t.assignee}` : ''}
                  </>
                }
                meta={t.mine ? <Pill tone="ok">yours</Pill> : <Pill>{t.state}</Pill>}
              />
            ))}
          </>
        )}
      </AsyncBody>
    )
  },
}

export const researchPanel: PanelDef = {
  id: 'research',
  title: 'Research',
  Icon: ResearchIcon,
  scope: 'project',
  List({ ctx }) {
    // The research store is keyed by project id, not by path — it deliberately
    // lives outside every repo.
    const projectId = ctx.project?.id
    const state = useAsync<ResearchSummary[]>(
      () =>
        projectId
          ? ctx.rpc.call<ResearchSummary[]>('research_list', { projectId, limit: 60 })
          : Promise.resolve([]),
      [projectId],
    )
    return (
      <AsyncBody state={state} empty="Nothing has been researched in this project yet.">
        {(entries) => (
          <>
            {entries.map((e) => (
              <Row
                key={e.id}
                on={ctx.openKey === `research:${projectId}:${e.id}`}
                icon={<ResearchIcon s={15} />}
                title={e.title}
                sub={e.digest}
                meta={
                  <>
                    {e.superseded_by && <Pill tone="warn">superseded</Pill>}
                    <Pill tone={e.status === 'implemented' ? 'ok' : ''}>{e.status}</Pill>
                  </>
                }
                // Opens immediately; the detail pane does the fetching. The
                // previous version awaited the RPC *before* opening anything, so
                // a tap did nothing visible for the whole round trip.
                onClick={() =>
                  projectId &&
                  ctx.open({ kind: 'research', projectId, id: e.id, title: e.title })
                }
              />
            ))}
          </>
        )}
      </AsyncBody>
    )
  },
}

export const toolsPanel: PanelDef = {
  id: 'tools',
  title: 'Tools',
  Icon: IconPlug,
  scope: 'project',
  List({ ctx }) {
    const dirs = ctx.project?.components?.map((c) => c.path) ?? []
    const state = useAsync<McpServer[]>(
      () => ctx.rpc.call<McpServer[]>('mcp_servers', { projectDirs: dirs }),
      [dirs.join('\n')],
    )
    return (
      <AsyncBody state={state} empty="No MCP servers are configured for this project.">
        {(servers) => (
          <>
            {servers.map((s, i) => (
              <Row
                key={s.key || `${s.name}-${i}`}
                icon={<IconPlug s={15} />}
                title={s.name}
                sub={s.command ?? s.url ?? s.transport}
                meta={
                  <>
                    {!s.enabled && <Pill tone="dim">off</Pill>}
                    {s.sources.length > 0 && (
                      <Pill tone={s.enabled ? 'ok' : ''}>
                        {s.sources.length} {s.sources.length === 1 ? 'CLI' : 'CLIs'}
                      </Pill>
                    )}
                  </>
                }
              />
            ))}
          </>
        )}
      </AsyncBody>
    )
  },
}

export const instructionsPanel: PanelDef = {
  id: 'instructions',
  title: 'Instructions',
  Icon: IconBook,
  scope: 'project',
  List({ ctx }) {
    const roots = ctx.project?.components?.map((c) => c.path) ?? []
    const state = useAsync<InstructionFile[]>(
      () => ctx.rpc.call<InstructionFile[]>('instructions_scan', { roots }),
      [roots.join('\n')],
    )
    return (
      <AsyncBody state={state} empty="No instruction files found.">
        {(docs) => (
          <>
            {docs.map((d) => (
              <Row
                key={d.path}
                on={ctx.openKey === `doc:${d.path}`}
                icon={<IconBook s={15} />}
                title={d.label || d.path.split('/').pop() || d.path}
                sub={d.agents.length ? d.agents.join(', ') : d.path}
                meta={
                  <>
                    <Pill>{d.kind}</Pill>
                    {d.scope === 'global' && <Pill tone="dim">global</Pill>}
                  </>
                }
                onClick={() =>
                  ctx.open({
                    kind: 'doc',
                    path: d.path,
                    roots,
                    title: d.label || d.path.split('/').pop() || d.path,
                  })
                }
              />
            ))}
          </>
        )}
      </AsyncBody>
    )
  },
}
