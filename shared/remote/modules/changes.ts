import type { RemoteManifest } from '../registry'

// What the working tree has that HEAD doesn't — the panel you actually want on
// a phone, because it answers "what did the agent just do to my repo?".
//
// Read-only: `git_stage` / `git_discard` / `git_commit` are not granted. Seeing
// the diff is the point; committing from a train is not.
const changes: RemoteManifest = {
  id: 'changes',
  title: 'Changes',
  scope: 'project',
  capability: { level: 'view' },
  kinds: ['change'],
  commands: [
    { name: 'git_status', scope: 'view' },
    { name: 'git_diff', scope: 'view' },
  ],
  publish: null,
}

export default changes
