import { describe, expect, it } from "vitest";
import { claudeProjectDirName, claudeTranscriptPath, mapClaudeTranscript } from "./claudeTranscript";

const SID = "0a1b2c3d-1111-2222-3333-444455556666";
const SRC = "/Users/me/.work/my_repo";
const DST = "/home/dev/work/repo";

// Synthetic lines shaped like real ones; no real conversation text.
const L = {
  queue: `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-01-01T00:00:00.000Z","sessionId":"${SID}"}`,
  user: `{"type":"user","cwd":"${SRC}","sessionId":"${SID}","message":{"role":"user","content":"hello \\"cwd\\":\\"${SRC}\\""},"uuid":"u1"}`,
  assistant: `{ "type" : "assistant", "cwd" : "${SRC}/packages/app", "sessionId":"${SID}", "n": 1.0, "e":"\\u00e9\\/" }`,
  attach: `{"type":"attachment","cwd":"${SRC}","sessionId":"${SID}","attachment":{"snapshot":{"workingDirectory":"${SRC}","additionalWorkingDirectories":["${SRC}/x"]}}}`,
  classifier: `{"type":"user","cwd":"${SRC}","sessionId":"${SID}","serverClassifierContext":{"context":{"live_cwd":"${SRC}","git_state":{"cwd":"${SRC}","root":"${SRC}"}}}}`,
  outside: `{"type":"system","cwd":"/tmp/elsewhere","sessionId":"${SID}"}`,
  none: `{"type":"file-history-snapshot","snapshot":{"trackedFileBackups":{}}}`,
};
const join = (...ls: string[]) => ls.join("\n") + "\n";
const map = (t: string, extra: object = {}) => mapClaudeTranscript({ transcript: t, sourceCwd: SRC, destCwd: DST, ...extra });

describe("claudeProjectDirName", () => {
  it.each([
    ["/Users/shoaib", "-Users-shoaib"],
    ["/Users/shoaib/.canopy/companion", "-Users-shoaib--canopy-companion"],
    ["/Users/shoaib/.t3/worktrees/banana-server/t3-a54ed4dc", "-Users-shoaib--t3-worktrees-banana-server-t3-a54ed4dc"],
    ["/private/var/folders/d1/ab_cd/T/x", "-private-var-folders-d1-ab-cd-T-x"],
    ["/home/dev/my repo", "-home-dev-my-repo"],
  ])("%s -> %s", (p, d) => expect(claudeProjectDirName(p)).toBe(d));
});

describe("claudeTranscriptPath", () => {
  it("builds the store path under the given home", () => {
    expect(claudeTranscriptPath("/home/dev", DST, SID)).toBe(`/home/dev/.claude/projects/-home-dev-work-repo/${SID}.jsonl`);
    expect(claudeTranscriptPath("/Users/me/", "/a/.b", "s1")).toBe("/Users/me/.claude/projects/-a--b/s1.jsonl");
  });
  it.each(["", "../x", "a/b", "a\\b", ".", "..", ".hidden", "a b"])("rejects session id %j", (id) => {
    expect(() => claudeTranscriptPath("/h", "/c", id)).toThrow();
  });
  it("rejects relative home or cwd", () => {
    expect(() => claudeTranscriptPath("h", "/c", "s")).toThrow();
    expect(() => claudeTranscriptPath("/h", "c", "s")).toThrow();
  });
});

