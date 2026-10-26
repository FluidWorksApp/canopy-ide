// The Elephant-Goldfish Model as a Canopy workflow.
//
// EGM (https://github.com/google/elephant-goldfish-model, Apache-2.0) is a
// method for spec-driven development with agents: a deep-context "Elephant"
// drafts a design spec, then fresh, read-only "Goldfish" reviewers each audit it
// against a written standard, so no reviewer inherits the drafter's
// assumptions. Upstream ships it as skills that spawn subagents inside one CLI
// session. Canopy's workflow engine already runs every agent step as a fresh
// one-shot session, which is the isolation a Goldfish needs — so here the
// pipeline is a workflow definition, and the personas and standards are files
// the project owns.
//
// See docs/egm-spec-stage.md for the design.
import type { WorkflowAgentStep, WorkflowDefinition } from "../workflowDefinition";
import { WORKFLOW_SCHEMA_VERSION } from "../workflowDefinition";
import { specPathFor } from "./specPath";

import codebaseDetails from "./vendor/agents/codebase_details.md?raw";
import comprehension from "./vendor/agents/comprehension.md?raw";
import designCritic from "./vendor/agents/design_critic.md?raw";
import implementationReadiness from "./vendor/agents/implementation_readiness.md?raw";
import synthesizer from "./vendor/agents/synthesizer.md?raw";
import zoomOut from "./vendor/agents/zoom_out.md?raw";
import featureSpecStandard from "./vendor/standards/feature-spec-standard.md?raw";
import heilmeierStandard from "./vendor/standards/heilmeier-standard.md?raw";
import implementationReadinessStandard from "./vendor/standards/implementation-readiness-standard.md?raw";
import reImplementationStandard from "./vendor/standards/re-implementation-standard.md?raw";
import zoomOutStandard from "./vendor/standards/zoom-out-standard.md?raw";
import designDocTemplate from "./vendor/templates/design_doc.md?raw";
import executionInstructions from "./vendor/execution_instructions.md?raw";
import license from "./vendor/LICENSE?raw";

/** The upstream commit these files were copied from, unmodified. Updating is a
 *  deliberate act: copy the files again and change this. */
export const EGM_UPSTREAM = "https://github.com/google/elephant-goldfish-model";
export const EGM_VENDOR_COMMIT = "3d0b34821ce88ad328b0c9bf0e06d7eb5f1cd669";

/** Where a project's copy lives. Committed alongside `.canopy/workflows/` so a
 *  team reviews the same personas the agents read, at the same version. */
export const EGM_DIR = ".canopy/egm";
export const EGM_WORKFLOW_ID = "egm-spec";

const readme = `# Elephant-Goldfish Model resources

These files drive the \`${EGM_WORKFLOW_ID}\` workflow in \`.canopy/workflows/\`.
They are an unmodified copy of the personas, document standards and design-doc
template from Google's Elephant-Goldfish Model:

- Source: ${EGM_UPSTREAM}
- Commit: \`${EGM_VENDOR_COMMIT}\`
- License: Apache-2.0 (see \`LICENSE\` in this folder)

Canopy wrote them here when the workflow was created so the agents read them as
ordinary project files and your team reviews the same text. Edit them if your
project wants a different bar; Canopy will not overwrite files that exist.

| Folder | Read by |
| --- | --- |
| \`agents/\` | each Goldfish reviewer step, as its persona |
| \`standards/\` | the reviewer steps, as the bar a spec is held to |
| \`templates/design_doc.md\` | the Elephant's draft step |
| \`execution_instructions.md\` | the Elephant's draft and resolve steps |
`;

export interface EgmResourceFile {
  /** Relative to the project root. */
  path: string;
  content: string;
}

/** Everything the workflow's prompts refer to, with where it goes. */
export function egmResourceFiles(): EgmResourceFile[] {
  const files: Array<[string, string]> = [
    ["README.md", readme],
    ["LICENSE", license],
    ["execution_instructions.md", executionInstructions],
    ["agents/zoom_out.md", zoomOut],
    ["agents/comprehension.md", comprehension],
    ["agents/design_critic.md", designCritic],
    ["agents/codebase_details.md", codebaseDetails],
    ["agents/implementation_readiness.md", implementationReadiness],
    ["agents/synthesizer.md", synthesizer],
    ["standards/zoom-out-standard.md", zoomOutStandard],
    ["standards/feature-spec-standard.md", featureSpecStandard],
    ["standards/implementation-readiness-standard.md", implementationReadinessStandard],
    ["standards/re-implementation-standard.md", reImplementationStandard],
    ["standards/heilmeier-standard.md", heilmeierStandard],
    ["templates/design_doc.md", designDocTemplate],
  ];
  return files.map(([path, content]) => ({ path: `${EGM_DIR}/${path}`, content }));
}

