import { describe, expect, it } from "vitest";
import { validateWorkflowDefinition } from "../workflowDefinition";
import { renderWorkflowPrompt, workflowRunDir } from "../workflowPrompt";
import {
  EGM_DIR,
  EGM_SPEC_WORKFLOW_DEFINITION,
  EGM_VENDOR_COMMIT,
  egmResearchTrigger,
  egmResourceFiles,
  installEgmResources,
  isDesignSpec,
  specPathFor,
} from "./egmWorkflow";

const context = { projectRoot: "/repo", componentRoots: new Set(["/repo"]) };

describe("the EGM spec workflow", () => {
  it("is a valid workflow definition", () => {
    const result = validateWorkflowDefinition(EGM_SPEC_WORKFLOW_DEFINITION, context);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it("keeps every Goldfish read-only and lets only the Elephant write", () => {
    const agents = EGM_SPEC_WORKFLOW_DEFINITION.steps.filter((step) => step.kind === "agent");
    for (const step of agents) {
      if (step.kind !== "agent") continue;
      const writes = step.capabilities.includes("workspace-write");
      expect(writes, step.id).toBe(step.agent === "elephant");
    }
    expect(agents.filter((step) => step.kind === "agent" && step.agent === "goldfish")).toHaveLength(7);
  });

  it("routes each review stage on the synthesizer's verdict", () => {
    for (const id of ["feature_verdict", "impl_verdict"]) {
      const step = EGM_SPEC_WORKFLOW_DEFINITION.steps.find((candidate) => candidate.id === id);
      expect(step?.kind === "agent" && step.verdicts).toEqual(["clean", "findings"]);
    }
  });

  it("only refers to resources it installs", () => {
    const installed = new Set(egmResourceFiles().map((file) => file.path));
    const text = JSON.stringify(EGM_SPEC_WORKFLOW_DEFINITION);
    const referenced = [...text.matchAll(/\.canopy\/egm\/([\w./-]+?\.md)/g)].map((match) => `${EGM_DIR}/${match[1]}`);
    expect(referenced.length).toBeGreaterThan(10);
    for (const path of referenced) expect(installed.has(path), path).toBe(true);
    // The two standards the draft step names by bare file name live in standards/.
    expect(installed.has(`${EGM_DIR}/standards/implementation-readiness-standard.md`)).toBe(true);
  });

  it("renders into briefs with no unresolved run placeholders", () => {
    const runDir = workflowRunDir("/repo", "run-1");
    for (const step of EGM_SPEC_WORKFLOW_DEFINITION.steps) {
      if (step.kind !== "agent") continue;
      const block = EGM_SPEC_WORKFLOW_DEFINITION.agents?.find((agent) => agent.id === step.agent);
      const rendered = renderWorkflowPrompt(`${block?.prompt ?? ""} ${step.prompt}`, {
        runId: "run-1",
        runDir,
        round: 1,
        trigger: egmResearchTrigger({ id: "0007", title: "Tiered donations", question: "", digest: "d", recommendation: "r" }),
      });
      expect(rendered, step.id).not.toMatch(/\{\{/);
    }
  });
});

describe("EGM resources", () => {
  it("ship the upstream license and record the pinned commit", () => {
    const files = egmResourceFiles();
    expect(files.find((file) => file.path === `${EGM_DIR}/LICENSE`)?.content).toContain("Apache License");
    expect(files.find((file) => file.path === `${EGM_DIR}/README.md`)?.content).toContain(EGM_VENDOR_COMMIT);
    for (const file of files) expect(file.content.trim().length, file.path).toBeGreaterThan(0);
  });

  it("installs only what is missing, so a project's own edits survive", async () => {
    const disk = new Map<string, string>([[`/repo/${EGM_DIR}/standards/zoom-out-standard.md`, "our bar"]]);
    const written = await installEgmResources("/repo/", {
      exists: async (path) => disk.has(path),
      create: async (path) => { disk.set(path, ""); },
      write: async (path, content) => { disk.set(path, content); },
    });
    expect(disk.get(`/repo/${EGM_DIR}/standards/zoom-out-standard.md`)).toBe("our bar");
    expect(written).not.toContain(`/repo/${EGM_DIR}/standards/zoom-out-standard.md`);
    expect(written).toHaveLength(egmResourceFiles().length - 1);
    expect(await installEgmResources("/repo", {
      exists: async (path) => disk.has(path),
      create: async () => {},
      write: async () => {},
    })).toEqual([]);
  });
});

describe("spec paths", () => {
  it("derives a stable docs/designs path from a title", () => {
    expect(specPathFor("Tiered donations & GitHub tags!")).toBe("docs/designs/tiered-donations-github-tags.md");
    expect(specPathFor("Café réservations")).toBe("docs/designs/cafe-reservations.md");
    expect(specPathFor("???")).toBe("docs/designs/feature.md");
    expect(specPathFor("x".repeat(100))).toBe(`docs/designs/${"x".repeat(60)}.md`);
  });

  it("recognises a design spec among linked files", () => {
    expect(isDesignSpec("docs/designs/tiers.md")).toBe(true);
    expect(isDesignSpec("/repo/docs/designs/tiers.md")).toBe(true);
    expect(isDesignSpec("docs/designs/nested/tiers.md")).toBe(false);
    expect(isDesignSpec("src/designs.md")).toBe(false);
  });

  it("hands the draft step the research entry and where the spec goes", () => {
    const trigger = egmResearchTrigger({
      id: "0007",
      title: "Tiered donations",
      question: "Can we tier donations?",
      digest: "Stripe supports it.",
      recommendation: "Use price tiers.",
    });
    expect(trigger).toMatchObject({
      source: "research",
      researchId: "0007",
      specPath: "docs/designs/tiered-donations.md",
    });
    expect(trigger.request).toContain("Can we tier donations?");
    expect(trigger.request).toContain("Use price tiers.");
  });
});
