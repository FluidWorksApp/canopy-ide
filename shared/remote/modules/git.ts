import type { RemoteManifest } from '../registry'

// Branches, history and worktrees. Every ref-moving command — checkout, commit,
// push, branch delete — is absent from the grant table on purpose: a phone that
// can read the graph is useful, and a phone that can move HEAD under four
// running agents is a support ticket.
const git: RemoteManifest = {
  id: 'git',
  title: 'Git',
  scope: 'project',
  capability: { level: 'view' },
  kinds: ['repo', 'branch', 'commit', 'worktree'],
  commands: [
    { name: 'git_repo_status', scope: 'view' },
    { name: 'git_branches', scope: 'view' },
    { name: 'git_worktrees', scope: 'view' },
    { name: 'git_log', scope: 'view' },
    { name: 'git_commit_detail', scope: 'view' },
    { name: 'git_commit_patch', scope: 'view' },
  ],
  publish: null,
}

export default git
