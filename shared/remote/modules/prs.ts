import type { RemoteManifest } from '../registry'

// Open pull requests across the open projects, with their diffs — reviewing on
// a tablet is the case this earns its place for. Approving is not granted:
// `gh_pr_review` posts under the user's identity, which is a decision to make
// somewhere you can read the whole diff.
const prs: RemoteManifest = {
  id: 'prs',
  title: 'Pull requests',
  scope: 'project',
  capability: { level: 'view' },
  kinds: ['pr'],
  commands: [
    { name: 'gh_pr_list', scope: 'view' },
    { name: 'gh_pr_diff', scope: 'view' },
    { name: 'gh_pr_body', scope: 'view' },
  ],
  publish: null,
}

export default prs
