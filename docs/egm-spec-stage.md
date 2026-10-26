# Spec-Driven Research: the Elephant-Goldfish Spec Stage

*   **Author:** Canopy maintainers
*   **Status:** Proposed
*   **Date:** 2026-10-26

--------------------------------------------------------------------------------

## Overview

Canopy already takes a question from research to a pull request: a research
run investigates and records a finding, and "Implement this" hands the finding
to an agent on a branch of its own. What sits between those two steps today is
one paragraph — the research digest. For small changes that is enough. For a
feature with real design choices, the implementing agent ends up making those
choices alone, in the middle of writing code, with nobody checking them.

This document adds a **Spec stage** between *Researched* and *Implementing*,
built on Google's open-source
[Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model)
(EGM, Apache-2.0). EGM is a method for spec-driven development with agents:

*   an **Elephant** — a deep-context agent — drafts a design document, and
*   a series of **Goldfish** — fresh, zero-context, read-only reviewers — each
    audit that document against a written standard, so no reviewer inherits
    the drafter's assumptions.

Canopy's workflow engine already runs every agent step as a fresh one-shot
process, which is the isolation a Goldfish needs. The work here is to ship the
EGM pipeline as a built-in workflow, close two engine gaps that stop the
pipeline from being honest, and offer it from the Research panel.

## The Problem

1.  **Design choices happen inside the implementation.** `implementContext`
    hands the agent a digest and a recommendation. Schema, API shape, edge
    cases and file layout are decided while coding, and the first review of
    those decisions is the pull request.
2.  **A single agent grades its own work.** When one session researches,
    designs and builds, its early guesses become the frame for everything
    after. Asking the same session to review the design does not help.
3.  **"Read-only" workflow steps are not read-only.** A workflow step that
    declares only `workspace-read` is launched with `effect: "reads"`, which is
    a label. Only research sessions get a real write gate in `canopy_hook`.
4.  **Agent steps cannot report a verdict.** An agent step ends in `success`
    or `failure`, and `failure` feeds the failover logic, which retries on
    another route. A reviewer that finished its job and found blocking issues
    has no way to say so without being treated as a crash.

## Goals

*   Ship an **EGM spec workflow** that a project can create from the
    Workflows view in one click and run from the canvas.
*   Offer **"Write spec"** on a researched entry. It drafts
    `docs/designs/<slug>.md`, runs the Goldfish review, and links the spec to
    the entry so "Implement this" builds against it.
*   **Enforce** read-only workflow steps: a step without `workspace-write` can
    write only inside its run directory.
*   Let an agent step declare **verdicts** and route on them, without
    disturbing failover.
*   Keep Canopy **offline-first**: the EGM personas and standards are bundled
    at a pinned upstream commit, never fetched at run time.

## Non-Goals

*   Running reviewers in parallel. The workflow executor runs one step at a
    time; a stage takes longer than EGM's parallel fan-out but produces the
    same reports.
*   A new research status. The entry stays *Researched* while its spec is
    written; the spec link and the history note say what is happening.
*   EGM's `bootstrap` and `brainstorm` skills. Research already plays the
    brainstorm role; bootstrap is a separate project.
*   Gating shell writes. The write gate covers edit tools, like the research
    gate it generalizes. A shell redirect is not seen.

## Open Questions

*   **Drift reports.** EGM's drift report fits a `git.push`-triggered
    workflow. Left for a follow-up once the spec stage has been used.
*   **Instruction files.** Workflow steps start the CLI in the project, so
    `CLAUDE.md` / `AGENTS.md` load. EGM's Claude adapters omit them for
    reviewers. Project instructions are rarely "the drafter's bias", so this
    is accepted for now.

## Critical User Journeys (CUJs)

### CUJ 1: Spec a researched feature

*   **Given**: a research entry in *Researched* with a digest and
    recommendation.
*   **When**: the user clicks **Write spec** on the entry.
*   **Then**: Canopy installs the EGM resources into `.canopy/egm/` if
    missing, links `docs/designs/<slug>.md` to the entry, starts the EGM
    workflow, and opens the Workflows view on the new run. The Elephant drafts
    the spec and the run stops at a "Review the draft" decision.

### CUJ 2: Goldfish review with a resolve loop

*   **Given**: a run waiting at "Review the draft".
*   **When**: the user chooses **Start Goldfish review**.
*   **Then**: Zoom Out, Comprehension and Design Critic reviewers run in fresh
    sessions, each writing a report under the run directory. A synthesizer
    merges them and records a verdict. On `clean` the run moves to the
    implementation-readiness stage. On `findings` an Elephant resolver fixes
    or contests each finding in the spec, and the user chooses to re-run the
    review once, continue, or stop.

