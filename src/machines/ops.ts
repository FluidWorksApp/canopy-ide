// What an agent can ask of the machine channel, answered by the window.
//
// The window is the one place connected to every machine the person works on
// (this Mac, the workspace the window is on, the others it can open beside
// it), so it is where "run this over there" is carried out. An agent on any of
// those machines asks through its Canopy tools; the request arrives here with
// two facts the agent cannot choose: which machine it is running on, and the
// folder it is in. Everything else follows from those:
//
//   - the repository is the one that folder is a checkout of;
//   - "over there" is the checkout of that same repository on the machine
//     named (found by its origin, never by a path the agent supplies);
//   - files are named relative to the repository, so nothing outside it is
//     read or written on any machine.
//
// One thing is the person's to decide: whether agents on one machine may drive
// another at all. The first time it comes up for a repository they are asked
// (`consent`), and the answer is remembered by the caller.
import {
  ChannelError,
  checkoutAt,
  copyPath,
  formatBytes,
  joinPath,
  mustSh,
  parseFields,
  runFailure,
  RUN_CEILING_MS,
  safeRelativePath,
  shOn,
  type ChannelMachine,
  type Checkout,
} from "./channel";
import { parseRecipe, RECIPE_EXAMPLE, RECIPE_PATH, workflowMachines, type Recipe, type Step } from "./recipe";
import { repoIdFromOrigin, repoIdLabel, sameRepoId, type RepoId } from "./repoIdentity";
import { syncCheckout } from "./sync";

export interface KnownMachine {
  /** "local" for the computer showing the IDE, else the workspace id. */
  id: string;
  name: string;
  kind: "this-mac" | "cloud" | "own";
  /** Running and connectable now. A stopped cloud workspace is listed, not woken. */
  reachable: boolean;
}

export const THIS_MAC = "local";

/** The machines this window can reach, and a connection to each. */
export interface MachineDirectory {
  list(): Promise<KnownMachine[]>;
  /** Rejects when the machine cannot be reached. */
  open(id: string): Promise<ChannelMachine>;
}

export interface ConsentRequest {
  from: { id: string; name: string };
  to: { id: string; name: string };
  /** The repository, as shown to the person. */
  repository: string;
}

export interface MachineOpContext {
  /** The machine the calling agent is running on. */
  originId: string;
  /** The agent's working directory there. */
  cwd: string;
  directory: MachineDirectory;
  /** May agents on `from` run commands and move files on `to` for this
   *  repository? Asked each time; the caller remembers a yes. */
  consent(request: ConsentRequest): Promise<boolean>;
  /** One line as each step of a long operation starts. */
  onProgress?(line: string): void;
}

const MAC_NAMES = new Set(["local", "this-mac", "this mac", "mac", "thismac", "desktop"]);
const TAIL = 12_000;

const tail = (text: string, max = TAIL): string => (text.length > max ? `…${text.slice(text.length - max)}` : text);

// ---- finding the repository on a machine -----------------------------------

// Repositories at or just under the given folders: `repo=<dir>\t<origin>`.
const SCAN = `for p in "$@"; do
  for d in "$p" "$p"/* "$p"/*/*; do
    if [ -e "$d/.git" ]; then
      o=$(git -C "$d" remote get-url origin 2>/dev/null || true)
      if [ -n "$o" ]; then printf 'repo=%s\\t%s\\n' "$d" "$o"; fi
    fi
  done
done | head -400`;

const found = new Map<string, { at: number; tops: string[] }>();
const FOUND_TTL_MS = 2 * 60_000;

/** Forget where repositories were found (a project was added, a clone made). */
export function forgetCheckouts(): void {
  found.clear();
}

/** Every checkout of `repo` on `machine`: its projects' folders, and what sits
 *  directly under them (a workspace's one project is often the folder that
 *  holds all its repositories). */
