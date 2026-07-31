import { beforeEach, describe, expect, it } from "vitest";
import { buildCompanionPrompt, type PromptInput } from "./companionPrompt";
import { updateSettings } from "./settings";

const base: PromptInput = {
  projects: [
    { name: "Canopy", roots: ["/GitHub/canopy"], open: true },
    { name: "Banana", roots: ["/GitHub/banana", "/GitHub/banana-android"], open: false },
    { name: "Coraa", roots: ["/GitHub/coraa"], open: false, hibernated: true },
  ],
  authority: "confirm",
  tools: ["canopy_workspace", "canopy_workspace_git", "canopy_remember", "canopy_recall"],
  cliName: "Claude Code",
};

beforeEach(() => localStorage.clear());

describe("the brief", () => {
  it("names the companion, and follows a rename", () => {
    expect(buildCompanionPrompt(base)).toContain("You are Ash");
    updateSettings({ companionName: "Sprig" });
    const p = buildCompanionPrompt(base);
    expect(p).toContain("You are Sprig");
    expect(p).not.toContain("You are Ash");
  });

  it("lists every project and every root, open or not", () => {
    const p = buildCompanionPrompt(base);
    for (const project of base.projects) {
      expect(p).toContain(project.name);
      for (const root of project.roots) expect(p).toContain(root);
    }
    expect(p).toContain("(open)");
    expect(p).toContain("(closed)");
    expect(p).toContain("(asleep)");
  });

  it("says plainly that there is nothing rather than inventing a workspace", () => {
    const p = buildCompanionPrompt({ ...base, projects: [] });
    expect(p).toContain("No projects are set up");
    expect(p).toContain("do not guess at directories");
  });

  it("only describes tools this session actually holds", () => {
    // The failure this guards: a brief that advertises a capability the user
    // switched off, so the agent promises what it cannot do.
    const p = buildCompanionPrompt({ ...base, tools: ["canopy_workspace"] });
    expect(p).toContain("canopy_workspace`");
    expect(p).not.toContain("canopy_workspace_git");
    expect(p).not.toContain("canopy_workspace_search");
  });

  it("drops the memory section when neither memory tool is present", () => {
    const p = buildCompanionPrompt({ ...base, tools: ["canopy_workspace"] });
    expect(p).not.toContain("## Memory");
  });

  it("carries the authority actually in force, not a generic caution", () => {
    expect(buildCompanionPrompt({ ...base, authority: "read" })).toContain("ANSWER-ONLY");
    expect(buildCompanionPrompt({ ...base, authority: "confirm" })).toContain("ASK-FIRST");
    expect(buildCompanionPrompt({ ...base, authority: "auto" })).toContain(
      "without confirmation",
    );
  });

  it("tells ask-first mode to call the tool rather than ask in prose", () => {
    // Otherwise every action costs two turns: the agent asks, the user says
    // yes, and only then does the confirm chip appear.
    const p = buildCompanionPrompt({ ...base, authority: "confirm" });
    expect(p).toContain("call it, and Canopy will do the asking");
  });

  it("forbids claiming an action it has not seen land", () => {
    const p = buildCompanionPrompt(base);
    expect(p).toContain("Never report an action you have not seen succeed");
  });

  it("makes it say which project — it is in none of them", () => {
    expect(buildCompanionPrompt(base)).toContain("**Say which project.**");
  });
});
