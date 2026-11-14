import { describe, expect, it } from "vitest";
import { condenseTurnPrompt, readTurnPrompt, turnPromptText } from "./turnPrompt";

// What the hook delivers for a background command.
const FULL = `<task-notification>
<task-id>bpp3ciaz7</task-id>
<tool-use-id>toolu_01QcG9SsKxj9bd1KUXfyCwFz</tool-use-id>
<output-file>/private/tmp/claude-501/-Users-me-Documents-GitHub-canopy/537bebf7-1489-410d-ad54-3c2274bae476/tasks/bpp3ciaz7.output</output-file>
<status>failed</status>
<summary>Background command "Wait for wasm and terminal crate CI checks" failed with exit code 144</summary>
</task-notification>`;

/** What turn_rollback.rs keeps: whitespace flattened, first 200 characters. */
const stored = (p: string) => [...p.split(/\s+/).filter(Boolean).join(" ")].slice(0, 200).join("");

describe("readTurnPrompt", () => {
  it("reads a background command's outcome", () => {
    expect(readTurnPrompt(FULL)).toMatchObject({
      kind: "task",
      label: "Background task",
      status: "failed, exit 144",
      tone: "fail",
      text: "Wait for wasm and terminal crate CI checks",
    });
  });

  it("reads a finished subagent, in plain words for the build lens", () => {
    const p =
      '<task-notification> <task-id>a3fa</task-id> <tool-use-id>toolu_1</tool-use-id> <status>completed</status> <summary>Agent "Reliability research" finished</summary> <result>This agent\'s report was delivered to you as a message.</result> </task-notification>';
    expect(readTurnPrompt(p)).toMatchObject({ label: "Subagent", status: "finished", tone: "ok", text: "Reliability research" });
    expect(readTurnPrompt(p, { builder: true })?.label).toBe("Helper agent");
  });

  it("says only what an already-stored, cut-off notification still knows", () => {
    const old = stored(FULL);
    expect(old).not.toContain("<status>");
    expect(readTurnPrompt(old)).toMatchObject({
      kind: "task",
      label: "Background task",
      status: null,
      tone: null,
      text: "Reported back",
    });
  });

  it("names a cut-off notification from the session's subagents", () => {
    const view = readTurnPrompt(stored(FULL), {
      subagents: [{ id: "toolu_01QcG9SsKxj9bd1KUXfyCwFz", agent_id: null, description: "Review the diff", status: "done" }],
    });
    expect(view).toMatchObject({ label: "Subagent", text: "Review the diff", status: "finished", tone: "ok" });
  });

  it("keeps a summary that was cut mid-sentence, marked as cut", () => {
    const view = readTurnPrompt('<task-notification><status>completed</status><summary>Background command "Wait for the release bra');
    expect(view).toMatchObject({ status: "finished", text: "Wait for the release bra…" });
  });

  it("trusts the task's status over words in its description", () => {
    // Completed, and cut before the summary's closing quote.
    const cut = '<task-notification><status>completed</status><summary>Background command "Rerun the failed wasm job and the stopped';
    expect(readTurnPrompt(cut)).toMatchObject({ status: "finished", tone: "ok", text: "Rerun the failed wasm job and the stopped…" });
    // No status at all, and no closing words either: no outcome is claimed.
    expect(readTurnPrompt('<task-notification><summary>Background command "Rerun the failed')).toMatchObject({ status: null, tone: null });
    expect(
      readTurnPrompt('<task-notification><status>completed</status><summary>Background command "Find why it failed" completed (exit code 0)</summary>'),
    ).toMatchObject({ status: "finished", text: "Find why it failed" });
  });

  it("counts leading images and keeps the words, with or without a space", () => {
    expect(readTurnPrompt("[Image #3] [Image #4]Also, this shouldn't be the case")).toMatchObject({
      kind: "you",
      label: null,
      images: 2,
      text: "Also, this shouldn't be the case",
    });
    expect(readTurnPrompt("[Image #2]")).toMatchObject({ images: 1, text: "" });
    expect(readTurnPrompt("see [Image #2] above")).toMatchObject({ images: 0, text: "see [Image #2] above" });
  });

  it("names the sender of another session's message", () => {
    const p =
      '<cross-session-message from="uds:/tmp/cc-socks/38459.sock" from-name="canopy-78" from-mode="bypass"> Galleon to Hex: the probe commit is gone.';
    expect(readTurnPrompt(p)).toMatchObject({
      kind: "message",
      label: "From canopy-78",
      text: "Galleon to Hex: the probe commit is gone.",
    });
    expect(readTurnPrompt('<agent-message from="a46b6ddd333fdc53e">\nTrack K: rebased.</agent-message>')).toMatchObject({
      label: "Subagent report",
      text: "Track K: rebased.",
    });
    // Cut inside the opening tag: nothing to show but who it is from.
    expect(readTurnPrompt('<cross-session-message from="uds:/tmp/x.sock" from-name="canopy-78" from-mo')).toMatchObject({
      label: "From canopy-78",
      text: "",
    });
  });

  it("unwraps a task sent from the agent card", () => {
    expect(
      readTurnPrompt("Please complete this task now: Hand test the mic position. Mark it done in your task list when it is finished."),
    ).toMatchObject({ kind: "queued", label: "From task list", text: "Hand test the mic position" });
    expect(
      readTurnPrompt("Please focus on this task next and finish it before continuing with the others: Decide on the benchmark"),
    ).toMatchObject({ kind: "queued", text: "Decide on the benchmark" });
  });

  it("shows a slash command as the command", () => {
    const p = "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>";
    expect(readTurnPrompt(p)).toMatchObject({ kind: "command", label: "Command", text: "/model opus" });
  });

  it("keeps a paste's words and drops system reminders and unknown wrappers", () => {
    expect(readTurnPrompt('<pasted_content id="a76e"> I can\'t stay signed in. </pasted_content> fix it')).toMatchObject({
      kind: "you",
      pasted: true,
      text: "I can't stay signed in. fix it",
    });
    expect(readTurnPrompt("<system-reminder>internal</system-reminder><hook-note>Build failed</hook-note>")).toMatchObject({
      kind: "auto",
      label: "Automatic",
      text: "Build failed",
    });
  });

  it("leaves ordinary prompts alone and has nothing for an empty one", () => {
    expect(readTurnPrompt("What are the things that you have solved?")).toMatchObject({
      kind: "you",
      label: null,
      text: "What are the things that you have solved?",
    });
    expect(readTurnPrompt("  ")).toBeNull();
    expect(readTurnPrompt(null)).toBeNull();
  });
});

