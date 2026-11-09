import type {
  StructuredRunner,
  StructuredRunnerAuthority,
} from "../structuredRunners";

/** Everything Canopy needs to launch one ACP agent. Data, not code: a new
 *  provider is a new row, never a new branch. */
export interface AcpProviderSpec {
  id: string;
  name: string;
  command: string;
  /** The subcommand or flags that put the CLI in ACP mode (`acp`,
   *  `--experimental-acp`, ...). */
  args: readonly string[];
  env?: readonly (readonly [string, string])[];
  /** Where the person signs in when `initialize` reports authMethods. */
  authHint?: string;
  /** Flags, when the CLI has them. Absent = Canopy cannot choose that. */
  modelArg?: string;
  agentArg?: string;
  /** Value for `agentArg`, e.g. the agent profile that carries Canopy's hooks. */
  agentProfile?: string;
  /** Passed ONLY for workspace-write authority; the agent then never asks. */
  trustAllArg?: string;
  /** ACP session mode ids to select per authority, when the agent offers them. */
  defaultMode?: Partial<Record<StructuredRunnerAuthority, string>>;
  verification: StructuredRunner["verification"];
}

export function buildAcpRunner(spec: AcpProviderSpec): StructuredRunner {
  const argv: StructuredRunner["args"] = (o) => [
    ...spec.args,
    ...(spec.agentArg && spec.agentProfile ? [spec.agentArg, spec.agentProfile] : []),
    ...(spec.modelArg && o.policy.model ? [spec.modelArg, o.policy.model] : []),
    ...(spec.trustAllArg && o.policy.authority === "workspace-write" ? [spec.trustAllArg] : []),
  ];
  return {
    tier: "acp",
    dialect: "acp",
    verification: spec.verification,
    acp: spec,
    sessionEnv: spec.env,
    args: argv,
    // Resuming is a protocol step (session/load), not a different argv.
    resumeArgs: argv,
  };
}

/** What a user-added ACP entry stores: argv pieces, never a shell string, so
 *  nothing here is ever re-parsed by a shell. */
export interface CustomAcpConfig {
  args: string[];
  env?: Record<string, string>;
}

const MAX_ARGS = 64;
const MAX_ARG_LEN = 1024;
const MAX_ENV = 32;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Env names that change what a launched program loads or which program is
 *  found, so a settings or registry entry must never set them. */
const DENIED_ENV_EXACT = new Set([
  "PATH", "PATHEXT", "HOME", "SHELL", "IFS", "ENV", "BASH_ENV", "PROMPT_COMMAND",
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "PYTHONPATH", "PYTHONSTARTUP",
  "PYTHONHOME", "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "SSL_CERT_FILE",
  "SSL_CERT_DIR", "CURL_CA_BUNDLE", "COMSPEC",
]);
const DENIED_ENV_PREFIX = ["LD_", "DYLD_"];

export function isDeniedEnvName(name: string): boolean {
  const n = name.toUpperCase();
  return DENIED_ENV_EXACT.has(n) || DENIED_ENV_PREFIX.some((p) => n.startsWith(p));
}

/** Executables that turn an "agent" entry into a generic shell. */
const SHELL_COMMANDS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "cmd", "cmd.exe",
  "powershell", "powershell.exe", "pwsh", "pwsh.exe", "env", "sudo", "su", "eval", "xargs",
]);

export function isShellCommand(command: string): boolean {
  const base = command.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return SHELL_COMMANDS.has(base);
}

/** Coerce stored/imported JSON into a CustomAcpConfig, or undefined when it is
 *  not one. Lenient on junk (dropped, not thrown) because it runs on every
 *  settings read; strict on shape so a corrupt entry degrades to a plain CLI. */
export function sanitizeAcpConfig(raw: unknown): CustomAcpConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as { args?: unknown; env?: unknown };
  if (!Array.isArray(r.args)) return undefined;
  const args = r.args
    .filter((a): a is string => typeof a === "string" && a.length <= MAX_ARG_LEN && !a.includes("\0"))
    .slice(0, MAX_ARGS);
  const out: CustomAcpConfig = { args };
  if (r.env && typeof r.env === "object" && !Array.isArray(r.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>).slice(0, MAX_ENV)) {
      if (ENV_NAME.test(k) && !isDeniedEnvName(k) && typeof v === "string" && v.length <= MAX_ARG_LEN && !v.includes("\0"))
        env[k] = v;
    }
    if (Object.keys(env).length) out.env = env;
  }
  return out;
}

/** Split `--acp --flag "two words"` into argv for the settings text field.
 *  Quotes group; there is no escaping, expansion or substitution. */
export function splitArgv(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** The inverse, for showing stored argv back in the field. */
export function joinArgv(args: readonly string[]): string {
  return args.map((a) => (a === "" || /[\s"']/.test(a) ? `"${a.replaceAll('"', "'")}"` : a)).join(" ");
}

/** A user-configured entry has no dated verification: say so, so nothing
 *  downstream mistakes it for a tested capability. */
export const USER_ACP_VERIFICATION: StructuredRunner["verification"] = {
  cliVersion: "unknown",
  checkedOn: "unverified",
  source: "user-configured ACP entry",
  flags: {
    structuredJson: true,
    systemPrompt: false,
    planMode: false,
    toolAllowlist: false,
    workspaceSandbox: false,
  },
  caveats: [
    "Configured by the user; Canopy has not verified this CLI's ACP support.",
    "ACP has no system-prompt field; Canopy prepends the brief to the first turn.",
  ],
};

/** The runner for a custom CLI that speaks ACP. */
export function customAcpRunner(
  id: string,
  name: string,
  bin: string,
  config: CustomAcpConfig,
): StructuredRunner {
  return buildAcpRunner({
    id,
    name,
    command: bin,
    args: config.args,
    env: config.env ? Object.entries(config.env) : undefined,
    verification: USER_ACP_VERIFICATION,
  });
}

/** One-click "Add ACP provider" presets. Data only. Every flag was read from
 *  the ACP registry JSON (cdn.agentclientprotocol.com/registry/v1/latest) on
 *  the stamped date; a row is added only with a source for its argv. */
export interface AcpPreset {
  id: string;
  name: string;
  /** Executable expected on PATH. */
  bin: string;
  args: readonly string[];
  /** Where the person installs it. */
  install: string;
  verifiedOn: string;
  source: string;
}

export const ACP_PRESETS: readonly AcpPreset[] = [
  {
    id: "gemini",
    name: "Gemini CLI",
    bin: "gemini",
    args: ["--acp"],
    install: "npm install -g @google/gemini-cli",
    verifiedOn: "2026-11-09",
    source: "ACP registry entry `gemini` 0.67.0 (npx @google/gemini-cli, args --acp)",
  },
  {
    id: "goose",
    name: "Goose",
    bin: "goose",
    args: ["acp"],
    install: "https://github.com/block/goose/releases",
    verifiedOn: "2026-11-09",
    source: "ACP registry entry `goose` 1.57.0 (binary goose, args acp)",
  },
];
