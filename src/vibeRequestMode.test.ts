import { describe, expect, it } from "vitest";
import { vibeRequestMode, vibeToolChangesProject } from "./vibeRequestMode";

describe("vibeRequestMode", () => {
  it.each([
    "What's this error?",
    "Why is the preview blank?",
    "How do I connect Supabase?",
    "Explain what this warning means",
    "Can I use GitHub here?",
  ])("keeps an explanation request read-only: %s", (message) => {
    expect(vibeRequestMode(message)).toBe("question");
  });

  it.each([
    "Fix this error",
    "Can you make the button blue?",
    "What is this error? Fix it too.",
    "Please connect Supabase",
    "Let's deploy this",
  ])("recognises an actual change request: %s", (message) => {
    expect(vibeRequestMode(message)).toBe("change");
  });

  it("treats explicit editor tools as mutation evidence", () => {
    expect(vibeToolChangesProject("Edit")).toBe(true);
    expect(vibeToolChangesProject("apply_patch")).toBe(true);
    expect(vibeToolChangesProject("Read")).toBe(false);
    expect(vibeToolChangesProject("canopy_browser_snapshot")).toBe(false);
  });
});
