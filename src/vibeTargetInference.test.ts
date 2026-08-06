import { describe, expect, it } from "vitest";
import type { Component, Project } from "./projects";
import {
  applyVibeTargetSelection,
  createVibeTargetQuestionSession,
  inferVibeTarget,
  type VibePackageFacts,
} from "./vibeTargetInference";

const component = (
  id: string,
  commands: Component["commands"] = [],
): Component => ({ id, label: id.toUpperCase(), path: `/repo/${id}`, commands });
const command = (id: string, name: string, value: string) => ({
  id,
  name,
  command: value,
});
const fact = (
  scripts: { dev?: string; start?: string },
  runner: "npm" | "pnpm" = "npm",
): VibePackageFacts[string] => ({ status: "loaded", scripts, runner });

describe("inferVibeTarget", () => {
  it("uses the only component's existing dev-ish command", () => {
    expect(
      inferVibeTarget([
        component("web", [command("build", "Build", "npm run build"), command("dev", "Dev", "npm run dev")]),
      ]),
    ).toMatchObject({
      kind: "persist",
      selection: { componentId: "web", runCommandId: "dev" },
      source: "existing-command",
    });
  });

  it("prefers the unique component with an existing dev-ish command", () => {
    expect(
      inferVibeTarget([
        component("api", [command("build", "Build", "npm run build")]),
        component("web", [command("serve", "Serve", "vite --host")]),
      ]),
    ).toMatchObject({
      kind: "persist",
      selection: { componentId: "web", runCommandId: "serve" },
    });
  });

  it("requests package facts only when configured commands cannot decide", () => {
    expect(inferVibeTarget([component("web")])).toEqual({
      kind: "needs-package-facts",
      componentIds: ["web"],
    });
  });

  it("prefers package dev over start and synthesizes a stable command", () => {
    const components = [component("api"), component("web")];
    const facts = {
      api: fact({ start: "node server.js" }),
      web: fact({ dev: "vite" }, "pnpm"),
    } satisfies VibePackageFacts;
    const first = inferVibeTarget(components, facts);
    const second = inferVibeTarget(components, facts);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: "persist",
      source: "package-script",
      selection: {
        componentId: "web",
        addCommand: { name: "Dev", command: "pnpm run dev" },
      },
    });
  });

  it("asks one question instead of breaking equal ties by array order", () => {
    const result = inferVibeTarget([
      component("api", [command("api-dev", "Dev", "npm run dev")]),
      component("web", [command("web-dev", "Dev", "npm run dev")]),
    ]);
    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") return;
    expect(result.prompt).toBe("Which one should I use to run your app?");
    expect(result.choices).toHaveLength(2);
    expect(new Set(result.choices.map((choice) => choice.response)).size).toBe(2);
    expect(new Set(result.choices.map((choice) => choice.label)).size).toBe(2);
  });

  it("ignores blank commands and package scripts", () => {
    expect(
      inferVibeTarget(
        [component("web", [command("dev", "Dev", "  ")])],
        { web: fact({ dev: "  " }) },
      ),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("createVibeTargetQuestionSession", () => {
  it("keeps one question until a concrete choice persists", async () => {
    const inference = inferVibeTarget([
      component("api", [command("api-dev", "Dev", "npm run dev")]),
      component("web", [command("web-dev", "Dev", "npm run dev")]),
    ]);
    expect(inference.kind).toBe("ask");
    if (inference.kind !== "ask") return;
    let succeeds = false;
    const persist = async () => succeeds;
    const session = createVibeTargetQuestionSession(inference, persist);
    expect(session.state.question?.actions).toHaveLength(2);
    const response = inference.choices[0].response;
    await expect(session.send(response)).rejects.toThrow("couldn't save");
    expect(session.state.question?.id).toBeTruthy();
    succeeds = true;
    await session.send(response);
    expect(session.state.question).toBeNull();
  });
});

describe("applyVibeTargetSelection", () => {
  it("persists stable IDs and appends a synthesized command idempotently", () => {
    const project: Project = {
      id: "p1",
      name: "App",
      components: [component("web")],
      vibe: { version: 1, enabled: true },
      shareContext: true,
    };
    const inferred = inferVibeTarget(project.components, {
      web: fact({ dev: "vite" }),
    });
    expect(inferred.kind).toBe("persist");
    if (inferred.kind !== "persist") return;
    const once = applyVibeTargetSelection(project, inferred.selection)!;
    const twice = applyVibeTargetSelection(once, inferred.selection)!;
    expect(twice).toEqual(once);
    expect(once.shareContext).toBe(true);
    expect(once.components[0].commands).toEqual([inferred.selection.addCommand]);
    expect(once.vibe).toMatchObject({
      enabled: true,
      componentId: "web",
      runCommandId: inferred.selection.runCommandId,
    });
  });
});
