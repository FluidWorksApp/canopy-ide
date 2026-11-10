# Teleport: move work between this Mac and a remote workspace

Status: design only. Nothing here is built except the pieces marked **exists**.

The goal: from the agent card, choose **To remote** (or **To this Mac**), pick the
workspace, and the agent's session continues there exactly where it was: same
checkout, same changes, same conversation, same model.

## What already exists (reuse, do not rebuild)

| Piece | Where | Covers |
| --- | --- | --- |
| Project mirror | `src-tauri/src/mirror.rs`, `src/remoteExecution/mirror.ts`, `packages/remote-host/mirror-apply.mjs` | Clone on the workspace, same branch and commit, unpushed commits, staged, unstaged and new files, chosen git-ignored files (`files.tgz`, `--skip-old-files`), then reinstall. Skips `node_modules`, `target`, `.git`, `dist`, `build`, `.venv`, caches. Idempotent. |
| One-project setup | `ensureProjectOnRemote` (mirror.ts), `ProjectSetupDialog` | The same for a single project, with progress. |
| Account copy | `execution_remote_import_accounts` | Copies a Claude or Codex login to the workspace; reports `sent`, `skipped`, `notUpdated`. |
| Resume syntax | `AgentCli.resume`, `resumeKeeps` (src/projects.ts), digest `resume_cwd` / `resumable` | The verified command that continues a session, and the flags a resume must repeat so the model does not change. |
| Port forward | `workspace_forward.rs` | Reaching the workspace's servers from this Mac after the move. |

So the "bundle" the request describes is, for the files, the mirror's `files.tgz`
plus a git bundle of unpushed commits. We keep that format and do not add a second
archive. A `.canopy-teleport` manifest (below) wraps the session part and points at
those.

## What is missing

1. **Session transfer.** The agent's transcript is a file in that CLI's own store,
   keyed by the working directory. Moving it means writing it where the CLI on the
   other machine will look, under the other machine's path for the same repository,
   then launching the verified resume command there. This is per CLI: Claude files
   conversations by project path, Codex by thread id with its own rollout store.
   Only CLIs with a verified `resume` and a known store layout can be teleported;
   the others get "files only" with the reason shown.
2. **The reverse direction.** The mirror only goes Mac to workspace. Remote to Mac
   needs the inverse: a git bundle and changed-file archive built on the workspace,
   streamed down, applied to a local clone.
3. **Orchestration and UI.** A "To remote / To this Mac" action on the agent card, a
   workspace picker, a progress view (preparing, sending, applying, resuming), and
   cancel.
4. **Cutover rules.** The source session is stopped (not left running twice), and
   the move is refused while the agent is mid-turn unless the person agrees.

## Project identity: which project work lands in (the contract)

Teleport never guesses where work goes. This is read from the code
(`src/remoteExecution/mirror.ts`, `src/placement/identity.ts`), not assumed.

1. **Project ids are per machine.** The Mac's "Canopy" and the workspace's copy have different ids.
2. **The link is `mirroredFrom`.** The mirror gives the workspace copy a new id and stores the Mac project's id in
   `mirroredFrom`. A copy with `mirrorIncomplete` is not usable and does not count. Two projects are the same project
   if and only if this link says so (`canonicalProjectId`, `counterpartOf`). A matching display name never does.
   *Fixed in this change:* placement used to compare raw ids, so a mirrored project looked "not set up" on the
   workspace forever; it now compares canonical ids.
3. **Components map inside a project** the way the mirror already does it: by label first, then by the component's
   path relative to its repository (`relative`). If neither finds exactly one component, teleport stops and says which.
4. **Repositories map by origin URL.** The workspace path is `/workspace/<workspaceProjectId>/repo-<n>/<relative>`;
   the branch and head are carried, and a destination whose origin does not match is refused.
5. **The working directory of a session** is stored as (project canonical id, component, path relative to the
   component) and rebuilt on the other side from that component's real path. It is never copied as a string.

| Moving | Counterpart found (complete) | No counterpart |
| --- | --- | --- |
| Mac to workspace | Incremental: send the branch, commits and changed files into that component's path. | Full mirror first (creates the workspace project with `mirroredFrom`), then the same. |
| Workspace to Mac | Use the Mac project named by the workspace project's `mirroredFrom`, same component mapping. | A project that began on the workspace has no Mac project: ask to create one. The link then needs the other machine's id too, so `mirroredFrom` gains a sibling `linkedTo: {env, id}[]`. *The field and its lookup (`counterpartOf`) are added and tested; nothing writes it yet.* |

**Teleport stops, and changes nothing, when:** a component match is missing or ambiguous; the repository origin differs;
the destination copy is incomplete; the destination path has uncommitted changes that the move would overwrite
(it never overwrites); the branch is already checked out in another worktree there; or the agent is mid-turn and
you have not agreed. A refusal names the project, the component and the reason.

**One session at a time.** The source session is stopped and its transcript sealed before the destination resumes,
so the same conversation is never live on two machines.

## Manifest (`teleport.json`, inside the bundle)

```json
{
  "version": 1,
  "from": { "kind": "local|remote", "workspaceId": "..." },
  "agent": { "cli": "claude", "sessionId": "...", "model": "...", "resumeKeeps": ["--model", "..."] },
  "repo": { "origin": "...", "branch": "...", "head": "<sha>", "worktree": "relative/path|null",
            "gitBundle": "commits.bundle|null", "filesArchive": "files.tgz" },
  "transcript": { "path": "session.jsonl", "sha256": "...", "cwdFrom": "/Users/..", "cwdTo": null },
  "account": { "copy": false }
}
```

- Every path is relative and validated on receipt (no `..`, no absolute paths, size
  caps), exactly as `execution_mirror_send` does for extra files.
- The transcript is hash-checked, and any recorded working directory is rewritten to
  the destination's path, because resume depends on it.
- A worktree is recreated from the same branch and head; its uncommitted changes
  ride in `files.tgz`.

## Decisions that need the owner

- **Credentials.** The request says to teleport "the token". The account copy
  already exists but it moves a login to another machine. Default: off, asked every
  time, never part of a stored bundle.
- **Secrets in files.** Credential-shaped ignored files start unchecked, as in the
  setup dialog. The same rule applies here.
- **Source after the move.** Stop it (recommended) or leave it paused for a way back.
- **Unsupported CLIs.** Files only, or refuse.

## Phases

1. **Local to remote, one project, files only.** *Built:* the card's "To a workspace" row opens a picker of ready
   workspaces, connects through a temporary connection (`src/remoteExecution/temporaryWorkspace.ts`, which cannot
   overwrite the saved active workspace) and runs the existing project setup against it with its progress view
   (`SendToWorkspace.tsx`). The window stays where it is. No session move. Not verified against a real workspace.
2. **Session move for Claude** (verified resume): copy transcript, rewrite cwd,
   launch the resume command on the workspace, stop the local one.
3. **Remote to local** for the same CLI.
4. **More CLIs**, one at a time, each only after its store layout and resume are
   verified against the real binary.

## Not covered

Terminal scrollback, running dev servers, installed packages (reinstalled), and OS
specific tools. The mirror's own `STAYS_ON_MAC` list is the user-facing statement of
this and is reused.