/** Install the resources a project is missing. Existing files are left alone:
 *  they are the project's copy, and a team that tuned a standard must not have
 *  it silently reset by the next "Write spec". Returns the paths it wrote. */
export async function installEgmResources(
  projectRoot: string,
  io: {
    exists(path: string): Promise<boolean>;
    create(path: string): Promise<unknown>;
    write(path: string, content: string): Promise<void>;
  },
): Promise<string[]> {
  const root = projectRoot.replace(/[\\/]+$/, "");
  const written: string[] = [];
  for (const file of egmResourceFiles()) {
    const path = `${root}/${file.path}`;
    if (await io.exists(path)) continue;
    await io.create(path);
    await io.write(path, file.content);
    written.push(path);
  }
  return written;
}

export { isDesignSpec, specPathFor } from "./specPath";

// ---------- the workflow ----------

const SPEC = `the spec whose path (relative to the project root) is the only line of {{run.dir}}/spec-path.txt`;
const FEATURE_RANGE = `the spec from its start up to, not including, the "## Detailed Implementation Plan" heading (the whole spec if it has none)`;
const DETAILED_RANGE = `the spec's "## Detailed Implementation Plan" section through its end — if the spec has no such section, that absence is your first Blocker`;
const REPORTS = "{{run.dir}}/reports/r{{round}}";

const goldfish = (
  id: string,
  name: string,
  persona: string,
  standard: string,
  stage: string,
  scope: string,
): WorkflowAgentStep => ({
  id,
  name,
  kind: "agent",
  agent: "goldfish",
  capabilities: ["workspace-read"],
  attemptCap: 2,
  prompt:
    `Run the EGM ${stage}. Read your persona at ${EGM_DIR}/agents/${persona}.md and follow its "Mode: REVIEW" ` +
    `instructions. Your Target Standard is ${EGM_DIR}/standards/${standard}.md. Your target is ${SPEC}; ` +
    `review ${scope}. Read the files the spec links or names, and the code it describes, before judging it. ` +
    `Write your findings in the persona's output format, a Severity (Blocker, Major or Nit) on every finding, ` +
    `to ${REPORTS}/${id}.md (mkdir -p first). Start the file with the line "Round: {{round}}". ` +
    `If you find nothing, write that, and say what you checked.`,
  acceptance: [
    `${REPORTS}/${id}.md exists and starts with "Round: {{round}}".`,
    "Every finding has a Severity and names the spec section or file it concerns.",
  ],
});

const synthesize = (
  id: string,
  name: string,
  inputs: string[],
  output: string,
): WorkflowAgentStep => ({
  id,
  name,
  kind: "agent",
  agent: "goldfish",
  capabilities: ["workspace-read"],
  attemptCap: 2,
  verdicts: ["clean", "findings"],
  prompt:
    `Consolidate this EGM review stage. Read your persona at ${EGM_DIR}/agents/synthesizer.md and follow ` +
    `its "Mode: REVIEW" instructions, with one difference: do not spawn reviewers — their reports already ` +
    `exist at ${inputs.map((input) => `${REPORTS}/${input}.md`).join(", ")}. A report that is missing, or ` +
    `whose first line is not "Round: {{round}}", is itself a Blocker named "Missing review". Read ${SPEC} ` +
    `to check each finding's line references. Deduplicate, group by severity, and write the Goldfish Review ` +
    `Report to ${REPORTS}/${output}.md. Your verdict is "findings" if any Blocker or Major remains, otherwise "clean".`,
  acceptance: [
    `${REPORTS}/${output}.md exists, grouped Blocker → Major → Nit.`,
    "The verdict matches the report: findings exactly when a Blocker or Major is listed.",
  ],
});

