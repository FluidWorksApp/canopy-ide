import { describe, expect, it } from "vitest";
import { envReachesProfile, reloadPlan, reloadSummary, reloading, type OpenAgent } from "./accountSwitch";
import type { AccountStatus } from "./ipc";
const open = (over: Partial<OpenAgent> = {}): OpenAgent => ({
  tabId: "t1", agentId: "claude", cwd: "/repo", label: "Claude",
  sessionId: "current", profile: "default", ...over,
});
const signedIn = (agent: string): AccountStatus => ({agent, state:"in", account:"synthetic@example.com"});
describe("account switch conversation continuity", () => {
  it.each(["claude", "codex"])("resumes the exact %s conversation using separate target credentials", agentId => {
    const [item] = reloadPlan({open:[open({agentId})], accounts:[signedIn(agentId)], restorables:[], profile:"work"});
    expect(item.action).toMatchObject({kind:"resume", sessionId:"current", sourceProfile:"default", cwd:"/repo"});
    expect(item.action && "command" in item.action && item.action.command).toContain("current");
    expect(reloadSummary(item)).toBe("continues this conversation with the selected account");
  });
  it("never substitutes the target account's unrelated latest conversation", () => {
    const [item] = reloadPlan({
      open:[open()], accounts:[signedIn("claude")], profile:"work",
      restorables:[{agentId:"claude", cwd:"/repo", command:"claude --resume unrelated", profile:"work",
        digest:{session_id:"unrelated", updated:999}, prompt:"another task", superseded:[]}],
    });
    expect(item.action).toMatchObject({sessionId:"current", sourceProfile:"default"});
  });
  it("keeps an unidentified conversation running instead of starting fresh", () => {
    const [item] = reloadPlan({open:[open({sessionId:undefined})], accounts:[signedIn("claude")], restorables:[], profile:"work"});
    expect(item).toMatchObject({action:null,reason:"session-unavailable"});
  });
  it.each(["out", "unknown"] as const)("leaves an agent alone when target login is %s", state => {
    const plan = reloadPlan({open:[open()], accounts:[{agent:"claude",state,account:null}], restorables:[],profile:"work"});
    expect(plan[0]).toMatchObject({action:null,reason:"not-signed-in"});
    expect(reloading(plan)).toEqual([]);
  });
  it("preserves source profile provenance for named accounts", () => {
    const [item] = reloadPlan({open:[open({profile:"personal"})],accounts:[signedIn("claude")],restorables:[],profile:"work"});
    expect(item.action).toMatchObject({sourceProfile:"personal"});
  });
  it("leaves unsupported CLIs untouched", () => {
    const [item] = reloadPlan({open:[open({agentId:"agy"})],accounts:[signedIn("agy")],restorables:[],profile:"work"});
    expect(item).toMatchObject({action:null,reason:"single-account"});
  });
});
describe("account environment", () => {
  it("only allows an empty environment for the default profile", () => {
    expect(envReachesProfile("default",[])).toBe(true);
    expect(envReachesProfile("work",[])).toBe(false);
    expect(envReachesProfile("work",[["CLAUDE_CONFIG_DIR","/work/.claude"]])).toBe(true);
  });
});