export async function checkoutsOf(machine: ChannelMachine, repo: RepoId, now = Date.now()): Promise<string[]> {
  const key = `${machine.id}\n${repo.host}/${repo.slug}`.toLowerCase();
  const hit = found.get(key);
  if (hit && now - hit.at < FOUND_TTL_MS && hit.tops.length) return hit.tops;
  const tops: string[] = [];
  const add = (dir: string, origin: string) => {
    const id = repoIdFromOrigin(origin);
    const top = dir.replace(/\/+$/, "");
    if (id && sameRepoId(id, repo) && !tops.includes(top)) tops.push(top);
  };
  if (machine.desktop) {
    const rows = await machine.invoke<{ dir: string; root?: string; origin: string }[]>("git_project_checkouts").catch(() => []);
    for (const row of Array.isArray(rows) ? rows : []) if (typeof row?.origin === "string") add(row.root || row.dir, row.origin);
  } else {
    const raw = await machine.invoke<unknown>("store_load").catch(() => null);
    let store: unknown = raw;
    if (typeof raw === "string") {
      try {
        store = JSON.parse(raw);
      } catch {
        store = null;
      }
    }
    const paths: string[] = [];
    for (const project of ((store as { projects?: unknown })?.projects as { components?: { path?: unknown }[] }[] | undefined) ?? []) {
      for (const component of project?.components ?? []) {
        if (typeof component?.path === "string" && component.path.startsWith("/") && !paths.includes(component.path)) paths.push(component.path);
      }
    }
    if (paths.length) {
      const out = await shOn(machine, paths[0], SCAN, paths.slice(0, 32), { head: true, keepBytes: 256 * 1024 }).catch(() => null);
      for (const line of parseFields(out?.stdout ?? "").all.repo ?? []) {
        const tab = line.indexOf("\t");
        if (tab > 0) add(line.slice(0, tab), line.slice(tab + 1));
      }
    }
  }
  // A worktree beside the repository is a checkout too, but the repository
  // itself is the one to prefer when nothing says otherwise.
  tops.sort((a, b) => Number(/-wt-[^/]+$/.test(a)) - Number(/-wt-[^/]+$/.test(b)));
  found.set(key, { at: now, tops });
  return tops;
}

// ---- one request -----------------------------------------------------------

/** What every op starts from: who is asking, from where, about which repository. */
class Session {
  readonly ctx: MachineOpContext;
  readonly origin: ChannelMachine;
  readonly here: Checkout;
  readonly repo: RepoId;
  readonly recipe: Recipe;
  readonly roles: Record<string, string>;
  private known: KnownMachine[] | null = null;
  private readonly allowed = new Set<string>();
  private readonly opened = new Map<string, Promise<ChannelMachine>>();

  constructor(ctx: MachineOpContext, origin: ChannelMachine, here: Checkout, repo: RepoId, recipe: Recipe, roles: Record<string, string>) {
    this.ctx = ctx;
    this.origin = origin;
    this.here = here;
    this.repo = repo;
    this.recipe = recipe;
    this.roles = roles;
    this.opened.set(origin.id, Promise.resolve(origin));
  }

  async machines(): Promise<KnownMachine[]> {
    this.known ??= await this.ctx.directory.list();
    return this.known;
  }

  /** A machine by "here", "this-mac", a recipe role, its name or its id. */
  async machine(ref: string): Promise<ChannelMachine> {
    const known = await this.resolve(ref);
    let pending = this.opened.get(known.id);
    if (!pending) {
      pending = this.ctx.directory.open(known.id).catch((error) => {
        this.opened.delete(known.id);
        throw new ChannelError(`${known.name} could not be reached: ${String((error as { message?: string })?.message ?? error)}`);
      });
      this.opened.set(known.id, pending);
    }
    const machine = await pending;
    await this.allow(machine);
    return machine;
  }

  async resolve(ref: string, depth = 0): Promise<KnownMachine> {
    const name = String(ref ?? "").trim();
    if (!name) throw new ChannelError("Name a machine (see canopy_machines).");
    const all = await this.machines();
    const lower = name.toLowerCase();
    if (lower === "here") return all.find((m) => m.id === this.origin.id) ?? { id: this.origin.id, name: this.origin.name, kind: "own", reachable: true };
    // A role wins over a machine that happens to share its name, so a recipe
    // means the same thing whatever the machines are called.
    if (depth === 0 && this.roles[name] && this.roles[name].trim().toLowerCase() !== lower) return this.resolve(this.roles[name], 1);
    const match =
      all.find((m) => m.id === name) ??
      all.find((m) => m.name.toLowerCase() === lower) ??
      (MAC_NAMES.has(lower) ? all.find((m) => m.id === THIS_MAC) : undefined);
    if (!match) {
      throw new ChannelError(
        `No machine called "${name}". There ${all.length === 1 ? "is" : "are"}: ${all.map((m) => m.name).join(", ")}${Object.keys(this.roles).length ? ` (roles: ${Object.keys(this.roles).join(", ")})` : ""}.`,
      );
    }
    if (!match.reachable) throw new ChannelError(`${match.name} is not running, so nothing can be done on it. Start it first.`);
    return match;
  }

