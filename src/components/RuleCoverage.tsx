// One line per agent CLI: whether the Rules panel's gates stop it, and how
// (src/gates/coverage.ts).
import { ruleCoverage } from "../gates/coverage";

export function RuleCoverage() {
  const rows = ruleCoverage();
  return (
    <details className="gates-coverage">
      <summary>
        Enforced in {rows.filter((r) => r.enforced).length} of {rows.length} agent CLIs, on this computer and in cloud
        workspaces. Egress and shell-path checks are best effort — they read the command line and the scripts it runs,
        not everything a program might do.
      </summary>
      <ul className="gates-coverage-list">
        {rows.map((r) => (
          <li key={r.id}>
            <strong>{r.name}</strong> — {r.enforced ? "enforced" : "guidance only"}. {r.how}
          </li>
        ))}
      </ul>
    </details>
  );
}
