import type { StructuredDialect } from "./structuredEvents";

export type StructuredRunnerAuthority = "read-only" | "workspace-write";

/** Launch policy belongs to the caller, not to a global Companion setting. */
export interface StructuredRunnerPolicy {
  systemPromptAppend: string;
  permissionMode: string;
  /** Exact tools an owned non-interactive task may use without waiting for a
   * permission prompt nobody can answer. */
  allowedTools?: readonly string[];
  disallowedTools: readonly string[];
  model: string;
  sessionId: string;
  cwd?: string;
  authority: StructuredRunnerAuthority;
  /** Whether a workspace-write Codex sandbox may reach the network. Ignored
   *  for read-only authority and by dialects without an OS sandbox flag. */
  network?: boolean;
  /** Every directory the workspace-write sandbox may change in addition to
   *  its cwd. Ignored for read-only authority. */
  writableRoots?: readonly string[];
}

export interface StructuredRunnerLaunch {
  bin: string;
  policy: StructuredRunnerPolicy;
  additionalDirectories?: readonly string[];
  env?: [string, string][];
}

export interface StructuredRunner {
  /** How a turn reaches the CLI, which is a real difference in the CLIs and not
   *  a quality ranking:
   *
   *  `structured` — the process outlives the turn and the next message is
   *    written to its stdin (`claude -p --input-format stream-json`).
   *
   *  `oneshot` — the process IS the turn (`codex exec`). A follow-up means a
   *    new process resuming the conversation by id. Both tiers stream the same
   *    events off stdout; only the lifecycle differs.
   *
   *  Read by companion.ts to pick a transport, and by projectRunner.ts to
   *  decide whether `send` writes a line or launches a process. */
  tier: "structured" | "oneshot";
  /** Which JSON schema this CLI's stdout is written in. Not implied by the
   *  tier: two CLIs could share a lifecycle and agree on nothing else. */
  dialect: StructuredDialect;
  args(o: StructuredRunnerLaunch): string[];
  resumeArgs(o: StructuredRunnerLaunch): string[];
}

export function permissionArgs(
  policy: Pick<StructuredRunnerPolicy, "permissionMode" | "allowedTools" | "disallowedTools">,
): string[] {
  return [
    ...(policy.permissionMode
      ? ["--permission-mode", policy.permissionMode]
      : []),
    ...(policy.allowedTools?.length
      ? ["--allowedTools", ...policy.allowedTools]
      : []),
    ...(policy.disallowedTools.length
      ? ["--disallowedTools", ...policy.disallowedTools]
      : []),
  ];
}

const codexMode = (authority: StructuredRunnerAuthority): string =>
  authority === "workspace-write" ? "workspace-write" : "read-only";

/** Authority for `codex exec`, where it is a first-class flag.
 *
 *  `-s/--sandbox <read-only|workspace-write|danger-full-access>`, verified
 *  against `codex exec --help` (0.146.1). Never the third value, and never
 *  `--dangerously-bypass-approvals-and-sandbox`: a task Canopy launched
 *  unattended is the last thing that should be running outside the sandbox. */
type CodexSandboxPolicy = Pick<
  StructuredRunnerPolicy,
  "authority" | "network" | "writableRoots"
>;

const codexWorkspaceConfig = (
  policy: CodexSandboxPolicy,
  legacyWritableRoots: readonly string[] = [],
): string[] => {
  if (codexMode(policy.authority) !== "workspace-write") return [];
  // An explicit empty list is meaningful: callers using the workspace grant
  // have named the whole box. additionalDirectories remains a fallback for
  // older callers until all launch sites carry writableRoots in policy.
  const writableRoots = policy.writableRoots ?? legacyWritableRoots;
  return [
    ...(policy.network !== undefined
      ? [
          "-c",
          `sandbox_workspace_write.network_access=${String(policy.network)}`,
        ]
      : []),
    ...(writableRoots.length
      ? [
          "-c",
          `sandbox_workspace_write.writable_roots=${JSON.stringify([...writableRoots])}`,
        ]
      : []),
  ];
};

export function codexSandbox(authority: StructuredRunnerAuthority): string[];
export function codexSandbox(
  policy: CodexSandboxPolicy,
  legacyWritableRoots?: readonly string[],
): string[];
export function codexSandbox(
  policyOrAuthority: CodexSandboxPolicy | StructuredRunnerAuthority,
  legacyWritableRoots: readonly string[] = [],
): string[] {
  const policy = typeof policyOrAuthority === "string"
    ? { authority: policyOrAuthority }
    : policyOrAuthority;
  return [
    "-s",
    codexMode(policy.authority),
    ...codexWorkspaceConfig(policy, legacyWritableRoots),
  ];
}

/** The same authority for `codex exec resume`, which does NOT take `-s`.
 *
 *  This is not a stylistic choice — `codex exec resume` is a different clap
 *  command with a much smaller flag set, and it has no `-s`, no `-C/--cd` and
 *  no `--add-dir`. Passing `-s` there is a hard launch failure:
 *
 *      error: unexpected argument '-s' found
 *
 *  which arrives on stderr with no JSON on stdout at all, so the turn presents
 *  as the agent dying rather than as Canopy building the wrong argv. What it
 *  does take is `-c key=value`, and the two config keys below were confirmed to
 *  exist by probing with `--strict-config` (which rejects unknown keys — an
 *  invented key was refused, these two were accepted).
 *
 *  `--strict-config` is deliberately NOT passed at launch: it would also reject
 *  unrecognised fields in the user's own ~/.codex/config.toml, which Canopy
 *  does not control and must not fail on. It is a probe, not a runtime flag. */
