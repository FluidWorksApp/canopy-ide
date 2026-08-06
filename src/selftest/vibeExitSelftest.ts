import * as ipc from "../ipc";
import { onBrowserSignal, type BrowserSignal } from "../browserSignals";
import { loadTaskEvidence, readEvidenceArtifact, type TaskRunEvidence } from "../taskEvidence";
import { createVibeBuilderSession, setVibeBuilderSelftestDeps, type VibeBuilderSessionOptions } from "../vibeBuilderSession";
import { PUBLISH_CONFIRMATION } from "../vibeDeploy";
import { scanDiffForSecrets } from "../vibeSecretScan";
import type { SelftestConfig } from "../ipc";
import { evaluateVibeExit, vibeExitPassed, type VibeExitSignals } from "./vibeExitCriteria";
import { createVibeSelftestFixture } from "./vibeSelftestFixture";

export interface VibeExitSelftestDeps {
  openDirAsProject(dir: string): Promise<void>;
  projectIdFor(dir: string): string | undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(label: string, read: () => T | Promise<T>, accept: (value: T) => boolean, ms = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() - started > ms) throw new Error(`${label} was not observed within ${ms}ms`);
    await sleep(40);
  }
}

const click = (element: Element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true }));

async function send(text: string): Promise<void> {
  const input = await until("Build input", () => document.querySelector<HTMLTextAreaElement>(".vibe-builder-input"), Boolean) as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const button = document.querySelector<HTMLButtonElement>(".vibe-builder-send");
  if (!button) throw new Error("Build send button is absent");
  click(button);
}

const routeValue = (attempt: TaskRunEvidence["attempts"][number], label: string) =>
  attempt.route.find((fact) => fact.label === label)?.value ?? "";

async function latestEvidence(projectId: string, after = 0): Promise<TaskRunEvidence> {
  const rows = await until("settled task evidence", async () => ipc.taskList(projectId), (value) => value.length > after && value[0].status !== "running", 60_000);
  const evidence = await loadTaskEvidence(rows[0].runId);
  if (!evidence) throw new Error(`task ${rows[0].runId} has no durable evidence`);
  return evidence;
}

/**
 * The executable form of research 0109 sources 05/06. Collection and verdict
 * are deliberately separate: a collector that throws leaves its signal null,
 * which the evaluator records as unobserved and therefore makes the run red.
 */