describe("mapClaudeTranscript", () => {
  it("rewrites cwd, workingDirectory and live_cwd, nothing else", () => {
    const t = join(L.queue, L.user, L.assistant, L.attach, L.classifier, L.none);
    const r = map(t);
    expect(r.sessionId).toBe(SID);
    expect(r.lines).toBe(6);
    expect(r.rewritten).toBe(7); // user, assistant, attach x2, classifier cwd + live_cwd + git_state.cwd
    const out = r.text.split("\n");
    const inn = t.split("\n");
    // lines with no cwd key are byte-identical
    expect(out[0]).toBe(inn[0]);
    expect(out[5]).toBe(inn[5]);
    // the changed lines differ only in the replaced path
    expect(JSON.parse(out[1]).cwd).toBe(DST);
    expect(JSON.parse(out[2]).cwd).toBe(`${DST}/packages/app`);
    expect(JSON.parse(out[3]).attachment.snapshot.workingDirectory).toBe(DST);
    expect(JSON.parse(out[4]).serverClassifierContext.context.live_cwd).toBe(DST);
  });

  it("is byte-for-byte outside the replaced strings (spacing, escapes, number forms)", () => {
    const r = map(join(L.assistant));
    expect(r.text).toBe(join(L.assistant).replace(`"${SRC}/packages/app"`, `"${DST}/packages/app"`));
    expect(r.text).toContain('"n": 1.0');
    expect(r.text).toContain("\\u00e9\\/");
  });

  it("does not touch the text of a message that merely mentions a cwd", () => {
    const r = map(join(L.user));
    const msg = JSON.parse(r.text).message.content as string;
    expect(msg).toBe(`hello "cwd":"${SRC}"`);
  });

  it("leaves other path-bearing fields alone", () => {
    const r = map(join(L.classifier, L.attach));
    expect(r.text).toContain(`"root":"${SRC}"`);
    expect(r.text).toContain(`"git_state":{"cwd":"${DST}"`); // any key named cwd moves
    expect(r.text).toContain(`"additionalWorkingDirectories":["${SRC}/x"]`);
  });

  it("counts cwd values outside the source and leaves them", () => {
    const r = map(join(L.user, L.outside));
    expect(r.rewritten).toBe(1);
    expect(r.outsideSource).toBe(1);
    expect(r.text).toContain('"cwd":"/tmp/elsewhere"');
  });

  it("matches on a path boundary, not a string prefix", () => {
    const line = `{"cwd":"${SRC}-other","sessionId":"${SID}"}`;
    const r = map(line + "\n");
    expect(r.rewritten).toBe(0);
    expect(r.text).toBe(line + "\n");
  });

  it("tolerates trailing slashes and a root destination", () => {
    const r = mapClaudeTranscript({ transcript: join(L.assistant), sourceCwd: `${SRC}/`, destCwd: "/" });
    expect(JSON.parse(r.text).cwd).toBe("/packages/app");
  });

  it("escapes destinations that need JSON escaping", () => {
    const r = mapClaudeTranscript({ transcript: join(L.user), sourceCwd: SRC, destCwd: '/we"ird\\dir' });
    expect(JSON.parse(r.text).cwd).toBe('/we"ird\\dir');
  });

  it("decodes escaped source values before comparing", () => {
    const line = `{"cwd":"\\/Users\\/me\\/.work\\/my_repo","sessionId":"${SID}"}`;
    expect(JSON.parse(map(line).text).cwd).toBe(DST);
  });

  it("keeps CRLF and a missing final newline", () => {
    const t = `${L.user}\r\n${L.queue}`;
    const r = map(t);
    expect(r.text.split("\n")[0].endsWith("\r")).toBe(true);
    expect(r.text.endsWith(L.queue)).toBe(true);
  });

  it("returns an empty transcript unchanged", () => {
    expect(map("")).toMatchObject({ text: "", lines: 0, sessionId: null });
  });

  it("fails closed on a line that is not valid JSON", () => {
    expect(() => map(join(L.user, "{not json", L.queue))).toThrow(/line 2 is not valid JSON/);
    expect(() => map(join(L.user) + "\n")).toThrow(/line 2/); // blank line mid-file
    expect(() => map(join(L.user.slice(0, -5)))).toThrow(/not valid JSON/); // truncated write
  });

  it("fails closed on non-object lines", () => {
    expect(() => map("[1]\n")).toThrow(/not a JSON object/);
    expect(() => map('"x"\n')).toThrow(/not a JSON object/);
    expect(() => map("null\n")).toThrow(/not a JSON object/);
  });

  it("fails closed when sessions are mixed or do not match the expected id", () => {
    expect(() => map(join(L.user, `{"cwd":"${SRC}","sessionId":"other"}`))).toThrow(/different session/);
    expect(() => map(join(L.user), { sessionId: "other" })).toThrow(/different session/);
    expect(map(join(L.user), { sessionId: SID }).sessionId).toBe(SID);
    expect(() => map(`{"sessionId":5}\n`)).toThrow(/non-string sessionId/);
  });

  it("fails closed when a duplicate key would make the rewrite ambiguous", () => {
    // JSON.parse keeps the last duplicate; the textual pass sees both.
    expect(() => map(`{"cwd":"/a","cwd":"${SRC}"}\n`)).toThrow(/could not locate/);
  });

  it("rejects relative cwds", () => {
    expect(() => mapClaudeTranscript({ transcript: "", sourceCwd: "a", destCwd: DST })).toThrow();
    expect(() => mapClaudeTranscript({ transcript: "", sourceCwd: SRC, destCwd: "b" })).toThrow();
  });
});