export function codexResumeSandbox(
  authority: StructuredRunnerAuthority,
  writableRoots?: readonly string[],
): string[];
export function codexResumeSandbox(
  policy: CodexSandboxPolicy,
  legacyWritableRoots?: readonly string[],
): string[];
export function codexResumeSandbox(
  policyOrAuthority: CodexSandboxPolicy | StructuredRunnerAuthority,
  legacyWritableRoots: readonly string[] = [],
): string[] {
  const policy = typeof policyOrAuthority === "string"
    ? { authority: policyOrAuthority, writableRoots: legacyWritableRoots }
    : policyOrAuthority;
  const mode = codexMode(policy.authority);
  return [
    "-c",
    `sandbox_mode="${mode}"`,
    ...codexWorkspaceConfig(policy, legacyWritableRoots),
  ];
}

/** Claude has no OS sandbox argv equivalent. Its filesystem containment is
 *  enforced before tools run by canopy_hook.rs's proven PreToolUse
 *  `permissionDecision: "deny"` response; permissionArgs describes which
 *  tools may be attempted, but it is not the containment boundary. */
const CLAUDE_RUNNER: StructuredRunner = {
  tier: "structured",
  dialect: "claude",
  args: (o) => [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    // Required by Claude whenever print mode emits stream-json.
    "--verbose",
    "--session-id",
    o.policy.sessionId,
    "--append-system-prompt",
    o.policy.systemPromptAppend,
    ...(o.additionalDirectories ?? []).flatMap((dir) => ["--add-dir", dir]),
    ...(o.policy.model ? ["--model", o.policy.model] : []),
    ...permissionArgs(o.policy),
  ],
  resumeArgs: (o) => [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--resume",
    o.policy.sessionId,
    "--append-system-prompt",
    o.policy.systemPromptAppend,
    ...(o.additionalDirectories ?? []).flatMap((dir) => ["--add-dir", dir]),
    ...(o.policy.model ? ["--model", o.policy.model] : []),
    ...permissionArgs(o.policy),
  ],
};

/** `codex exec`, verified against codex-cli 0.146.1.
 *
 *  No permission flags, and not for want of looking: Claude's `--allowedTools`
 *  has no counterpart here. Codex draws the line with the sandbox instead of a
 *  tool allowlist — inside `-s read-only` or `-s workspace-write` it simply
 *  does not stop to ask, so a non-interactive run never blocks on an approval
 *  nobody is there to answer. `disallowedTools` therefore cannot be enforced on
 *  the argv the way it is for Claude; on this CLI the sandbox is the whole of
 *  the enforcement, and it is enforced by the OS rather than by the model
 *  agreeing to it.
 *
 *  The prompt is NOT here: it is a positional argument appended per turn by the
 *  transport, because on this CLI the prompt is part of launching rather than
 *  something written to a running process. */
const CODEX_RUNNER: StructuredRunner = {
  tier: "oneshot",
  dialect: "codex",
  args: (o) => [
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...(o.policy.cwd ? ["-C", o.policy.cwd] : []),
    ...(o.additionalDirectories ?? []).flatMap((dir) => ["--add-dir", dir]),
    ...(o.policy.model ? ["-m", o.policy.model] : []),
    ...codexSandbox(o.policy, o.additionalDirectories ?? []),
  ],
  // `resume` takes the thread id positionally and accepts almost none of the
  // flags above — see codexResumeSandbox. `-C` and `--add-dir` have no config
  // equivalent that has been verified, so the working root here is the one the
  // process is spawned in (policy.cwd is passed to the spawn either way) and
  // the resumed session already carries the roots it was started with.
  resumeArgs: (o) => [
    "exec",
    "resume",
    o.policy.sessionId,
    "--json",
    "--skip-git-repo-check",
    ...(o.policy.model ? ["-m", o.policy.model] : []),
    ...codexResumeSandbox(o.policy, o.additionalDirectories ?? []),
  ],
};

/** Verified non-interactive argv shapes, keyed by the agent registry id. */
export const STRUCTURED_RUNNERS: Record<string, StructuredRunner> = {
  claude: CLAUDE_RUNNER,
  codex: CODEX_RUNNER,
};

/** Whether this CLI can run a task that is read back off a JSON stream.
 *
 *  The question every caller actually has, asked of the capability rather than
 *  of the name. Canopy's registry holds seven CLIs and the person may have
 *  connected any of them; which ones can stream is a property of the runner
 *  written for each, not a preference, and it changes as runners are added.
 *  Callers that named `claude` directly were not choosing Claude — they were
 *  spelling "the one I know streams", and they broke the day a route resolved
 *  to anything else: `startStructured` throws before a process exists, and the
 *  task reports the agent failing rather than the launch being impossible.
 *
 *  Membership, not tier. It used to require `tier === "structured"`, which
 *  excluded codex — but the tier is the process LIFECYCLE, not whether events
 *  can be read, and conflating the two is what made the user's chosen default
 *  agent unable to run Build at all. A one-shot CLI streams the same events off
 *  the same stdout; the project runner now owns the difference (it launches a
 *  process per turn instead of writing a line), so having a verified runner at
 *  all is the honest test. This stays the gate for the CLIs that have no runner
 *  written for them, which is still most of the registry — an entry here is a
 *  claim that the argv and the event schema were checked against the real
 *  binary, and nothing else may be routed to Build. */
export const streamsStructured = (cliId: string): boolean =>
  Boolean(STRUCTURED_RUNNERS[cliId]);
