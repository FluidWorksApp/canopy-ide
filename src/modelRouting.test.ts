import { describe, expect, it } from "vitest";
import type { ModelChoice } from "./agentModels";
import {
  modelForClass,
  routeModel,
  routingTierOf,
  TIER_FOR_CLASS,
  type TaskClass,
} from "./modelRouting";

const choice = (id: string): ModelChoice => ({ id, label: id, hint: "" });

const ANTHROPIC = ["fable", "opus", "sonnet", "haiku"].map(choice);
const OPENAI = ["gpt-5.5-codex", "gpt-5.5", "gpt-5.4-mini"].map(choice);

describe("routingTierOf", () => {
  it("classifies picker aliases and raw ids alike", () => {
    expect(routingTierOf("anthropic", "fable")).toBe("frontier");
    expect(routingTierOf("anthropic", "claude-sonnet-5")).toBe("workhorse");
    expect(routingTierOf("anthropic", "haiku")).toBe("fast");
  });

  it("tests variants before their parents — mini is fast, not workhorse", () => {
    expect(routingTierOf("openai", "gpt-5.4-mini")).toBe("fast");
    expect(routingTierOf("openai", "gpt-5.5")).toBe("workhorse");
    expect(routingTierOf("google", "gemini-3.5-flash-lite")).toBe("fast");
    expect(routingTierOf("google", "gemini-3.6-flash")).toBe("workhorse");
  });

  it("classifies the gpt-5.6 sol/terra/luna family", () => {
    expect(routingTierOf("openai", "gpt-5.6-sol")).toBe("frontier");
    expect(routingTierOf("openai", "gpt-5.6-terra")).toBe("workhorse");
    expect(routingTierOf("openai", "gpt-5.6-luna")).toBe("fast");
  });

  it("answers null for the unrecognizable rather than guessing", () => {
    expect(routingTierOf("anthropic", "mystery-model")).toBeNull();
  });
});

describe("routeModel", () => {
  it("serves the asked-for tier when it exists", () => {
    expect(routeModel("anthropic", "frontier", ANTHROPIC)?.choice.id).toBe("fable");
    expect(routeModel("openai", "workhorse", OPENAI)?.choice.id).toBe("gpt-5.5");
  });

  it("a frontier ask degrades downward and says so", () => {
    const routed = routeModel("anthropic", "frontier", [choice("sonnet"), choice("haiku")]);
    expect(routed).toEqual({ choice: choice("sonnet"), tier: "workhorse" });
  });

  it("a fast ask steps up rather than failing", () => {
    const routed = routeModel("google", "fast", [choice("gemini-3.1-pro")]);
    expect(routed).toEqual({ choice: choice("gemini-3.1-pro"), tier: "frontier" });
  });

  it("an empty or unrecognizable menu routes nowhere", () => {
    expect(routeModel("anthropic", "frontier", [])).toBeNull();
    expect(routeModel("anthropic", "frontier", [choice("mystery")])).toBeNull();
  });
});

describe("modelForClass", () => {
  it("build thinks on frontier, fix runs on the workhorse, classify runs fast", () => {
    expect(modelForClass("anthropic", "build", ANTHROPIC)?.choice.id).toBe("fable");
    expect(modelForClass("anthropic", "fix", ANTHROPIC)?.choice.id).toBe("sonnet");
    expect(modelForClass("anthropic", "classify", ANTHROPIC)?.choice.id).toBe("haiku");
  });

  it("every task class has a tier", () => {
    const classes: TaskClass[] = ["build", "survey", "fix", "verify", "scan", "classify", "title"];
    for (const c of classes) expect(TIER_FOR_CLASS[c]).toBeDefined();
  });
});
