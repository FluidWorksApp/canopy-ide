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
  /** Passed ONLY for workspace-write authority; the agent then never asks. */
  trustAllArg?: string;
  /** ACP session mode ids to select per authority, when the agent offers them. */
  defaultMode?: Partial<Record<StructuredRunnerAuthority, string>>;
  verification: StructuredRunner["verification"];
}

export function buildAcpRunner(spec: AcpProviderSpec): StructuredRunner {
  const argv: StructuredRunner["args"] = (o) => [
    ...spec.args,
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