  /** Agents drive another machine only once the person has said they may. */
  private async allow(target: ChannelMachine): Promise<void> {
    if (target.id === this.origin.id || this.allowed.has(target.id)) return;
    const ok = await this.ctx.consent({
      from: { id: this.origin.id, name: this.origin.name },
      to: { id: target.id, name: target.name },
      repository: repoIdLabel(this.repo),
    });
    if (!ok) throw new ChannelError(`Not allowed: the person did not let agents on ${this.origin.name} work on ${target.name}.`);
    this.allowed.add(target.id);
  }

  /** The repository's checkout on a machine. `ref` is how the caller named the
   *  machine, for a recipe's `checkouts` entry. */
  async checkout(machine: ChannelMachine, ref?: string): Promise<Checkout> {
    if (machine.id === this.origin.id) return this.here;
    const pinned = (ref && this.recipe.checkouts[ref]) || this.recipe.checkouts[machine.name] || this.recipe.checkouts[machine.id];
    const label = repoIdLabel(this.repo);
    if (pinned) {
      const checkout = await checkoutAt(machine, pinned).catch(() => null);
      const origin = checkout ? (await shOn(machine, checkout.top, "git remote get-url origin 2>/dev/null || true", [], { head: true })).stdout.trim() : "";
      const id = repoIdFromOrigin(origin);
      if (!checkout || !id || !sameRepoId(id, this.repo)) {
        throw new ChannelError(`${RECIPE_PATH} says ${label} is at ${pinned} on ${machine.name}, but that is not a checkout of it.`);
      }
      return checkout;
    }
    const tops = await checkoutsOf(machine, this.repo);
    if (!tops.length) {
      throw new ChannelError(
        `${label} is not set up on ${machine.name}. Clone it there first (Send to workspace, or Teleport, from the project), then try again.`,
      );
    }
    return checkoutAt(machine, tops[0]);
  }
}

async function openSession(ctx: MachineOpContext, roles: unknown): Promise<Session> {
  let origin: ChannelMachine;
  try {
    origin = await ctx.directory.open(ctx.originId);
  } catch (error) {
    throw new ChannelError(`The machine this session runs on could not be reached: ${String((error as { message?: string })?.message ?? error)}`);
  }
  if (!ctx.cwd.startsWith("/")) throw new ChannelError("This session has no working directory, so there is no repository to work on.");
  const here = await checkoutAt(origin, ctx.cwd).catch(() => {
    throw new ChannelError(`${ctx.cwd} is not inside a git repository. The machine tools work on a repository's checkouts.`);
  });
  const remote = (await mustSh(origin, here.top, "git remote get-url origin 2>/dev/null || true", [], "Reading the repository's origin")).trim();
  const repo = repoIdFromOrigin(remote);
  if (!repo) {
    throw new ChannelError(
      `${here.top} has no origin remote. Its checkout on another machine is found by the origin they share, so add one (git remote add origin …) first.`,
    );
  }
  const text = (await shOn(origin, here.top, 'cat -- "$1" 2>/dev/null || true', [joinPath(here.top, RECIPE_PATH)], { head: true, keepBytes: 256 * 1024 })).stdout;
  const recipe = parseRecipe(text);
  const given: Record<string, string> = {};
  if (roles && typeof roles === "object" && !Array.isArray(roles)) {
    for (const [key, value] of Object.entries(roles as Record<string, unknown>)) if (typeof value === "string" && value.trim()) given[key] = value.trim();
  }
  return new Session(ctx, origin, here, repo, recipe, { ...recipe.machines, ...given });
}

// ---- the ops ---------------------------------------------------------------

async function list(ctx: MachineOpContext): Promise<unknown> {
  const session = await openSession(ctx, undefined);
  const all = await session.machines();
  const rows = await Promise.all(
    all.map(async (m) => {
      const base = { name: m.name, id: m.id, kind: m.kind, here: m.id === session.origin.id };
      if (m.id === session.origin.id) return { ...base, checkout: session.here.top };
      if (!m.reachable) return { ...base, checkout: null, note: "not running" };
      try {
        // Looking is not driving: the list never asks for consent.
        const machine = await Promise.race([
          ctx.directory.open(m.id),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer in 10 s")), 10_000)),
        ]);
        const tops = await checkoutsOf(machine, session.repo);
        return tops.length
          ? { ...base, checkout: tops[0], ...(tops.length > 1 ? { otherCheckouts: tops.slice(1) } : {}), ...(machine.readOnly ? { note: "view-only" } : {}) }
          : { ...base, checkout: null, note: "this repository is not set up there" };
      } catch (error) {
        return { ...base, checkout: null, note: `could not be reached: ${String((error as { message?: string })?.message ?? error)}` };
      }
    }),
  );
  const workflows = Object.entries(session.recipe.workflows).map(([name, w]) => ({
    name,
    ...(w.description ? { description: w.description } : {}),
    steps: w.steps.map(describeStep),
    machines: workflowMachines(w),
  }));
  return {
    repository: repoIdLabel(session.repo),
    machines: rows,
    roles: session.roles,
    workflows,
    ...(workflows.length
      ? {}
      : { recipe: `No workflows yet. Add ${RECIPE_PATH} to the repository to define them, for example:\n${RECIPE_EXAMPLE}` }),
    note:
      "Name a machine by its name, \"here\" (where you are running) or \"this-mac\" (the computer showing the IDE). Paths are relative to the repository. " +
      "canopy_machine_run syncs your working tree to the other machine first unless sync is false.",
  };
}

