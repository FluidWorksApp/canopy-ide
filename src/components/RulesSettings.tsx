// Settings → Rules: every project's rules in one place. The rules themselves
// belong to a project (they live in its repository's ledger, and the policy
// the hook reads is written per repository), so this lists them and opens
// each project's own Rules panel to change them.
import { useEffect, useState } from "react";
import { loadRules, ruleState, type RuleSet } from "../gates/rules";
import { RuleCoverage } from "./RuleCoverage";
import { Button } from "./ui";
import "./gates.css";

export interface RulesSettingsProject {
  id: string;
  name: string;
  /** Component paths; the first is where its Rules panel opens. */
  roots: string[];
}

const STATE_LABEL: Record<ReturnType<typeof ruleState>, string> = {
  enforced: "Enforced",
  "needs-approval": "Needs your approval",
  "needs-compile": "Not compiled",
  suggestion: "Suggestion only",
  guidance: "Guidance",
};

type Loaded = { set: RuleSet | null; error: string | null };

export function RulesSettings({
  projects,
  onOpen,
  load = loadRules,
}: {
  projects: readonly RulesSettingsProject[];
  onOpen: (projectId: string, cwd: string) => void;
  /** Tests inject the reader; the app reads the ledger. */
  load?: (cwd: string) => Promise<RuleSet>;
}) {
  const [byId, setById] = useState<Record<string, Loaded>>({});
  const key = projects.map((p) => `${p.id}:${p.roots[0] ?? ""}`).join("\n");
  useEffect(() => {
    let cancelled = false;
    for (const p of projects) {
      const cwd = p.roots[0];
      if (!cwd) continue;
      void load(cwd)
        .then((set) => !cancelled && setById((m) => ({ ...m, [p.id]: { set, error: null } })))
        .catch((e) => !cancelled && setById((m) => ({ ...m, [p.id]: { set: null, error: String(e) } })));
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className="rules-settings">
      <p className="set-item-desc">
        Rules belong to a project: write, approve and pause them in that project's Rules panel. The check on actions
        that can't be undone is always on, everywhere.
      </p>
      {projects.length === 0 && <p className="set-item-desc">No projects yet.</p>}
      <ul className="rules-settings-list">
        {projects.map((p) => {
          const loaded = byId[p.id];
          const rules = loaded?.set?.rules ?? [];
          const counts = rules.reduce<Record<string, number>>((m, r) => {
            const s = ruleState(r);
            m[s] = (m[s] ?? 0) + 1;
            return m;
          }, {});
          const cwd = p.roots[0] ?? "";
          return (
            <li key={p.id} className="rules-settings-project">
              <div className="rules-settings-head">
                <strong>{p.name}</strong>
                <span className="rules-settings-counts">
                  {!loaded
                    ? "Loading…"
                    : loaded.error
                      ? "Couldn't read its rules"
                      : rules.length === 0
                        ? "No rules yet"
                        : Object.entries(counts)
                            .map(([s, n]) => `${n} ${STATE_LABEL[s as keyof typeof STATE_LABEL].toLowerCase()}`)
                            .join(" · ")}
                  {loaded?.set?.trifecta === "block" ? " · web-content guard: block" : ""}
                </span>
                <Button size="sm" variant="ghost" disabled={!cwd} onClick={() => onOpen(p.id, cwd)}>
                  Open Rules panel
                </Button>
              </div>
              {rules.length > 0 && (
                <ul className="rules-settings-rules">
                  {rules.slice(0, 12).map((r) => (
                    <li key={r.id}>
                      <span className={`rules-settings-badge rules-settings-${ruleState(r)}`}>{STATE_LABEL[ruleState(r)]}</span>{" "}
                      {r.data.text}
                    </li>
                  ))}
                  {rules.length > 12 && <li className="set-item-desc">and {rules.length - 12} more</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <RuleCoverage />
    </div>
  );
}
