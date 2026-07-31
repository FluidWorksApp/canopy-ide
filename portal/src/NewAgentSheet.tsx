// The launcher sheet: pick a project → a folder → a CLI, and a fresh agent
// terminal opens on it. Lifted out of App.tsx when the portal grew a shell per
// form factor — both of them raise this same sheet.

import { useState } from 'react'
import { AgentBadge } from '@shared/components'
import { IconBolt, IconFolder, IconTerminal } from '@shared/icons'
import { agentMeta, type Project } from '@shared/model'

const CLIS = ['claude', 'codex', 'gemini', 'aider', 'opencode', 'amp', 'omp']

/** Pick a project → component (cwd) → agent CLI, and launch a fresh terminal. */
export function NewAgentSheet({
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