function describeStep(step: Step): string {
  if (step.kind === "sync") return `sync ${step.from} → ${step.to}${step.overwrite ? " (overwrite)" : ""}`;
  if (step.kind === "copy") return `copy ${step.path} ${step.from} → ${step.to}${step.toPath ? ` as ${step.toPath}` : ""}`;
  return `run on ${step.on}: ${step.command}`;
}

interface RunOutcome {
  machine: string;
  cwd: string;
  command: string;
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  seconds: number;
  stdout: string;
  stderr: string;
  problem?: string;
  synced?: string;
}

async function doRun(
  session: Session,
  on: string,
  command: string,
  opts: { dir?: string; timeoutMinutes?: number; sync?: boolean },
): Promise<RunOutcome> {
  if (typeof command !== "string" || !command.trim()) throw new ChannelError("A command is needed.");
  const machine = await session.machine(on);
  const checkout = await session.checkout(machine, on);
  let synced: string | undefined;
  if (opts.sync && machine.id !== session.origin.id) synced = describeSync(await doSync(session, "here", on, false));
  const cwd = opts.dir ? joinPath(checkout.top, safeRelativePath(opts.dir)) : checkout.top;
  const minutes = Math.min(RUN_CEILING_MS / 60_000, Math.max(0.1, opts.timeoutMinutes ?? 10));
  const result = await shOn(machine, cwd, command, [], { timeoutMs: Math.round(minutes * 60_000), keepBytes: 64 * 1024 });
  const problem = runFailure(result);
  return {
    machine: machine.name,
    cwd,
    command,
    ok: !problem,
    code: result.code,
    timedOut: result.timedOut,
    seconds: Math.round(result.durationMs / 100) / 10,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
    ...(problem ? { problem } : {}),
    ...(synced ? { synced } : {}),
  };
}

interface SyncOutcome {
  from: string;
  to: string;
  branch: string;
  head: string;
  alreadyInSync: boolean;
  changedFiles: number;
  sent: string;
  carried: string[];
}

async function doSync(session: Session, fromRef: string, toRef: string, overwrite: boolean): Promise<SyncOutcome> {
  const from = await session.machine(fromRef);
  const to = await session.machine(toRef);
  if (from.id === to.id) throw new ChannelError(`${from.name} and ${to.name} are the same machine: there is nothing to sync.`);
  const source = await session.checkout(from, fromRef);
  const dest = await session.checkout(to, toRef);
  const result = await syncCheckout(source, dest, { overwrite });
  // Ignored files the recipe asks for (a .env the build reads). One that is
  // not there on the source is simply not carried.
  const carried: string[] = [];
  for (const path of session.recipe.carry) {
    try {
      await copyPath(source, dest, path);
      carried.push(path);
    } catch (error) {
      if (!/does not exist/.test(String((error as { message?: string })?.message))) throw error;
    }
  }
  return {
    from: from.name,
    to: to.name,
    branch: result.branch || "(detached)",
    head: result.head.slice(0, 12),
    alreadyInSync: result.alreadyInSync,
    changedFiles: result.changedFiles,
    sent: formatBytes(result.bytes),
    carried,
  };
}

function describeSync(s: SyncOutcome): string {
  return s.alreadyInSync
    ? `${s.to} already matched ${s.from} (${s.branch} at ${s.head})`
    : `${s.to} now matches ${s.from}: ${s.branch} at ${s.head}, ${s.changedFiles} file${s.changedFiles === 1 ? "" : "s"} changed, ${s.sent} sent`;
}

