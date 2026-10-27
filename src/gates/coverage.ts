// Which agent CLIs the Rules panel's gates actually stop, read from the
// harness ledger (src/harness.ts RULE_ENFORCEMENT) so the panel can never
// promise more than the hook contracts behind it.
import { harnessCapabilities } from "../harness";
import { BUILTIN_AGENT_CLIS } from "../projects";

export interface CoverageRow {
  id: string;
  name: string;
  enforced: boolean;
  how: string;
}

export function ruleCoverage(): CoverageRow[] {
  return BUILTIN_AGENT_CLIS.flatMap((cli) => {
    const cap = harnessCapabilities(cli.id).ruleEnforcement;
    if (cap.support === "unknown") return [];
    return [{ id: cli.id, name: cli.name, enforced: cap.support === "native" || cap.support === "partial", how: cap.note ?? "" }];
  });
}