describe("turnPromptText", () => {
  it("is the words, never the payload", () => {
    expect(turnPromptText(FULL)).toBe("Background task: Wait for wasm and terminal crate CI checks (failed, exit 144)");
    expect(turnPromptText("[Image #2] Has this been fixed?")).toBe("Has this been fixed?");
    expect(turnPromptText("Please complete this task now: Ship it. Mark it done in your task list when it is finished.")).toBe("Ship it");
    expect(turnPromptText(null)).toBe("");
    // A cut-off notification says nothing; its placeholder is not its words.
    expect(turnPromptText("<task-notification> <task-id>b1</task-id> <tool-use-id>toolu_1</tool-use-id> <output-file>/private/tmp/x")).toBe("");
  });
});

describe("condenseTurnPrompt", () => {
  it("puts status and summary where the stored 200 characters keep them", () => {
    const kept = stored(condenseTurnPrompt(FULL)!);
    expect(kept.startsWith("<task-notification><status>failed</status><summary>")).toBe(true);
    expect(readTurnPrompt(kept)).toEqual(readTurnPrompt(FULL));
  });

  it("drops a message's routing attributes, keeping who and what", () => {
    const p = '<cross-session-message from="uds:/tmp/cc-socks/38459.sock" from-name="canopy-78" from-mode="bypass">\nHello there';
    expect(condenseTurnPrompt(p)).toBe('<cross-session-message from-name="canopy-78">\nHello there');
    expect(readTurnPrompt(condenseTurnPrompt(p))).toEqual(readTurnPrompt(p));
  });

  it("passes everything else through untouched", () => {
    expect(condenseTurnPrompt("fix the bug")).toBe("fix the bug");
    expect(condenseTurnPrompt("<task-notification>")).toBe("<task-notification>");
    expect(condenseTurnPrompt(undefined)).toBeUndefined();
  });
});
