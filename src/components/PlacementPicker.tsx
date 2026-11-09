// "Run on" control: Local / Remote / Balance / Auto. Auto shows what the
// balancer would pick right now and why, so the default is never a mystery.
import type { PlacementDecision, Preference, Target } from "../placement/types";

const OPTIONS: { value: Preference; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "local", label: "Local" },
  { value: "remote", label: "Remote" },
  { value: "balance", label: "Balance" },
];

export const targetName = (t: Target | null, names: Record<string, string> = {}) =>
  !t ? "nowhere" : t.kind === "local" ? "This Mac" : names[t.kind === "remote" ? t.workspaceId : t.machineId] ?? (t.kind === "remote" ? "a remote workspace" : "a T3 machine");

export function PlacementPicker({
  label = "Run on",
  value,
  onChange,
  decision,
  names,
}: {
  label?: string;
  value: Preference;
  onChange: (p: Preference) => void;
  /** What launching would do now; shown for every choice, not only Auto. */
  decision?: PlacementDecision;
  names?: Record<string, string>;
}) {
  return (
    <label className="field placement-picker">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as Preference)} aria-label={label}>
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {decision && (
        <small className="placement-decision" role="status">
          {decision.target ? `Would run on ${targetName(decision.target, names)}. ` : ""}
          {decision.reason}
          {decision.needsSetup ? " The project needs setting up there first." : ""}
        </small>
      )}
    </label>
  );
}
