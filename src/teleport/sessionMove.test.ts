import { describe, expect, it, vi } from "vitest";
import {
  checkMove,
  linkBoth,
  matchComponent,
  rebaseCwd,
  relativeUnder,
  runMove,
  withLink,
  type CheckInput,
  type MoveAgent,
  type MoveDeps,
  type MoveProject,
} from "./sessionMove";
import { claudeTranscriptPath } from "./claudeTranscript";

const sourceProject: MoveProject = {
  id: "mac-1",
  name: "Canopy",
  components: [
    { id: "c1", label: "canopy", path: "/Users/me/canopy", relative: "" },
    { id: "c2", label: "site", path: "/Users/me/site", relative: "" },
  ],
};
const destProject: MoveProject = {
  id: "ws-9",
  name: "Canopy",
  mirroredFrom: "mac-1",
  components: [
    { id: "d1", label: "canopy", path: "/workspace/ws-9/repo-1", relative: "" },
    { id: "d2", label: "site", path: "/workspace/ws-9/repo-2", relative: "" },
  ],
};
const agent: MoveAgent = {
  cli: "claude",
  sessionId: "s-1",
  model: "sonnet",
  resumeKeeps: ["--model", "sonnet"],
  cwd: "/Users/me/canopy/src",
  idle: true,
};
const repo = { origin: "git@github.com:x/canopy.git", branch: "agent/c-1", head: "a".repeat(40) };

const input = (over: Partial<CheckInput> = {}): CheckInput => ({
  agent,
  source: { env: "local", project: sourceProject, home: "/Users/me" },
  dest: { env: "remote:ws", home: "/home/w" },
  destProjects: [destProject],
  sourceRepo: repo,
  destRepo: repo,
  destDirty: false,
  branchHeldElsewhere: false,
  ...over,
});

describe("paths", () => {
  it("relativeUnder and rebaseCwd only move paths that are under the root", () => {
    expect(relativeUnder("/a/b", "/a/b/c")).toBe("c");
    expect(relativeUnder("/a/b", "/a/bc")).toBeNull();
    expect(rebaseCwd("/Users/me/canopy/src", "/Users/me/canopy", "/workspace/w/repo-1")).toBe("/workspace/w/repo-1/src");
    expect(rebaseCwd("/Users/me/canopy", "/Users/me/canopy", "/workspace/w/repo-1/")).toBe("/workspace/w/repo-1");
    expect(rebaseCwd("/elsewhere", "/Users/me/canopy", "/x")).toBeNull();
  });
});

describe("matchComponent", () => {
  const src = { id: "a", label: "app", path: "/p", relative: "packages/app" };
  it("matches by label, then by relative path, never by guess", () => {
    expect(matchComponent(src, [{ id: "1", label: "app", path: "/q" }])).toMatchObject({ ok: true });
    expect(matchComponent(src, [{ id: "1", label: "web", path: "/q", relative: "packages/app" }])).toMatchObject({ ok: true });
    expect(matchComponent(src, [{ id: "1", label: "web", path: "/q" }])).toMatchObject({ ok: false });
    expect(
      matchComponent(src, [
        { id: "1", label: "app", path: "/q" },
        { id: "2", label: "app", path: "/r" },
      ]),
    ).toMatchObject({ ok: false });
    expect(
      matchComponent(src, [
        { id: "1", label: "app", path: "/q", relative: "x" },
        { id: "2", label: "app", path: "/r", relative: "packages/app" },
      ]),
    ).toMatchObject({ ok: true, component: { id: "2" } });
  });
});