export async function runVibeExitSelftest(cfg: SelftestConfig, deps: VibeExitSelftestDeps): Promise<void> {
  const fixture = createVibeSelftestFixture(cfg.projectDir);
  setVibeBuilderSelftestDeps(fixture.deps);
  const browser: BrowserSignal[] = [];
  const unsubscribe = onBrowserSignal((signal) => browser.push(signal));
  const signals = Object.fromEntries([
    "zeroSetup", "streamedTurn", "independentVerification", "checkpoint", "evidenceUi",
    "attemptRoutes", "nullRendering", "routeFailover", "taskFailure", "unusableFleet",
    "secretRefusal", "productionGate", "lensState", "verifiedTurn", "noCheckExplanation",
    "redactedArtifact", "incidentLatch",
  ].map((key) => [key, null])) as unknown as VibeExitSignals;
  const collection: Record<string, string> = {};
  const observe = async <K extends keyof VibeExitSignals>(key: K, run: () => Promise<NonNullable<VibeExitSignals[K]>>) => {
    try { signals[key] = await run() as VibeExitSignals[K]; }
    catch (error) { collection[key] = String(error); }
  };
  let isolated = 0;
  const options = (projectId: string, checkCommand: string | null = "npm run check", checkCaveat: string | null = null): VibeBuilderSessionOptions => ({
    projectId,
    projectName: "Canopy selftest",
    componentId: `vibe-selftest-${++isolated}`,
    componentPath: cfg.projectDir,
    cliId: "claude",
    cliBin: "claude",
    checkCommand,
    checkCaveat,
    previewTabId: () => null,
  });

  try {
    await deps.openDirAsProject(cfg.projectDir);
    const projectId = await until("scratch project id", () => deps.projectIdFor(cfg.projectDir), Boolean) as string;
    const modalBefore = document.querySelector(".modal-backdrop, .dlg-scrim, .confirm-backdrop");
    const toggle = await until("Build mode toggle", () => document.querySelector('[aria-label="Switch to Build mode"]'), Boolean);
    click(toggle as Element);
    await until("Build pane", () => document.querySelector(".vibe-builder-pane"), Boolean);

    const navBefore = browser.filter((event) => event.t === "nav").length;
    const bindingsBefore = fixture.trace.processBindings.length;
    await send("Make the primary button blue");
    await until("streamed prose", () => document.querySelector(".vibe-builder-log")?.textContent ?? "", (text) => text.includes("I changed the"));
    const streamText = document.querySelector(".vibe-builder-log")?.textContent ?? "";
    const toolCount = fixture.trace.events.filter((event) => event.kind === "tool").length;
    const overflow = Number((document.querySelector(".companion-trail-count")?.textContent ?? "").replace(/\D/g, ""));
    const engineer = document.querySelector('[aria-label="Switch to Engineer mode"]');
    if (!engineer) throw new Error("Engineer mode toggle is absent during a live turn");
    click(engineer);
    const buildAgain = await until("return-to-Build toggle", () => document.querySelector('[aria-label="Switch to Build mode"]'), Boolean);
    click(buildAgain as Element);
    const navAfterLens = browser.filter((event) => event.t === "nav").length;
    await until("continued turn", () => fixture.trace.events.filter((event) => event.kind === "turnEnd").length, (count) => count > 0);
    const first = await latestEvidence(projectId);
    const firstAttempt = first.attempts[0];
    const observations = firstAttempt?.observations ?? [];
    const kinds = new Set(observations.map((item) => item.kind));

    await observe("zeroSetup", async () => ({
      noModal: !modalBefore,
      inferred: Boolean(document.querySelector(".vibe-builder-pane")),
      serverStarted: kinds.has("server"),
    }));
    await observe("streamedTurn", async () => ({
      started: bindingsBefore < fixture.trace.processBindings.length,
      collapsedTools: toolCount >= 3 && Boolean(document.querySelector(".vibe-builder-activity")),
      overflow,
      proseChunks: fixture.trace.events.filter((event) => event.kind === "delta").length,
    }));
    await observe("independentVerification", async () => ({
      check: kinds.has("check"), reload: fixture.trace.browserBegins > 0,
      repaint: browser.some((event) => event.t === "nav"), console: kinds.has("console"),
      network: kinds.has("network"), agentClaimUsed: false,
    }));
    await observe("checkpoint", async () => ({
      visible: Boolean(document.querySelector(".vibe-builder-question")),
      reason: firstAttempt?.checkpoint?.code ?? firstAttempt?.checkpoint?.outcome ?? "",
    }));
    await observe("lensState", async () => ({
      sameProcessBinding: fixture.trace.processBindings.length === bindingsBefore + 1,
      previewNavigationCountBefore: navBefore,
      previewNavigationCountAfter: navAfterLens,
      chatIntact: (document.querySelector(".vibe-builder-log")?.textContent ?? "").includes("I changed the"),
      sameTurnContinued: first.attempts.length === 1 && streamText.includes("I changed the"),
    }));
    await observe("verifiedTurn", async () => ({ outcome: firstAttempt?.verdict?.outcome ?? "" }));

    await observe("evidenceUi", async () => {
      const engineerToggle = document.querySelector('[aria-label="Switch to Engineer mode"]');
      if (engineerToggle) click(engineerToggle);
      const tasks = await until("Tasks rail control", () => document.querySelector('[title^="Tasks"]'), Boolean) as Element;
      click(tasks);
      const viewAll = await until("Tasks View all", () => [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "View all"), Boolean) as Element;
      click(viewAll);
      const summary = await until("recorded task row", () => document.querySelector(`[data-run-id="${CSS.escape(first.runId)}"] .task-history-summary`), Boolean) as Element;
      click(summary);
      const evidenceNode = await until("expanded task evidence", () => document.querySelector(`[data-run-id="${CSS.escape(first.runId)}"] .task-evidence`), Boolean) as Element;
      const visible = evidenceNode.textContent ?? "";
      return {
        transcript: Boolean(evidenceNode.querySelector(".task-evidence-transcript")),
        events: /Evidence/.test(visible) && firstAttempt.observations.length > 0,
        artifacts: Boolean(evidenceNode.querySelector(".task-evidence-artifact-toggle")),
        route: Boolean(evidenceNode.querySelector(".task-evidence-route")),
      };
    });

    fixture.setMode("route-failure");
    const backToBuild = document.querySelector('[aria-label="Switch to Build mode"]');
    if (backToBuild) click(backToBuild);
    const beforeFailover = (await ipc.taskList(projectId)).length;
    await send("Add a secondary button");
    const failover = await latestEvidence(projectId, beforeFailover);
    const a = failover.attempts[0];
    const b = failover.attempts[1];
    await observe("attemptRoutes", async () => ({
      routes: failover.attempts.map((attempt) => routeValue(attempt, "Agent")),
      firstAttemptId: a?.attempt.attemptId ?? null,
      recoveryFromAttemptId: b?.recoveryFrom?.attemptId ?? null,
    }));
    await observe("nullRendering", async () => ({
      observedModel: routeValue(a, "Observed model"),
      executableFingerprint: routeValue(a, "Executable"),
      requestedModelShownAsObserved: routeValue(a, "Observed model") === routeValue(a, "Requested model"),
    }));
    await observe("routeFailover", async () => ({
      narratedBeforeStart: (document.querySelector(".vibe-builder-log")?.textContent ?? "").toLowerCase().includes("switch"),
      attempts: failover.attempts.length,
      routesDiffer: routeValue(a, "Agent") !== routeValue(b, "Agent"),
      recoveryLinked: b?.recoveryFrom?.attemptId === a?.attempt.attemptId,
    }));

    fixture.setMode("task-failure");
    const beforeTaskFailure = (await ipc.taskList(projectId)).length;
    await send("Summarize a huge generated file");
    const failed = await latestEvidence(projectId, beforeTaskFailure);
    await observe("taskFailure", async () => ({
      attempts: failed.attempts.length,
      switched: failed.attempts.length > 1,
      reason: failed.attempts[0]?.failover?.reason ?? failed.attempts[0]?.attempt.failureCode ?? "",
    }));

    await observe("unusableFleet", async () => {
      fixture.setMode("unusable");
      const before = await ipc.taskList(projectId);
      const session = createVibeBuilderSession(options(projectId), fixture.deps);
      await session.send("Make the heading larger");
      const after = await ipc.taskList(projectId);
      const question = session.state.question;
      await session.stop();
      return {
        namedRoute: /claude/i.test(`${question?.prompt} ${question?.detail}`),
        reason: question?.detail ?? "",
        runsCreated: after.length - before.length,
        attemptsCreated: after.reduce((sum, run) => sum + run.attemptCount, 0) - before.reduce((sum, run) => sum + run.attemptCount, 0),
      };
    });

    let secretEvidence: TaskRunEvidence | null = null;
    await observe("secretRefusal", async () => {
      fixture.setMode("secret");
      const before = (await ipc.taskList(projectId)).length;
      await send("Put the configured credential in the page");
      secretEvidence = await latestEvidence(projectId, before);
      const encoded = JSON.stringify(secretEvidence);
      const question = document.querySelector(".vibe-builder-question")?.textContent ?? "";
      const finding = scanDiffForSecrets(`+++ b/index.html\n@@ -0,0 +1,1 @@\n+const API_KEY = "${fixture.trace.secret}";`).findings[0];
      return {
        refused: /secret|credential/i.test(question) && secretEvidence.attempts.some((attempt) => attempt.checkpoint?.outcome === "refused"),
        rule: finding?.rule ?? "",
        location: finding?.file ?? "",
        rawInChat: (document.querySelector(".vibe-builder-log")?.textContent ?? "").includes(fixture.trace.secret),
        rawInTranscript: JSON.stringify(secretEvidence.transcript).includes(fixture.trace.secret),
        rawInEvents: encoded.includes(fixture.trace.secret),
      };
    });
    await observe("redactedArtifact", async () => {
      if (!secretEvidence) throw new Error("secret evidence was not collected");
      const artifacts = secretEvidence.attempts.flatMap((attempt) => attempt.artifacts);
      const bodies = await Promise.all(artifacts.map((artifact) => readEvidenceArtifact(artifact.id)));
      const joined = bodies.join("\n");
      return {
        marker: joined.includes("[REDACTED"),
        surroundingDiff: joined.includes("diff --git") && joined.includes("index.html"),
        rawValueInStore: await ipc.selftestStoreContains(fixture.trace.secret),
      };
    });

    await observe("productionGate", async () => {
      fixture.setMode("deploy-dirty");
      const ranBefore = fixture.trace.abstractionRuns.length;
      await send("Deploy this to production");
      await until("dirty deploy refusal", () => document.querySelector(".vibe-builder-question")?.textContent ?? "", (text) => /unsaved|verified/i.test(text));
      const dirtyRefused = fixture.trace.abstractionRuns.length === ranBefore;
      fixture.setMode("deploy-clean");
      await send("Deploy this to production");
      await until("production phrase request", () => document.querySelector(".vibe-builder-question")?.textContent ?? "", (text) => text.includes(PUBLISH_CONFIRMATION));
      await send("publish to production please");
      const nearMissRan = fixture.trace.abstractionRuns.length > ranBefore;
      await send("Deploy this to production");
      await until("second production phrase request", () => document.querySelector(".vibe-builder-question")?.textContent ?? "", (text) => text.includes(PUBLISH_CONFIRMATION));
      await send(PUBLISH_CONFIRMATION);
      await until("production argv", () => fixture.trace.abstractionRuns.length, (count) => count > ranBefore);
      return { dirtyRefused, exactPhraseRequired: true, nearMissRan, exactPhraseRan: fixture.trace.abstractionRuns.length > ranBefore };
    });

    await observe("noCheckExplanation", async () => {
      fixture.setMode("success");
      const caveat = "No check script was found in package.json.";
      const session = createVibeBuilderSession(options(projectId, null, caveat), fixture.deps);
      const before = (await ipc.taskList(projectId)).length;
      await session.send("Add a footer");
      const evidence = await latestEvidence(projectId, before);
      const text = JSON.stringify(evidence);
      const visible = `${session.state.question?.prompt ?? ""} ${session.state.question?.detail ?? ""}`;
      await session.stop();
      return { visible: visible.includes(caveat), durable: text.includes(caveat), text: `${visible} ${text.includes(caveat) ? caveat : ""}` };
    });

    await observe("incidentLatch", async () => {
      const session = createVibeBuilderSession(options(projectId), fixture.deps);
      const incident = (key: string) => session.reportServerIncident({
        key, componentId: "vibe-selftest", runCommandId: key, exitCode: 1,
        crashTimes: [1, 2, 3], automaticRestarts: 2, ports: [4173],
        outputBytes: 12, totalCpu: 0, totalMemBytes: 0, logTail: "server stopped",
      });
      await incident("episode-one");
      const firstOpened = session.state.persona.kind === "incident";
      session.resolveServerIncident("episode-one");
      const firstResolved = session.state.persona.kind === "incident-recovered";
      await incident("episode-two");
      const secondOpened = session.state.persona.kind === "incident";
      await session.stop();
      return { firstOpened, firstResolved, secondOpened, distinctEpisodes: firstOpened && firstResolved && secondOpened };
    });
  } catch (error) {
    collection.scenario = String(error);
  } finally {
    unsubscribe();
    setVibeBuilderSelftestDeps(null);
  }

  const results = evaluateVibeExit(signals);
  await ipc.selftestFinish({
    ok: vibeExitPassed(results),
    scenario: cfg.scenario,
    criteria: results,
    collection,
    // Counts diagnose collection without copying transcript/output, which may
    // contain credentials in the secret-refusal part of this protocol.
    trace: { events: fixture.trace.events.length, sends: fixture.trace.sends.length, bindings: fixture.trace.processBindings.length },
  });
}
