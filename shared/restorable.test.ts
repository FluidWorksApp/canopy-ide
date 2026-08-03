import { describe, expect, it } from 'vitest'
import { restorableSessions } from './restorable'
import { SESSION_ID_TOKEN, type Digest, type Project, type RemoteCli } from './model'

const project: Project = { id: 'p', name: 'Canopy', components: [{ label: 'canopy', path: '/work/canopy' }] }
const clis: RemoteCli[] = [
  { id: 'claude', name: 'Claude', command: 'claude', available: true, resumeTemplate: `claude --resume ${SESSION_ID_TOKEN}` },
  { id: 'aider', name: 'Aider', command: 'aider', available: true },
]
const digest = (over: Partial<Digest> = {}): Digest => ({
  session_id: 's1', agent: 'claude', cwd: '/work/canopy', prompts: ['ship it'], updated: 2, ...over,
})

describe('restorableSessions', () => {
  it('uses the verified command and preferred resume directory', () => {
    const [row] = restorableSessions([digest({ resume_cwd: '/work/canopy/sub' })], [], clis, project, [project])
    expect(row).toMatchObject({ cwd: '/work/canopy/sub', command: 'claude --resume s1', prompt: 'ship it' })
  })

  it('excludes live, micro, non-resumable and unsupported sessions', () => {
    const rows = restorableSessions([
      digest({ session_id: 'live' }),
      digest({ session_id: 'micro', micro: true }),
      digest({ session_id: 'no', resumable: false }),
      digest({ session_id: 'aider', agent: 'aider' }),
    ], [{ key: 'live', agent: 'claude', cwd: '/work/canopy', sessionId: 'live', state: 'working', live: true, needsYou: false }], clis, project, [project])
    expect(rows).toEqual([])
  })

  it('keeps separate profiles and carries older same-directory sessions for Forget', () => {
    const rows = restorableSessions([
      digest({ session_id: 'new', updated: 3 }),
      digest({ session_id: 'old', updated: 1 }),
      digest({ session_id: 'personal', profile: 'personal', updated: 2 }),
    ], [], clis, project, [project])
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.profile === 'default')?.superseded.map((item) => item.session_id)).toEqual(['old'])
  })

  it('does not infer user intent from ended or idle state', () => {
    const rows = restorableSessions([digest({ state: 'ended' }), digest({ session_id: 'idle', state: 'idle', profile: 'other' })], [], clis, project, [project])
    expect(rows).toHaveLength(2)
  })

  it('keeps a forgotten session hidden until it has newer activity', () => {
    expect(restorableSessions([digest({ updated: 2 })], [], clis, project, [project], { s1: 3 })).toEqual([])
    expect(restorableSessions([digest({ updated: 4 })], [], clis, project, [project], { s1: 3 })).toHaveLength(1)
  })
})
