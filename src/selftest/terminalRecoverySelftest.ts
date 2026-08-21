// Full-app proof for the invariant behind renderer recovery: a destroyed
// JavaScript page may lose every React object, but it must not lose native PTYs
// or the information required to rebuild exactly one working tab for each.

import * as ipc from "../ipc";
import { markOnboarded } from "../onboarding";
import { terminalAttachmentQueue } from "../terminalAttachmentQueue";

interface SelftestDeps {
  openDirAsProject: (dir: string) => Promise<void>;
  projectIdFor: (dir: string) => string | undefined;
}

interface TerminalCheckpoint {
  ptyId: number;
  sessionGeneration: number;
  title: string;
  projectDir: string;
  projectId: string;
  marker: string;
  kind: "desktop" | "remote";
}

interface Checkpoint {
  version: 2;
  terminals: TerminalCheckpoint[];
  completed: number;
  startedAt: number;
  cycleMs: number[];
}

const POLL_MS = 25;
const STEP_TIMEOUT_MS = 30_000;
const TERMINALS_PER_PROJECT = 2;
let running = false;

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

async function until<T>(
  label: string,
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!accept(latest)) {
    if (Date.now() >= deadline) {
      throw new Error(`${label}; last observation: ${JSON.stringify(latest)}`);
    }
    await delay(POLL_MS);
    latest = await read();
  }
  return latest;
}

const identityOf = (terminal: Pick<TerminalCheckpoint, "ptyId" | "sessionGeneration">) =>
  `${terminal.ptyId}:${terminal.sessionGeneration}`;
const markerFor = (ptyId: number, cycle: number) =>
  `CANOPY_RECOVERY_MARKER_${ptyId}_${cycle}`;

const terminalObservation = (terminals: TerminalCheckpoint[]) => {
  const byProject = new Map<string, number>();
  for (const view of document.querySelectorAll<HTMLElement>(".project-view[data-project-id]")) {
    const projectId = view.dataset.projectId;
    if (projectId) byProject.set(projectId, view.querySelectorAll(".term-host").length);
  }
  return {
    totalHosts: document.querySelectorAll(".term-host").length,
    byProject: terminals.map((terminal) => ({
      projectId: terminal.projectId,
      hosts: byProject.get(terminal.projectId) ?? 0,
    })),
    paneBars: document.querySelectorAll(".pane-bar").length,
    pending: terminals.filter((terminal) =>
      terminalAttachmentQueue.pendingIdentities().includes(identityOf(terminal)),
    ).map(identityOf),
    queue: terminalAttachmentQueue.diagnostics(),
    appText: document.body.innerText.slice(0, 500),
  };
};

async function outputContains(ptyId: number, marker: string) {
  return (await ipc.ptyOutput(ptyId, 256 * 1024))?.includes(marker) ?? false;
}

async function writeMarker(terminal: TerminalCheckpoint, cycle: number) {
  const marker = markerFor(terminal.ptyId, cycle);
  await ipc.ptyWrite(terminal.ptyId, `printf '${marker}\\n'\r`);
  await until(
    `PTY ${identityOf(terminal)} did not accept marker ${marker}`,
    () => outputContains(terminal.ptyId, marker),
    Boolean,
  );
  return marker;
}

const visibleStreamObservation = (replayEnds: Map<number, number>) => {
  const containers = [...document.querySelectorAll<HTMLElement>(".term-container")];
  const visible = containers
    .filter((host) => host.getClientRects().length > 0)
    // App bootstrap can briefly leave a fresh, unbound terminal container in
    // front of the recovered tabs. It has no native identity and is not one of
    // the streams this checkpoint is proving; counting it makes an unrelated
    // placeholder veto recovery forever. The empty result still fails below,
    // so at least one checkpointed stream must genuinely be visible.
    .filter((host) => {
      const ptyId = Number(host.dataset.ptyId);
      return Number.isFinite(ptyId) && replayEnds.has(ptyId);
    })
    .map((host) => {
      const ptyId = Number(host.dataset.ptyId);
      const expectedEnd = replayEnds.get(ptyId);
      const receivedEnd = Number(host.dataset.streamEnd ?? -1);
      return {
        ptyId,
        expectedEnd,
        receivedEnd,
        attached: host.dataset.streamAttached === "true",
        received:
          expectedEnd != null &&
          host.dataset.streamAttached === "true" &&
          receivedEnd >= expectedEnd,
      };
    });
  return {
    visible,
    allReceived: visible.length > 0 && visible.every((item) => item.received),
    activeProjects: [...document.querySelectorAll<HTMLElement>(".project-view[data-project-id]")]
      .filter((view) => view.getClientRects().length > 0)
      .map((view) => view.dataset.projectId),
    activeTabs: [...document.querySelectorAll<HTMLElement>(".tab.tab-active")]
      .map((tab) => tab.innerText.slice(0, 80)),
    containers: containers.map((host) => ({
      ptyId: host.dataset.ptyId,
      visible: host.getClientRects().length > 0,
    })),
  };
};

