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
    // Otherwise every action costs two turns: the agent asks in prose, the
    // user says yes, and only then does the confirm chip appear — asking the
    // same question twice.
    const p = buildCompanionPrompt({ ...base, authority: "confirm" });
    expect(p).toContain("do NOT ask permission in prose first");
    expect(p).toContain("call the tool; the user will be asked");
  });

  it("says the gate is automatic, not something the agent must remember", () => {
    // The brief has to match how it actually works (`companion_gate` sits in
    // the call path), or an agent that forgets to ask will believe it acted
    // without permission — and one that does ask will double-prompt.
    const p = buildCompanionPrompt({ ...base, authority: "confirm" });
    expect(p).toContain("not because you remembered");
  });

  it("forbids claiming an action it has not seen land", () => {
    const p = buildCompanionPrompt(base);
    expect(p).toContain("Never report an action you have not seen succeed");
  });

  it("names the tool for running things, and forbids the shell for it", () => {
    // Seen in the wild: asked to start a server, it ran `ls`, then handed the
    // user a `cd … && npm run dev` to paste. Starting things is the feature.
    const p = buildCompanionPrompt(base);
    expect(p).toContain("canopy_start_server");
    expect(p).toContain("never hand");
    expect(p).toContain("Use the tools, not the shell");
  });

  it("says no project's CLAUDE.md governs it", () => {
    // It refused to start a server citing "your CLAUDE.md rule" — a rule from
    // one repo's coding agents, inherited because it was running in that repo.
    // The cwd fix stops it being loaded; this stops it being obeyed if it is
    // ever read some other way.
    const p = buildCompanionPrompt(base);
    expect(p).toContain("no repo's");
    expect(p).toContain("not you");
  });

  it("puts a hard length limit on answers, not an adjective", () => {
    // "Be brief" produced paragraphs. A number does not.
    const p = buildCompanionPrompt(base);
    expect(p).toContain("Two or three sentences");
    expect(p).toContain("Answer first");
    expect(p).toContain("No preamble");
  });

  it("points at the tool that carries dir + command, not at a prohibition", () => {
    // The brief used to ask it not to call canopy_project. Asking did not
    // work — the tool is now withheld outright (companionTools.ts), so the
    // brief only has to say where a `dir` and a `command` come from.
    const p = buildCompanionPrompt(base);
    expect(p).toContain("configured");
    expect(p).toContain("canopy_start_server");
  });

  it("tells it how to scope notes and research rather than calling them impossible", () => {
    // Ash reported this as a hard limitation and offered to spawn a coding
    // session instead: "I can't write to the research store myself — it's
    // project-scoped, and my session sits outside every project." It is
    // scoped, not out of reach; naming the project is all it takes.
    const p = buildCompanionPrompt(base);
    expect(p).toContain("Anything scoped to a project");
    expect(p).toContain("`project`");
    expect(p).toContain("do not need to start a coding session");
    expect(p).toContain("not a reason to tell the user you");
  });

  it("makes it say which project — it is in none of them", () => {
    expect(buildCompanionPrompt(base)).toContain("**Say which project.**");
  });

  it("distinguishes a project from a component from a running server", () => {
    // The confusion this removes: "project" and "directory" used as the same
    // word, so a project name gets passed where a component path goes — and
    // "is the API up?" gets answered about a checkout rather than a process.
    const p = buildCompanionPrompt(base);
    expect(p).toContain("### How that is put together");
    expect(p).toContain("It is a name, not");
    expect(p).toContain("A component IS a directory");
    expect(p).toContain("a running command is");
    expect(p).toContain("when it asks for a `dir` it wants a component's path");
  });

  it("knows it can open research, park notes and set timed reminders", () => {
    // Each of these existed and none was mentioned, so it answered "remind me
    // at nine" with a limitation — a feature reported as missing because the
    // brief never named it.
    const p = buildCompanionPrompt({
      ...base,
      tools: [...base.tools, "canopy_research_write", "canopy_notes_write", "canopy_open_preview"],
    });
    expect(p).toContain("## What you can leave behind");
    expect(p).toContain("canopy_research_write");
    expect(p).toContain('action: "remind"');
    expect(p).toContain('in: "2h"');
    expect(p).toContain("whether or not");
  });

  it("tells it to name the project when opening a preview", () => {
    // Without `project` the bridge routes by cwd, which for the companion is
    // inside no project — so with two projects open the preview never opened.
    const p = buildCompanionPrompt({
      ...base,
      tools: [...base.tools, "canopy_open_preview"],
    });
    expect(p).toContain("canopy_open_preview");
    expect(p).toContain("whose window to");
  });

  it("leaves out what this session cannot make", () => {
    const p = buildCompanionPrompt(base);
    expect(p).not.toContain("## What you can leave behind");
    expect(p).not.toContain("canopy_research_write");
  });

  it("says flatly that it does not edit files, at every authority", () => {
    // The companion is not a coding agent, and the tools that would let it
    // edit are withheld at every authority (permissionArgs). The brief has to
    // agree, or it spends turns offering a fix it cannot make and then
    // apologising — which is what "I'm sorry, I can't write to that" looked
    // like from the user's side.
    for (const authority of ["read", "confirm", "auto"] as const) {
      const p = buildCompanionPrompt({ ...base, authority });
      expect(p).toContain("**You do not edit files.**");
      expect(p).toContain("Not at any authority");
    }
  });

  it("says what to do instead of editing, rather than only what it cannot do", () => {
    const p = buildCompanionPrompt({
      ...base,
      tools: [...base.tools, "canopy_workspace_agents", "canopy_message_agent", "canopy_notes_write"],
    });
    expect(p).toContain("Say precisely what should change and where");
    expect(p).toContain("canopy_message_agent");
    expect(p).toContain("canopy_notes_write");
    expect(p).toContain("do not apologise for a limitation");
    // And it still says reading is untouched — the companion answers "what
    // does this code do" across every repo.
    expect(p).toContain("You read everything");
  });

  it("does not name a hand-off tool the session was not given", () => {
    const p = buildCompanionPrompt(base);
    expect(p).toContain("**You do not edit files.**");
    expect(p).not.toContain("canopy_message_agent");
    expect(p).not.toContain("canopy_notes_write");
  });

  it("tells act-freely mode that its freedom is Canopy's tools, not the source", () => {
    const p = buildCompanionPrompt({ ...base, authority: "auto" });
    expect(p).toContain("not a licence to edit code");
  });

  it("explains the context envelope so it reads as grounding, not as user words", () => {
    // Every message arrives with a bracketed `[Canopy: …]` line naming what
    // the user was looking at (companionContext.ts). Unexplained, the model
    // either quotes it back or asks about it; explained, "this file" resolves.
    const p = buildCompanionPrompt(base);
    expect(p).toContain("## Where the user is");
    expect(p).toContain("[Canopy:");
    expect(p).toContain("not the user's words");
    expect(p).toContain("Never read the line back");
  });

  it("points at canopy_editor_state only when the session holds it", () => {
    const withTool = buildCompanionPrompt({
      ...base,
      tools: [...base.tools, "canopy_editor_state"],
    });
    expect(withTool).toContain("canopy_editor_state");
    // The brief must not name a tool this session was not handed.
    expect(buildCompanionPrompt(base)).not.toContain("canopy_editor_state");
  });
});