const resolve = (id: string, name: string, review: string): WorkflowAgentStep => ({
  id,
  name,
  kind: "agent",
  agent: "elephant",
  capabilities: ["workspace-read", "workspace-write"],
  attemptCap: 2,
  prompt:
    `Resolve the Goldfish review in ${REPORTS}/${review}.md (if that file is missing, use the ` +
    `highest-numbered ${"{{run.dir}}"}/reports/r*/${review}.md). Work on ${SPEC}. For each finding decide, as ` +
    `EGM's resolve step does: CONTEST when it is inaccurate or misreads the codebase — cite the code or ` +
    `spec text that shows it — or PROPOSE FIX when it is valid. Apply every PROPOSE FIX to the spec now; ` +
    `edit nothing but the spec. Then write ${REPORTS}/${id}.md: one entry per finding with its severity, ` +
    `your decision, the justification, and the exact edit you made, so the human can check every change.`,
  acceptance: [
    `${REPORTS}/${id}.md accounts for every finding in the review.`,
    "Only the spec file changed in the project.",
  ],
});

/** The whole pipeline: draft → Feature review (Zoom Out, Comprehension,
 *  Design Critic) → Implementation readiness (Codebase Details, Readiness) →
 *  approval, with a resolve-and-decide loop after each review stage. Every
 *  agent step is a fresh session; reviewers are read-only and write only into
 *  the run folder. */