async function spawnTerminal(
  projectDir: string,
  projectId: string,
  ordinal: number,
): Promise<TerminalCheckpoint> {
  let spawned: ipc.SpawnResult | undefined;
  const earlyChunks: ipc.PtyChunk[] = [];
  spawned = await ipc.ptySpawn(
    { cols: 100, rows: 30, cwd: projectDir, projectId },
    (chunk) => {
      if (spawned?.generation != null) {
        void ipc.ptyAck(spawned.id, spawned.generation, chunk.bytes.length);
      } else {
        earlyChunks.push(chunk);
      }
    },
  );
  if (spawned.generation == null) throw new Error("selftest PTY has no desktop stream");
  for (const chunk of earlyChunks) {
    void ipc.ptyAck(spawned.id, spawned.generation, chunk.bytes.length);
  }
  const title = `recovery-proof-${ordinal}-${spawned.id}-${spawned.session_generation}`;
  await ipc.ptySetTitle(spawned.id, title);
  const terminal: TerminalCheckpoint = {
    ptyId: spawned.id,
    sessionGeneration: spawned.session_generation,
    title,
    projectDir,
    projectId,
    marker: "",
    kind: "desktop",
  };
  terminal.marker = await writeMarker(terminal, 0);
  return terminal;
}

async function spawnRemoteTerminal(
  projectDir: string,
  projectId: string,
  ordinal: number,
): Promise<TerminalCheckpoint> {
  const spawned = await ipc.selftestSpawnRemote(projectDir);
  if (spawned.kind !== "remote") {
    throw new Error(`selftest remote spawn has kind ${spawned.kind}`);
  }
  const title = `recovery-remote-${ordinal}-${spawned.id}-${spawned.session_generation}`;
  await ipc.ptySetTitle(spawned.id, title);
  const terminal: TerminalCheckpoint = {
    ptyId: spawned.id,
    sessionGeneration: spawned.session_generation,
    title,
    projectDir,
    projectId,
    marker: "",
    kind: "remote",
  };
  terminal.marker = await writeMarker(terminal, 0);
  return terminal;
}

async function reloadAndYield(): Promise<never> {
  await ipc.selftestReloadRenderer();
  // The native call has accepted the reload. This promise belongs to the page
  // being destroyed; the replacement page starts from its native checkpoint.
  return await new Promise<never>(() => {});
}