async function doCopy(session: Session, fromRef: string, toRef: string, path: string, toPath?: string) {
  const from = await session.machine(fromRef);
  const to = await session.machine(toRef);
  const source = await session.checkout(from, fromRef);
  const dest = await session.checkout(to, toRef);
  if (from.id === to.id && source.top === dest.top && safeRelativePath(path) === safeRelativePath(toPath ?? path)) {
    throw new ChannelError("That is the same file on the same machine.");
  }
  const result = await copyPath(source, dest, path, toPath);
  return { from: from.name, to: to.name, kind: result.kind, size: formatBytes(result.bytes), path: result.path };
}

async function workflow(session: Session, name: string): Promise<unknown> {
  const names = Object.keys(session.recipe.workflows);
  const flow = session.recipe.workflows[name];
  if (!flow) {
    throw new ChannelError(
      names.length
        ? `No workflow called "${name}" in ${RECIPE_PATH}. There ${names.length === 1 ? "is" : "are"}: ${names.join(", ")}.`
        : `This repository has no workflows yet. Add ${RECIPE_PATH}, for example:\n${RECIPE_EXAMPLE}`,
    );
  }
  // Every machine is resolved (and allowed) before the first step runs, so a
  // workflow never stops half way over a typo or a "no".
  for (const ref of workflowMachines(flow)) await session.machine(ref);
  const steps: Record<string, unknown>[] = [];
  for (const [i, step] of flow.steps.entries()) {
    const label = describeStep(step);
    session.ctx.onProgress?.(`${name} ${i + 1}/${flow.steps.length}: ${label}`);
    try {
      if (step.kind === "sync") {
        steps.push({ step: label, ok: true, result: describeSync(await doSync(session, step.from, step.to, step.overwrite)) });
      } else if (step.kind === "copy") {
        const copied = await doCopy(session, step.from, step.to, step.path, step.toPath);
        steps.push({ step: label, ok: true, result: `${copied.size} → ${copied.path} on ${copied.to}` });
      } else {
        const run = await doRun(session, step.on, step.command, { dir: step.dir, timeoutMinutes: step.timeoutMinutes });
        // A step that worked needs only its last lines; one that failed, all of them.
        steps.push({
          step: label,
          ok: run.ok,
          seconds: run.seconds,
          ...(run.ok ? { output: tail(run.stdout || run.stderr, 2000) } : { problem: run.problem, stdout: run.stdout, stderr: run.stderr }),
        });
        if (!run.ok) return { workflow: name, ok: false, failedStep: i + 1, steps, note: `Stopped at step ${i + 1} of ${flow.steps.length}; the later steps did not run.` };
      }
    } catch (error) {
      const failure = error instanceof ChannelError ? error : new ChannelError(String((error as { message?: string })?.message ?? error));
      steps.push({ step: label, ok: false, problem: failure.message, ...(failure.detail ? { detail: failure.detail } : {}) });
      return { workflow: name, ok: false, failedStep: i + 1, steps, note: `Stopped at step ${i + 1} of ${flow.steps.length}; the later steps did not run.` };
    }
  }
  return { workflow: name, ok: true, steps };
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Carry out one machine op. A `ChannelError` is something to tell the agent;
 *  its `detail` is appended so the evidence travels with the message. */
export async function runMachineOp(kind: string, args: Record<string, unknown>, ctx: MachineOpContext): Promise<unknown> {
  try {
    switch (kind) {
      case "list":
        return await list(ctx);
      case "run": {
        const session = await openSession(ctx, args.machines);
        return await doRun(session, text(args.machine) || "here", text(args.command), {
          dir: text(args.dir) || undefined,
          timeoutMinutes: typeof args.timeoutMinutes === "number" ? args.timeoutMinutes : undefined,
          sync: args.sync !== false,
        });
      }
      case "sync": {
        const session = await openSession(ctx, args.machines);
        if (!text(args.to)) throw new ChannelError("Name the machine to sync to.");
        const done = await doSync(session, text(args.from) || "here", text(args.to), args.overwrite === true);
        return { ...done, summary: describeSync(done) };
      }
      case "copy": {
        const session = await openSession(ctx, args.machines);
        if (!text(args.from) || !text(args.to)) throw new ChannelError("Name the machine to copy from and the machine to copy to.");
        return await doCopy(session, text(args.from), text(args.to), text(args.path), text(args.toPath) || undefined);
      }
      case "workflow": {
        const session = await openSession(ctx, args.machines);
        return await workflow(session, text(args.name));
      }
      default:
        throw new ChannelError(`Unknown machine op: ${kind}`);
    }
  } catch (error) {
    if (error instanceof ChannelError && error.detail) throw new Error(`${error.message}\n\n${error.detail}`);
    throw error;
  }
}
