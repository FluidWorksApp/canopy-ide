import type { RemoteManifest } from '../registry'

// The tree the IDE shows, read-only. Every command behind it resolves through
// `check_scope` in Rust, so this reaches the workspaces the user added and
// nothing above them — a remote token can read the project, not the disk.
//
// No write commands, deliberately: editing from a phone is a different feature
// with a different risk, and leaving `fs_write_file` off the grant table is what
// says so.
const files: RemoteManifest = {
  id: 'files',
  title: 'Files',
  scope: 'project',
  capability: { level: 'view' },
  kinds: ['dir', 'file'],
  commands: [
    { name: 'fs_read_dir', scope: 'view' },
    { name: 'fs_read_file', scope: 'view' },
    { name: 'fs_list_files', scope: 'view' },
    { name: 'fs_search', scope: 'view' },
  ],
  publish: null,
}

export default files
