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
}

export interface StructuredRunnerLaunch {
  bin: string;
  policy: StructuredRunnerPolicy;
  additionalDirectories?: readonly string[];
  env?: [string, string][];
}

export interface StructuredRunner {
  tier: "structured" | "oneshot";
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

export function codexSandbox(authority: StructuredRunnerAuthority): string[] {
  const mode = authority === "workspace-write" ? "workspace-write" : "read-only";
  return ["-c", `sandbox_mode="${mode}"`];
}

const CLAUDE_RUNNER: StructuredRunner = {
  tier: "structured",
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

const CODEX_RUNNER: StructuredRunner = {
  tier: "oneshot",
  args: (o) => [
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...(o.policy.model ? ["-m", o.policy.model] : []),
    ...codexSandbox(o.policy.authority),
  ],
  resumeArgs: (o) => [
    "exec",
    "resume",
    o.policy.sessionId,
    "--json",
    "--skip-git-repo-check",
    ...(o.policy.model ? ["-m", o.policy.model] : []),
    ...codexSandbox(o.policy.authority),
  ],
};

/** Verified non-interactive argv shapes, keyed by the agent registry id. */
export const STRUCTURED_RUNNERS: Record<string, StructuredRunner> = {
  claude: CLAUDE_RUNNER,
  codex: CODEX_RUNNER,
};