### CUJ 3: Implement against the approved spec

*   **Given**: a research entry with a linked spec whose run reached
    **Approve spec**, so the finalize step set its Status to *Approved*.
*   **When**: the user clicks **Implement this**.
*   **Then**: the implementing agent's brief names the spec and tells it to
    implement against it, and to stop and say so if the spec's status is not
    *Approved*.

### CUJ 4: A reviewer tries to edit the code

*   **Given**: a Goldfish step running with only `workspace-read`.
*   **When**: the agent calls Write or Edit on a project file.
*   **Then**: the hook denies it and names the run directory as the only
    writable place.

## Technical Plan (Architecture)

```text
 Research entry ── Write spec ─▶ EGM workflow run (fresh session per step)
                                  │
   draft (Elephant, write) ──▶ [Review the draft] ──revise (≤3)──▶ draft
                                  │ review
   zoom_out ─▶ comprehension ─▶ critic ─▶ feature_verdict (synthesizer)
                                              │clean        │findings
                                              │        resolve_feature (Elephant)
                                              │             ▼
                                              │      [Feature review resolved]
                                              │       rerun (≤1) / continue / stop
                                              ▼
   codebase ─▶ readiness ─▶ impl_verdict (synthesizer)
                              │clean        │findings
                              │       resolve_impl ─▶ [Readiness resolved]
                              ▼
                [Approve spec] ──approve──▶ finalize (Status: Approved) ──▶ $completed
                               └─revise (≤2)─▶ draft
```

### 1. Prompt scope (`workflowPrompt.ts`)

Agent prompts may use four placeholders, rendered by the executor before the
attempt is reserved, so the task ledger records exactly what the agent read:

| Placeholder | Value |
| --- | --- |
| `{{run.id}}` | the workflow run id |
| `{{run.dir}}` | `<worktree>/.canopy/workflow-runs/<runId>` |
| `{{round}}` | how many times this step has been entered in this run |
| `{{trigger.<key>}}` | a string or number from the trigger payload, capped at 8 KiB; `(not provided)` when absent |

Unknown placeholders are left as written. The run directory is listed in
`.git/info/exclude` by the launcher so run artifacts never show up as changes.

### 2. Verdicts (`workflowDefinition.ts`, `workflowExecutor.ts`)

`WorkflowAgentStep` gains an optional `verdicts: string[]` (1–8 ids, not
`success` or `failure`). A step that declares verdicts:

*   must have an exit for every verdict and for `failure`, and none for
    `success`;
*   is told, by an appended protocol line, to write
    `{"verdict": "<one of them>"}` to
    `{{run.dir}}/verdicts/<stepId>.r{{round}}.json`.

After a completed attempt the executor reads that file through a new
`readVerdict` dependency. A declared verdict becomes the outcome. A missing or
undeclared verdict becomes `failure` without another attempt, because the
agent ran and did not follow the protocol — a different route will not fix
that. Failover is unchanged for attempts that did not complete.

### 3. Write gate (`canopy_hook.rs`, OpenCode plugin in `agents.rs`)

A new `CANOPY_WRITE_ROOT` environment variable confines edit-tool writes of
any extension to one directory, plus the agent CLIs' private directories. The
workflow launcher sets it to the run directory for every agent step that does
not declare `workspace-write`. Claude and Antigravity receive a PreToolUse
deny; OpenCode's plugin throws; Codex forwards the variable but, as with the
research gate, gets no deny until its PreToolUse contract is verified.

### 4. Bundled EGM resources (`src/egm/`)

The personas (`zoom_out`, `comprehension`, `design_critic`,
`implementation_readiness`, `codebase_details`, `synthesizer`), the five
document standards and the design-doc template are vendored from upstream
commit `3d0b348` under `src/egm/vendor/` with the Apache-2.0 license and a
NOTICE. They are imported with Vite `?raw` and written into the project's
`.canopy/egm/` when the user creates the workflow or writes a spec, so the
project owns a reviewable, pinned copy and agents read them as ordinary files.

### 5. Workflows view and Research panel

*   The Workflows view offers the EGM workflow as a template next to the
    existing starter, and a manual run can carry a one-line request that
    arrives as `{{trigger.request}}`.
*   `ResearchView` shows **Write spec** for entries that can move to
    *Implementing* (**Review spec** once one is linked), and marks a linked
    spec. `implementContext` names a linked
    `docs/designs/*.md` spec and tells the agent to implement against it.

