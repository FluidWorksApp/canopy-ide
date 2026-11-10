import { describe, expect, it } from "vitest";
import { bundlePathIssue, parseTeleportManifest, validateTeleportManifest, type TeleportManifest } from "./manifest";

const good = (): TeleportManifest => ({
  version: 1,
  from: { kind: "local" },
  agent: { cli: "claude", sessionId: "0a1b2c3d-1111-2222-3333-444455556666", model: "m-1", resumeKeeps: ["--model", "m-1"] },
  repo: {
    origin: "git@example.com:org/repo.git",
    branch: "main",
    head: "a".repeat(40),
    worktree: null,
    gitBundle: "commits.bundle",
    filesArchive: "files.tgz",
  },
  transcript: { path: "session.jsonl", sha256: "b".repeat(64), cwdFrom: "/Users/me/repo", cwdTo: null },
  account: { copy: false },
});

const errorsFor = (m: unknown) => {
  const r = validateTeleportManifest(m);
  return r.ok ? [] : r.errors;
};
const mutate = (f: (m: any) => void) => {
  const m: any = good();
  f(m);
  return m;
};

describe("validateTeleportManifest", () => {
  it("accepts a valid manifest and returns it", () => {
    const m = good();
    expect(validateTeleportManifest(m)).toEqual({ ok: true, manifest: m });
  });

  it("accepts remote with workspaceId, a worktree, and a sha256 git head", () => {
    const m = mutate((x) => {
      x.from = { kind: "remote", workspaceId: "ws_1" };
      x.repo.worktree = "wt/feature";
      x.repo.head = "c".repeat(64);
      x.transcript.cwdTo = "/home/dev/repo";
    });
    expect(validateTeleportManifest(m).ok).toBe(true);
  });

  it("accepts null origin/branch and a null gitBundle", () => {
    const m = mutate((x) => {
      x.repo.origin = null;
      x.repo.branch = null;
      x.repo.gitBundle = null;
    });
    expect(validateTeleportManifest(m).ok).toBe(true);
  });

  it.each([null, undefined, 5, "x", []])("rejects non-object %s", (v) => {
    expect(errorsFor(v)).toEqual(["manifest must be an object"]);
  });

  it.each([0, 2, "1", undefined, null])("rejects version %s", (v) => {
    expect(errorsFor(mutate((m) => (m.version = v)))).toContain("version must be 1");
  });

  it("rejects unknown fields at every level", () => {
    expect(errorsFor(mutate((m) => (m.extra = 1)))).toContain("manifest.extra is not a known field");
    expect(errorsFor(mutate((m) => (m.repo.extra = 1)))).toContain("repo.extra is not a known field");
    expect(errorsFor(mutate((m) => (m.account.token = "x")))).toContain("account.token is not a known field");
  });

  it("rejects missing sections", () => {
    for (const k of ["from", "agent", "repo", "transcript", "account"]) {
      expect(errorsFor(mutate((m) => delete m[k]))).toContain(`${k} must be an object`);
    }
  });

  describe("from", () => {
    it.each(["cloud", "", "LOCAL", 1, undefined])("rejects kind %s", (k) => {
      expect(errorsFor(mutate((m) => (m.from.kind = k)))).toContain('from.kind must be "local" or "remote"');
    });
    it("requires workspaceId for remote", () => {
      expect(errorsFor(mutate((m) => (m.from = { kind: "remote" })))).toContain("from.workspaceId is required when from.kind is remote");
    });
    it("rejects an empty or oversized workspaceId", () => {
      expect(errorsFor(mutate((m) => (m.from = { kind: "local", workspaceId: "" })))).not.toEqual([]);
      expect(errorsFor(mutate((m) => (m.from = { kind: "local", workspaceId: "w".repeat(257) })))).not.toEqual([]);
    });
  });

  describe("agent", () => {
    it.each([undefined, null, 5, {}, ["claude"], "", "-claude", "a b", "a/b", "../x", "a".repeat(65)])("rejects cli %j", (cli) => {
      expect(errorsFor(mutate((m) => (m.agent.cli = cli))).some((e) => e.startsWith("agent.cli"))).toBe(true);
    });
    it.each(["claude", "codex", "my-cli_2.0"])("accepts cli %s", (cli) => {
      expect(validateTeleportManifest(mutate((m) => (m.agent.cli = cli))).ok).toBe(true);
    });
    it.each(["", "../etc", "a/b", "a\\b", ".hidden", "a b", "x".repeat(129), 7, null])("rejects sessionId %j", (id) => {
      expect(errorsFor(mutate((m) => (m.agent.sessionId = id))).some((e) => e.startsWith("agent.sessionId"))).toBe(true);
    });
    it("rejects bad model and resumeKeeps", () => {
      expect(errorsFor(mutate((m) => (m.agent.model = 3)))).toContain("agent.model must be a string");
      expect(errorsFor(mutate((m) => (m.agent.resumeKeeps = "--model")))).not.toEqual([]);
      expect(errorsFor(mutate((m) => (m.agent.resumeKeeps = [1])))).toContain("agent.resumeKeeps[0] must be a string");
      expect(errorsFor(mutate((m) => (m.agent.resumeKeeps = Array(33).fill("--x"))))).not.toEqual([]);
    });
    it("allows model and resumeKeeps to be absent", () => {
      expect(validateTeleportManifest(mutate((m) => { delete m.agent.model; delete m.agent.resumeKeeps; })).ok).toBe(true);
    });
  });

  describe("bundle paths", () => {
    const fields: Array<[string, (m: any, v: unknown) => void]> = [
      ["repo.worktree", (m, v) => (m.repo.worktree = v)],
      ["repo.gitBundle", (m, v) => (m.repo.gitBundle = v)],
      ["repo.filesArchive", (m, v) => (m.repo.filesArchive = v)],
      ["transcript.path", (m, v) => (m.transcript.path = v)],
    ];
    const bad = ["/etc/passwd", "..", "../x", "a/../b", "a/..", "./a", "a/./b", "a//b", "a/", "", "C:\\x", "C:/x", "~/x", "a\\b", "a\u0000b", "a".repeat(513), `${"a".repeat(256)}/b`];
    for (const [name, set] of fields) {
      it.each(bad)(`${name} rejects %j`, (v) => {
        expect(errorsFor(mutate((m) => set(m, v))).some((e) => e.startsWith(name))).toBe(true);
      });
      it(`${name} rejects non-strings`, () => {
        expect(errorsFor(mutate((m) => set(m, 5))).some((e) => e.startsWith(name))).toBe(true);
      });
    }
    it("filesArchive and transcript.path may not be null", () => {
      expect(errorsFor(mutate((m) => (m.repo.filesArchive = null)))).not.toEqual([]);
      expect(errorsFor(mutate((m) => (m.transcript.path = null)))).not.toEqual([]);
    });
    it("bundlePathIssue accepts normal nested paths", () => {
      expect(bundlePathIssue("a/b/c.tgz")).toBeNull();
      expect(bundlePathIssue("a..b/c")).toBeNull();
      expect(bundlePathIssue(`${"a".repeat(255)}/${"a".repeat(255)}`)).toBeNull();
    });
  });

  describe("repo", () => {
    it.each(["", "abc", "A".repeat(40), "g".repeat(40), "a".repeat(39), "a".repeat(41), 5, undefined])("rejects head %j", (h) => {
      expect(errorsFor(mutate((m) => (m.repo.head = h))).some((e) => e.startsWith("repo.head"))).toBe(true);
    });
    it("rejects oversized origin", () => {
      expect(errorsFor(mutate((m) => (m.repo.origin = "x".repeat(2049)))).length).toBe(1);
    });
  });

  describe("transcript", () => {
    it.each(["", "B".repeat(64), "b".repeat(63), "b".repeat(65), "z".repeat(64), 1, undefined])("rejects sha256 %j", (h) => {
      expect(errorsFor(mutate((m) => (m.transcript.sha256 = h))).some((e) => e.startsWith("transcript.sha256"))).toBe(true);
    });
    it.each(["relative/path", "", "~/x", "x".repeat(4097), "/a\nb", 3])("rejects cwdFrom %j", (c) => {
      expect(errorsFor(mutate((m) => (m.transcript.cwdFrom = c))).some((e) => e.startsWith("transcript.cwdFrom"))).toBe(true);
    });
    it("rejects a relative cwdTo but allows null and Windows drive paths", () => {
      expect(errorsFor(mutate((m) => (m.transcript.cwdTo = "rel")))).not.toEqual([]);
      expect(validateTeleportManifest(mutate((m) => (m.transcript.cwdFrom = "C:\\Users\\me\\repo"))).ok).toBe(true);
    });
    it("cwdFrom is required", () => {
      expect(errorsFor(mutate((m) => delete m.transcript.cwdFrom))).toContain("transcript.cwdFrom must be a string");
    });
  });

  it("account.copy must be a boolean", () => {
    expect(errorsFor(mutate((m) => (m.account.copy = "no")))).toContain("account.copy must be a boolean");
  });

  it("reports several problems at once", () => {
    const errors = errorsFor(mutate((m) => { m.version = 9; m.repo.filesArchive = "../x"; m.agent.cli = 1; }));
    expect(errors.length).toBe(3);
  });
});

describe("parseTeleportManifest", () => {
  it("round-trips valid JSON text", () => {
    expect(parseTeleportManifest(JSON.stringify(good()))).toEqual({ ok: true, manifest: good() });
  });
  it("rejects invalid JSON without throwing", () => {
    expect(parseTeleportManifest("{nope")).toEqual({ ok: false, errors: ["manifest is not valid JSON"] });
    expect(parseTeleportManifest("")).toEqual({ ok: false, errors: ["manifest is not valid JSON"] });
  });
  it("rejects oversized text before parsing", () => {
    const r = parseTeleportManifest(" ".repeat(64 * 1024 + 1));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/larger than/);
  });
  it("counts bytes, not characters", () => {
    const r = parseTeleportManifest("\u00e9".repeat(33 * 1024));
    expect(!r.ok && r.errors[0]).toMatch(/larger than/);
  });
  it("does not let __proto__ keys through as known fields", () => {
    const r = parseTeleportManifest(JSON.stringify(good()).replace('"version":1', '"version":1,"__proto__":{"x":1}'));
    expect(r.ok).toBe(false);
  });
});