describe("checkMove", () => {
  it("accepts a linked, idle, matching move and names the components", () => {
    const r = checkMove(input());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.destComponent.id).toBe("d1");
      expect(r.plan.sourceComponent.id).toBe("c1");
    }
  });

  it("works the other way: the workspace copy as source finds the Mac project", () => {
    const r = checkMove(
      input({
        source: { env: "remote:ws", project: destProject, home: "/home/w" },
        dest: { env: "local", home: "/Users/me" },
        destProjects: [sourceProject],
        agent: { ...agent, cwd: "/workspace/ws-9/repo-1/src" },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.destComponent.path).toBe("/Users/me/canopy");
  });

  it("never matches by name alone", () => {
    const r = checkMove(input({ destProjects: [{ ...destProject, mirroredFrom: undefined }] }));
    expect(r).toMatchObject({ ok: false });
  });

  it("a workspace-born project is found through linkedTo", () => {
    const born: MoveProject = { ...destProject, mirroredFrom: undefined, linkedTo: [{ env: "local", id: "mac-1" }] };
    expect(checkMove(input({ destProjects: [born] })).ok).toBe(true);
  });

  it("collects every reason, each plain", () => {
    const r = checkMove(
      input({
        agent: { ...agent, cli: "codex", idle: false, cwd: "/nowhere" },
        destProjects: [{ ...destProject, mirrorIncomplete: true }],
        destRepo: { ...repo, origin: "other" },
        destDirty: true,
        branchHeldElsewhere: true,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.reasons.join("\n");
      expect(text).toMatch(/codex sessions cannot be moved/);
      expect(text).toMatch(/mid-turn/);
      expect(text).toMatch(/partly copied/);
      expect(text).toMatch(/not inside a component/);
      expect(text).toMatch(/points somewhere else/);
      expect(text).toMatch(/uncommitted changes/);
      expect(text).toMatch(/another worktree/);
    }
  });

  it("a busy agent moves only when the person agreed", () => {
    expect(checkMove(input({ agent: { ...agent, idle: false } })).ok).toBe(false);
    expect(checkMove(input({ agent: { ...agent, idle: false }, allowBusy: true })).ok).toBe(true);
  });

  it("refuses when there is no counterpart, no repository copy, or an ambiguous component", () => {
    expect(checkMove(input({ destProjects: [] }))).toMatchObject({ ok: false });
    expect(checkMove(input({ destRepo: null }))).toMatchObject({ ok: false });
    const ambiguous = { ...destProject, components: [destProject.components[0], { ...destProject.components[0], id: "dup", path: "/x" }] };
    const r = checkMove(input({ destProjects: [ambiguous] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toMatch(/matches 2 components/);
  });
});

describe("links", () => {
  it("adds a link once, never to itself", () => {
    const a = withLink(sourceProject, "remote:ws", "ws-9");
    expect(a.linkedTo).toEqual([{ env: "remote:ws", id: "ws-9" }]);
    expect(withLink(a, "remote:ws", "ws-9")).toBe(a);
    expect(withLink(sourceProject, "local", "mac-1")).toBe(sourceProject);
  });
  it("points both records at each other", () => {
    const { source, dest } = linkBoth({ env: "local", project: sourceProject }, { env: "remote:ws", project: destProject });
    expect(source.linkedTo).toEqual([{ env: "remote:ws", id: "ws-9" }]);
    expect(dest.linkedTo).toEqual([{ env: "local", id: "mac-1" }]);
  });
});

const line = (extra: object) => JSON.stringify({ sessionId: "s-1", ...extra });
const transcript = `${line({ cwd: "/Users/me/canopy/src", type: "user" })}\n${line({ type: "assistant", cwd: "/Users/me/canopy" })}\n`;

function setup(over: Partial<MoveDeps> = {}) {
  const check = checkMove(input());
  if (!check.ok) throw new Error("setup");
  const calls: string[] = [];
  const written = new Map<string, string>();
  const deps: MoveDeps = {
    selection: {},
    sourceRoot: "/Users/me/canopy",
    repo: { ...repo, worktree: null },
    sendFiles: vi.fn(async () => (calls.push("send"), { destRoot: "/workspace/ws-9/repo-1" })),
    stopSource: vi.fn(async () => void calls.push("stop")),
    restoreSource: vi.fn(async () => void calls.push("restore")),
    readTranscript: vi.fn(async (p) => (calls.push(`read:${p}`), transcript)),
    sha256: async (t) => String(t.length).padStart(64, "a"),
    writeTranscript: vi.fn(async (_p, path, text) => void (calls.push("write"), written.set(path, text))),
    readBackTranscript: vi.fn(async (_p, path) => written.get(path) ?? ""),
    resumeTarget: vi.fn(async () => void calls.push("resume")),
    saveLinks: vi.fn(async () => void calls.push("links")),
    ...over,
  };
  return { plan: check.plan, deps, calls, written };
}

describe("runMove", () => {
  it("sends files, then seals the source, then writes the rewritten transcript, then resumes and links", async () => {
    const { plan, deps, calls, written } = setup();
    const steps: string[] = [];
    deps.onStep = (s, state) => state !== "start" || steps.push(s);
    const out = await runMove(plan, { ...deps, onStep: (s, st) => st === "done" && steps.push(s) });
    expect(out).toMatchObject({ ok: true });
    expect(steps).toEqual(["prepare", "send", "apply", "resume"]);
    // order: files, stop, read the final transcript, write, resume, links
    expect(calls.map((c) => c.split(":")[0])).toEqual(["send", "stop", "read", "write", "resume", "links"]);
    const destPath = claudeTranscriptPath("/home/w", "/workspace/ws-9/repo-1/src", "s-1");
    expect(written.get(destPath)).toContain('"cwd":"/workspace/ws-9/repo-1/src"');
    expect(written.get(destPath)).not.toContain("/Users/me");
    expect(deps.resumeTarget).toHaveBeenCalledWith(plan, {
      sessionId: "s-1",
      cwd: "/workspace/ws-9/repo-1/src",
      model: "sonnet",
      resumeKeeps: ["--model", "sonnet"],
    });
    if (out.ok) {
      expect(out.manifest.transcript.cwdTo).toBe("/workspace/ws-9/repo-1/src");
      expect(out.manifest.account.copy).toBe(false);
    }
    const links = (deps.saveLinks as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(links.source.linkedTo).toEqual([{ env: "remote:ws", id: "ws-9" }]);
    expect(links.dest.linkedTo).toEqual([{ env: "local", id: "mac-1" }]);
  });

  it("a failed send changes nothing: the source is never stopped", async () => {
    const { plan, deps } = setup({ sendFiles: vi.fn(async () => Promise.reject(new Error("network"))) });
    const out = await runMove(plan, deps);
    expect(out).toMatchObject({ ok: false, step: "send", sourceStopped: false });
    expect(deps.stopSource).not.toHaveBeenCalled();
    expect(deps.resumeTarget).not.toHaveBeenCalled();
  });

  it("a failure after the stop tries to bring the source back", async () => {
    const { plan, deps } = setup({ writeTranscript: vi.fn(async () => Promise.reject(new Error("disk full"))) });
    const out = await runMove(plan, deps);
    expect(out).toMatchObject({ ok: false, step: "apply", sourceStopped: true, sourceRestored: true });
    expect(deps.resumeTarget).not.toHaveBeenCalled();
  });

  it("a transcript that does not read back identically fails before resuming", async () => {
    const { plan, deps } = setup({ readBackTranscript: vi.fn(async () => "tampered") });
    const out = await runMove(plan, deps);
    expect(out).toMatchObject({ ok: false, step: "apply" });
    expect(deps.resumeTarget).not.toHaveBeenCalled();
  });

  it("a transcript from another session is refused", async () => {
    const { plan, deps } = setup({ readTranscript: vi.fn(async () => JSON.stringify({ sessionId: "other", cwd: "/Users/me/canopy" }) + "\n") });
    const out = await runMove(plan, deps);
    expect(out).toMatchObject({ ok: false, step: "apply" });
  });

  it("cancelling before the source is stopped leaves both sides alone", async () => {
    let cancelled = false;
    const { plan, deps } = setup({
      sendFiles: vi.fn(async () => ((cancelled = true), { destRoot: "/workspace/ws-9/repo-1" })),
      isCancelled: () => cancelled,
    });
    const out = await runMove(plan, deps);
    expect(out).toMatchObject({ ok: false, step: "send", error: "Cancelled", sourceStopped: false });
    expect(deps.stopSource).not.toHaveBeenCalled();
  });

  it("failing to save links does not turn a finished move into a failure", async () => {
    const { plan, deps } = setup({ saveLinks: vi.fn(async () => Promise.reject(new Error("store"))) });
    expect((await runMove(plan, deps)).ok).toBe(true);
  });

  it("refuses a session id that is not safe as a filename", async () => {
    const { plan, deps } = setup();
    const out = await runMove({ ...plan, agent: { ...plan.agent, sessionId: "../x" } }, deps);
    expect(out).toMatchObject({ ok: false, step: "prepare" });
    expect(deps.sendFiles).not.toHaveBeenCalled();
  });
});

describe("worktree agents and carried commits", () => {
  const wtAgent: MoveAgent = {
    ...agent,
    cwd: "/Users/me/canopy-wt-lineage/src",
    worktree: { root: "/Users/me/canopy-wt-lineage", repo: "/Users/me/canopy", branch: "agent/c-1" },
  };
  it("an agent in a worktree belongs to the component that is its main checkout", () => {
    const r = checkMove(input({ agent: wtAgent, destRepo: { ...repo, branch: "main" } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.sourceComponent.id).toBe("c1");
  });
  it("without the worktree record the same folder is outside every component", () => {
    const r = checkMove(input({ agent: { ...wtAgent, worktree: undefined } }));
    expect(r.ok).toBe(false);
  });
  it("refuses a folder that is not inside its own worktree", () => {
    const r = checkMove(input({ agent: { ...wtAgent, cwd: "/Users/me/elsewhere" } }));
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reasons.join(" ")).toMatch(/not inside its workspace/);
  });
  it("a destination on another branch is refused for an ordinary agent, not for a worktree agent", () => {
    const other = { ...repo, branch: "main" };
    const plain = checkMove(input({ destRepo: other }));
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.reasons.join(" ")).toMatch(/on main, not agent\/c-1/);
    expect(checkMove(input({ agent: wtAgent, destRepo: other })).ok).toBe(true);
  });
  it("records the worktree and the carried commits in the manifest, and moves the whole worktree root", async () => {
    const check = checkMove(input({ agent: wtAgent, destRepo: { ...repo, branch: "main" } }));
    if (!check.ok) throw new Error("setup");
    const written = new Map<string, string>();
    const wtTranscript = `${line({ cwd: "/Users/me/canopy-wt-lineage/src", type: "user" })}\n`;
    const out = await runMove(check.plan, {
      selection: {},
      sourceRoot: "/Users/me/canopy-wt-lineage",
      repo: { ...repo, worktree: null },
      sendFiles: async () => ({ destRoot: "/workspace/ws-9/repo-1-wt-lineage", carriedCommits: true }),
      stopSource: async () => {},
      readTranscript: async () => wtTranscript,
      sha256: async (t) => String(t.length).padStart(64, "a"),
      writeTranscript: async (_p, path, text) => void written.set(path, text),
      readBackTranscript: async (_p, path) => written.get(path) ?? "",
      resumeTarget: async () => {},
      saveLinks: async () => {},
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.manifest.repo.worktree).toBe("canopy-wt-lineage");
      expect(out.manifest.repo.gitBundle).toBe("commits.bundle");
      expect(out.destCwd).toBe("/workspace/ws-9/repo-1-wt-lineage/src");
    }
  });
  it("a plain agent records no worktree and no bundle when none was carried", async () => {
    const { plan, deps } = setup();
    const out = await runMove(plan, deps);
    expect(out.ok && out.manifest.repo.worktree === null && out.manifest.repo.gitBundle === null).toBe(true);
  });
  it("the reverse direction (a workspace to this Mac) runs through the same steps", async () => {
    const reverseInput: CheckInput = {
      agent: { ...agent, cwd: "/workspace/ws-9/repo-1/src" },
      source: { env: "remote:ws", project: destProject, home: "/home/w" },
      dest: { env: "local", home: "/Users/me" },
      destProjects: [sourceProject],
      sourceRepo: repo,
      destRepo: repo,
      destDirty: false,
      branchHeldElsewhere: false,
    };
    const check = checkMove(reverseInput);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const written = new Map<string, string>();
    const out = await runMove(check.plan, {
      selection: {},
      sourceRoot: "/workspace/ws-9/repo-1",
      repo: { ...repo, worktree: null },
      sendFiles: async () => ({ destRoot: "/Users/me/canopy" }),
      stopSource: async () => {},
      readTranscript: async () => `${line({ cwd: "/workspace/ws-9/repo-1/src", type: "user" })}\n`,
      sha256: async (t) => String(t.length).padStart(64, "a"),
      writeTranscript: async (_p, path, text) => void written.set(path, text),
      readBackTranscript: async (_p, path) => written.get(path) ?? "",
      resumeTarget: async () => {},
      saveLinks: async () => {},
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.manifest.from).toEqual({ kind: "remote", workspaceId: "ws" });
      expect(out.destCwd).toBe("/Users/me/canopy/src");
    }
  });
});