## Alternatives Considered

### Alternative A: Install the EGM plugin into each agent CLI

*   **Pros**: zero Canopy code; `claude plugin install egm@egm` works today in
    a Canopy terminal.
*   **Cons**: works only on CLIs with a plugin system and subagents; the
    review happens inside one terminal session Canopy cannot see into; no
    link to research, no canvas, no human decision cards.
*   **Reason for Rejection**: kept as the zero-cost path for users who want
    it, but it does not make spec-driven work a default in Canopy.

### Alternative B: Verdicts in the task ledger

*   **Pros**: one source of truth; no extra file.
*   **Cons**: changes the Rust task envelope, `canopy_job_done` and every CLI
    adapter for a feature only workflows use.
*   **Reason for Rejection**: a file in the run directory is CLI-independent
    and the read-only gate already allows it.

### Alternative C: A new `specifying` research status

*   **Pros**: the panel could group entries being specified.
*   **Cons**: changes the Rust state machine, its mirror in `research.ts`, the
    reconciler and every surface that renders status, for a stage that may be
    skipped.
*   **Reason for Rejection**: the spec link plus a history note carry the same
    information without a migration.

--------------------------------------------------------------------------------

## Non-Functional Requirements

*   **Security**: reviewers become genuinely read-only for edit tools, which
    is stricter than today. Vendored text is scanned by the existing
    `redactSecrets` check when definitions load.
*   **Cost**: a full run is up to eleven agent sessions. The Workflows view
    makes that visible before Run; nothing starts without a click.
*   **Offline**: no network access is added.
*   **Rollback**: the workflow is a file the user can delete; the verdict and
    placeholder features are additive and inert for definitions that do not
    use them.

--------------------------------------------------------------------------------

### Additional Resources

*   Dave Rensin,
    [Elephants, Goldfish, and the New Golden Age of Software Engineering](https://medium.com/@drensin/elephants-goldfish-and-the-new-golden-age-of-software-engineering-c33641a48874).
*   EGM [architecture](https://github.com/google/elephant-goldfish-model/blob/main/docs/designs/architecture.md)
    and [harness guide](https://github.com/google/elephant-goldfish-model/blob/main/docs/harnesses.md).

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

#### 1. `src/workflowPrompt.ts`, `src/workflowRunFiles.ts` (Create)

`workflowRunDir`, `verdictPath`, `renderWorkflowPrompt`, `verdictProtocol`,
`parseVerdict`; and `prepareWorkflowRunDir` / `excludeRunsFromGit` /
`readVerdictFile` behind an injected fs. Tested in
`src/workflowPrompt.test.ts` and `src/workflowRunFiles.test.ts`.

#### 2. `src/workflowDefinition.ts` (Modify)

`verdicts` on agent steps, validation, `expectedOutcomes` for verdict steps.

#### 3. `src/workflowExecutor.ts` (Modify)

Render the prompt with the run scope, pass it and the round on
`WorkflowAgentLaunch`, map a completed attempt to its verdict through
`readVerdict`.

#### 4. `src/egm/` (Create)

Vendored resources, `EGM_SPEC_WORKFLOW_DEFINITION`, `egmResourceFiles()`,
`installEgmResources()` and `egmResearchTrigger()`; `specPath.ts` holds
`specPathFor()` / `isDesignSpec()` so `research.ts` can use them without
bundling the personas. Tested in `src/egm/egmWorkflow.test.ts`, including that
the definition passes the real validator.

#### 5. `src-tauri/src/bin/canopy_hook.rs`, `src-tauri/src/agents.rs` (Modify)

`write_root()`, `denied_root_write()`, the deny arms, the OpenCode plugin
check, and forwarding `CANOPY_WRITE_ROOT` to Codex.

#### 6. `src/components/ProjectView/index.tsx`, `src/components/WorkflowView.tsx`, `src/components/ResearchView.tsx`, `src/research.ts`, `THIRD-PARTY-NOTICES.md` (Modify)

Launcher env and run-directory setup, the template picker and run request,
**Write spec**, and the spec-aware implement brief.

### Verification Plan

*   **Type check / lint**: `npm run typecheck`, `npm run lint`.
*   **Unit tests**: `npm run test`; `cargo test --manifest-path
    src-tauri/Cargo.toml --no-default-features` for the hook gate.
*   **Manual**: create the EGM workflow in a scratch project, run it with a
    request, confirm a Goldfish step's Write outside the run directory is
    denied, and that a `findings` verdict routes to the resolver.

--------------------------------------------------------------------------------

*Drafted with EGM*