export const EGM_SPEC_WORKFLOW_DEFINITION: WorkflowDefinition = {
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  id: EGM_WORKFLOW_ID,
  version: "1",
  name: "Spec-driven feature (Elephant-Goldfish)",
  agents: [
    {
      id: "elephant",
      name: "Elephant",
      type: "inherit",
      prompt:
        `You are the Elephant in the Elephant-Goldfish Model (EGM): the deep-context author of a design spec. ` +
        `Gather context deliberately — this codebase, its agent instructions (CLAUDE.md / AGENTS.md), and any ` +
        `research entry named below — and ground every claim in files you actually read here. Follow ` +
        `${EGM_DIR}/execution_instructions.md for tone and the no-code rule, with one exception: this is a ` +
        `one-shot step with nobody at the terminal, so instead of asking questions, record what is unresolved ` +
        `under the spec's "Open Questions". Never write production code — change only the spec and files ` +
        `under {{run.dir}}.`,
    },
    {
      id: "goldfish",
      name: "Goldfish",
      type: "inherit",
      prompt:
        `You are a Goldfish reviewer in the Elephant-Goldfish Model (EGM). You start with no history on ` +
        `purpose: judge the spec only by what it says and what the code shows, not by what anyone meant. ` +
        `You are read-only. Canopy refuses edits outside {{run.dir}}, and you must not change project files ` +
        `through the shell either. Canopy is your orchestrator: "report back" means writing the file this ` +
        `step names.`,
    },
  ],
  triggers: [{ kind: "manual" }],
  constraints: { componentRoots: ["."], branchPatterns: ["*"] },
  start: "draft",
  steps: [
    {
      id: "draft",
      name: "Draft the spec",
      kind: "agent",
      agent: "elephant",
      capabilities: ["workspace-read", "workspace-write"],
      attemptCap: 2,
      prompt:
        `Draft — or revise — the EGM design spec for: {{trigger.request}}. Research entry: ` +
        `{{trigger.researchId}}; if one is given, call canopy_research get with that id and build on its ` +
        `finding and sources rather than researching again. Spec path: {{trigger.specPath}}; if none is ` +
        `given, choose docs/designs/<short-kebab-name>.md. If the spec file already exists this is a ` +
        `revision: read it, address every <!-- --> comment the user left and the latest reports under ` +
        `{{run.dir}}/reports, remove the comments you resolved, and keep what still holds. Otherwise start ` +
        `from ${EGM_DIR}/templates/design_doc.md and keep its sections. Write to the bar of ` +
        `${EGM_DIR}/standards/feature-spec-standard.md and implementation-readiness-standard.md: goals and ` +
        `non-goals, CUJs, alternatives considered, risks, and a "## Detailed Implementation Plan" naming ` +
        `exact files, changes and tests so the implementer makes no design decision. Set the Status line ` +
        `to Draft. Finally write the spec's path relative to the project root, alone on one line, to ` +
        `{{run.dir}}/spec-path.txt (mkdir -p first).`,
      acceptance: [
        "The spec follows the EGM design-doc template, including a Detailed Implementation Plan.",
        "{{run.dir}}/spec-path.txt names the spec.",
        "No file other than the spec and the run folder changed.",
      ],
    },
    {
      id: "draft_check",
      name: "Review the draft",
      kind: "human",
      capabilities: [],
      card: {
        reason: "choice",
        title: "Review the spec draft",
        detail:
          "The spec is in docs/designs/ (the run folder's spec-path.txt names it). Edit it directly, or " +
          "leave <!-- comments --> for the Elephant to address, then choose.",
        actions: [
          { label: "Start Goldfish review", response: "review", tone: "primary" },
          { label: "Revise the draft", response: "revise", tone: "neutral" },
          { label: "Stop", response: "stop", tone: "danger" },
        ],
      },
    },
    goldfish("zoom_out", "Zoom Out review", "zoom_out", "zoom-out-standard", "Zoom Out review (Stage 5)", FEATURE_RANGE),
    goldfish("comprehension", "Comprehension review", "comprehension", "feature-spec-standard", "Comprehension test (Stage 6)", FEATURE_RANGE),
    goldfish("critic", "Design Critic review", "design_critic", "feature-spec-standard", "Design Critic review (Stage 7)", FEATURE_RANGE),
    synthesize("feature_verdict", "Feature review verdict", ["zoom_out", "comprehension", "critic"], "feature_review"),
    resolve("resolve_feature", "Resolve feature findings", "feature_review"),
    {
      id: "feature_check",
      name: "Feature review resolved",
      kind: "human",
      capabilities: [],
      card: {
        reason: "choice",
        title: "Feature review resolved",
        detail:
          "The Elephant applied the fixes it accepted to the spec and explained every decision in the run " +
          "folder's feature resolution report. Check the edits, then choose. A re-review runs once at most.",
        actions: [
          { label: "Continue to readiness", response: "continue", tone: "primary" },
          { label: "Re-run feature review", response: "rerun", tone: "neutral" },
          { label: "Stop", response: "stop", tone: "danger" },
        ],
      },
    },
    goldfish("codebase", "Codebase Details review", "codebase_details", "implementation-readiness-standard", "Codebase Details audit (Stage 9)", DETAILED_RANGE),
    goldfish("readiness", "Implementation Readiness test", "implementation_readiness", "implementation-readiness-standard", "Implementation Readiness test (Stage 9)", DETAILED_RANGE),
    synthesize("impl_verdict", "Readiness verdict", ["codebase", "readiness"], "readiness_review"),
    resolve("resolve_impl", "Resolve readiness findings", "readiness_review"),
    {
      id: "impl_check",
      name: "Readiness review resolved",
      kind: "human",
      capabilities: [],
      card: {
        reason: "choice",
        title: "Readiness review resolved",
        detail:
          "The Elephant applied the fixes it accepted to the implementation plan and explained every " +
          "decision in the run folder's readiness resolution report. A re-check runs once at most.",
        actions: [
          { label: "Continue to approval", response: "continue", tone: "primary" },
          { label: "Re-check readiness", response: "rerun", tone: "neutral" },
          { label: "Stop", response: "stop", tone: "danger" },
        ],
      },
    },
    {
      id: "approve",
      name: "Approve the spec",
      kind: "human",
      capabilities: [],
      card: {
        reason: "choice",
        title: "Approve this spec?",
        detail:
          "Approving marks the spec Approved. Commit it with the code that implements it; " +
          "\"Implement this\" on a linked research entry builds against it.",
        actions: [
          { label: "Approve spec", response: "approve", tone: "primary" },
          { label: "Back to drafting", response: "revise", tone: "neutral" },
          { label: "Reject", response: "reject", tone: "danger" },
        ],
      },
    },
    {
      id: "finalize",
      name: "Mark approved",
      kind: "agent",
      agent: "elephant",
      capabilities: ["workspace-read", "workspace-write"],
      attemptCap: 2,
      prompt:
        `The human approved ${SPEC}. Set its Status line to Approved and its Date line to today's date ` +
        `(YYYY-MM-DD). Change nothing else.`,
      acceptance: ["The spec's Status reads Approved and nothing else in it changed."],
    },
  ],
  edges: [
    { from: "draft", on: "success", to: "draft_check" },
    { from: "draft", on: "failure", to: "$failed" },
    { from: "draft_check", on: "review", to: "zoom_out" },
    { from: "draft_check", on: "revise", to: "draft", loop: { maxRounds: 3, exhaustedTo: "zoom_out" } },
    { from: "draft_check", on: "stop", to: "$cancelled" },
    { from: "zoom_out", on: "success", to: "comprehension" },
    { from: "zoom_out", on: "failure", to: "$failed" },
    { from: "comprehension", on: "success", to: "critic" },
    { from: "comprehension", on: "failure", to: "$failed" },
    { from: "critic", on: "success", to: "feature_verdict" },
    { from: "critic", on: "failure", to: "$failed" },
    { from: "feature_verdict", on: "clean", to: "codebase" },
    { from: "feature_verdict", on: "findings", to: "resolve_feature" },
    { from: "feature_verdict", on: "failure", to: "$failed" },
    { from: "resolve_feature", on: "success", to: "feature_check" },
    { from: "resolve_feature", on: "failure", to: "$failed" },
    { from: "feature_check", on: "continue", to: "codebase" },
    { from: "feature_check", on: "rerun", to: "zoom_out", loop: { maxRounds: 1, exhaustedTo: "codebase" } },
    { from: "feature_check", on: "stop", to: "$cancelled" },
    { from: "codebase", on: "success", to: "readiness" },
    { from: "codebase", on: "failure", to: "$failed" },
    { from: "readiness", on: "success", to: "impl_verdict" },
    { from: "readiness", on: "failure", to: "$failed" },
    { from: "impl_verdict", on: "clean", to: "approve" },
    { from: "impl_verdict", on: "findings", to: "resolve_impl" },
    { from: "impl_verdict", on: "failure", to: "$failed" },
    { from: "resolve_impl", on: "success", to: "impl_check" },
    { from: "resolve_impl", on: "failure", to: "$failed" },
    { from: "impl_check", on: "continue", to: "approve" },
    { from: "impl_check", on: "rerun", to: "codebase", loop: { maxRounds: 1, exhaustedTo: "approve" } },
    { from: "impl_check", on: "stop", to: "$cancelled" },
    { from: "approve", on: "approve", to: "finalize" },
    { from: "approve", on: "revise", to: "draft", loop: { maxRounds: 2, exhaustedTo: "$cancelled" } },
    { from: "approve", on: "reject", to: "$failed" },
    { from: "finalize", on: "success", to: "$completed" },
    { from: "finalize", on: "failure", to: "$failed" },
  ],
  canvas: {
    nodes: {
      "trigger:0": { x: 40, y: 80 },
      draft: { x: 310, y: 80 },
      draft_check: { x: 580, y: 80 },
      zoom_out: { x: 850, y: 80 },
      comprehension: { x: 1120, y: 80 },
      critic: { x: 1390, y: 80 },
      feature_verdict: { x: 1660, y: 80 },
      resolve_feature: { x: 1660, y: 300 },
      feature_check: { x: 1930, y: 300 },
      codebase: { x: 1930, y: 80 },
      readiness: { x: 2200, y: 80 },
      impl_verdict: { x: 2470, y: 80 },
      resolve_impl: { x: 2470, y: 300 },
      impl_check: { x: 2740, y: 300 },
      approve: { x: 2740, y: 80 },
      finalize: { x: 3010, y: 80 },
    },
    viewport: { x: 0, y: 0, zoom: 0.6 },
  },
};

/** What a research entry hands the workflow. `request` is the one paragraph a
 *  CLI without the research tool still needs; the draft step fetches the rest. */
export function egmResearchTrigger(entry: {
  id: string;
  title: string;
  question: string;
  digest: string;
  recommendation: string;
}, specPath = specPathFor(entry.title)): Record<string, string> {
  const request = [
    entry.title,
    entry.question && entry.question !== entry.title ? `Question: ${entry.question}` : "",
    entry.digest ? `Finding: ${entry.digest}` : "",
    entry.recommendation ? `Recommendation: ${entry.recommendation}` : "",
  ].filter(Boolean).join(" ");
  return {
    source: "research",
    researchId: entry.id,
    researchTitle: entry.title,
    request,
    specPath,
  };
}
