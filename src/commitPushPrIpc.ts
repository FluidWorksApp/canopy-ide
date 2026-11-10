// The commit, push and PR flow wired to the real git and `gh` commands.
import * as ipc from "./ipc";
import { commitMessageWithSessions } from "./sessionDoc/trailers";
import { commitPushPr, type FlowDeps, type FlowOptions, type FlowResult } from "./commitPushPr";

export const ipcFlowDeps: FlowDeps = {
  status: (repo) => ipc.gitStatus(repo),
  stage: (repo, paths) => ipc.gitStage(repo, paths),
  commit: (repo, message) => ipc.gitCommit(repo, message),
  push: (repo, setUpstream) => ipc.gitPush(repo, setUpstream),
  prContext: (repo, base) => ipc.gitPrContext(repo, base),
  createPr: (repo, base, head, title, body, draft) => ipc.ghPrCreate(repo, base, head, title, body, draft),
  withTrailers: (repo, message) => commitMessageWithSessions(repo, message),
};

export const runCommitPushPr = (opts: FlowOptions): Promise<FlowResult> => commitPushPr(ipcFlowDeps, opts);