export async function runTerminalRecoverySelftest(
  cfg: ipc.SelftestConfig,
  deps: SelftestDeps,
) {
  if (running) return;
  running = true;
  markOnboarded();

  let checkpoint = await ipc.selftestCheckpoint<Checkpoint>();
  if (checkpoint == null) {
    const projectDirs = cfg.projectDirs.length ? cfg.projectDirs : [cfg.projectDir];
    for (const projectDir of projectDirs) await deps.openDirAsProject(projectDir);
    const projects = await until(
      "scratch projects did not all open",
      () => projectDirs.map((dir) => ({ dir, id: deps.projectIdFor(dir) })),
      (items) => items.every((item) => Boolean(item.id)),
    );

    const terminals: TerminalCheckpoint[] = [];
    for (const project of projects) {
      for (let index = 0; index < TERMINALS_PER_PROJECT; index += 1) {
        terminals.push(
          await spawnTerminal(project.dir, project.id!, terminals.length + 1),
        );
      }
      terminals.push(
        await spawnRemoteTerminal(project.dir, project.id!, terminals.length + 1),
      );
    }
    checkpoint = {
      version: 2,
      terminals,
      completed: 0,
      startedAt: Date.now(),
      cycleMs: [],
    };
    await ipc.selftestCheckpointSave(checkpoint);
    void ipc.jsLog(
      "info",
      `terminal:SELFTEST spawned ${terminals.map(identityOf).join(",")}; starting ${cfg.iterations} reloads`,
    );
    return reloadAndYield();
  }

  if (checkpoint.version !== 2) throw new Error("unsupported terminal recovery checkpoint");
  const cycleStarted = Date.now();
  const expected = new Set(checkpoint.terminals.map(identityOf));
  const live = await until(
    `not every PTY survived reload ${checkpoint.completed + 1}`,
    () => ipc.rendererPtySessionsLive(),
    (sessions) =>
      checkpoint!.terminals.every((terminal) =>
        sessions.some(
          (session) =>
            identityOf({
              ptyId: session.id,
              sessionGeneration: session.session_generation,
            }) === identityOf(terminal) &&
            session.kind === terminal.kind &&
            (terminal.kind !== "desktop" || session.project_id === terminal.projectId),
        ),
      ),
  );
  const recovered = live.filter((session) =>
    expected.has(`${session.id}:${session.session_generation}`),
  );
  if (recovered.length !== checkpoint.terminals.length) {
    throw new Error(`native identities duplicated or missing: ${JSON.stringify(recovered)}`);
  }

  const expectedPerProject = new Map<string, number>();
  for (const terminal of checkpoint.terminals) {
    expectedPerProject.set(
      terminal.projectId,
      (expectedPerProject.get(terminal.projectId) ?? 0) + 1,
    );
  }
  await until(
    "recovered terminal tabs did not commit once in their owning projects",
    () => terminalObservation(checkpoint!.terminals),
    (observation) =>
      observation.totalHosts === checkpoint!.terminals.length &&
      observation.pending.length === 0 &&
      observation.byProject.every(
        ({ projectId, hosts }) => hosts === expectedPerProject.get(projectId),
      ),
  );
  for (const terminal of checkpoint.terminals) {
    if (!(await outputContains(terminal.ptyId, terminal.marker))) {
      throw new Error(`scrollback lost ${terminal.marker} from ${identityOf(terminal)}`);
    }
  }

  const completed = checkpoint.completed + 1;
  const updated: TerminalCheckpoint[] = [];
  for (const terminal of checkpoint.terminals) {
    updated.push({
      ...terminal,
      marker: await writeMarker(terminal, completed),
    });
  }

  // Queue receipt and native scrollback are necessary but not sufficient: a
  // transient pty_attach_desktop failure happens after both. Snapshot the
  // native byte cursor after writing each marker, then require every visible
  // xterm stream to accept through that exact cursor. This proves ordered bytes
  // crossed the channel without depending on WebKit's text-rendering internals.
  const afterMarkers = await ipc.rendererPtySessionsLive();
  const replayEnds = new Map(afterMarkers.map((session) => [session.id, session.replay_end]));
  await until(
    "visible terminals never resumed their live streams",
    () => visibleStreamObservation(replayEnds),
    (observation) => observation.allReceived,
  );
  checkpoint = {
    ...checkpoint,
    terminals: updated,
    completed,
    cycleMs: [...checkpoint.cycleMs, Date.now() - cycleStarted],
  };
  await ipc.selftestCheckpointSave(checkpoint);
  void ipc.jsLog(
    "info",
    `terminal:SELFTEST reload ${completed}/${cfg.iterations} kept ${updated.map(identityOf).join(",")}`,
  );

  if (completed < cfg.iterations) return reloadAndYield();

  for (const terminal of checkpoint.terminals) await ipc.ptyKill(terminal.ptyId);
  await until(
    "selftest PTYs did not exit after cleanup",
    () => ipc.rendererPtySessionsLive(),
    (sessions) => !sessions.some((session) => expected.has(`${session.id}:${session.session_generation}`)),
  );
  await ipc.selftestFinish({
    ok: true,
    scenario: cfg.scenario,
    iterations: completed,
    projects: new Set(checkpoint.terminals.map((terminal) => terminal.projectId)).size,
    terminals: checkpoint.terminals.length,
    registrationFailures: cfg.registrationFailures,
    listenerFailures: cfg.listenerFailures,
    attachFailures: cfg.attachFailures,
    identities: checkpoint.terminals.map(identityOf),
    durationMs: Date.now() - checkpoint.startedAt,
    cycleMs: checkpoint.cycleMs,
    duplicateTabs: 0,
    lostMarkers: 0,
  });
}
