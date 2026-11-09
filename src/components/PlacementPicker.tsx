import {
  automaticPreference,
  inheritPreference,
  preferenceKey,
  targetKey,
  targetPreference,
  type DisplayTarget,
  type PlacementDecision,
  type Preference,
  type Target,
} from "../placement/types";

export const targetName = (target: Target | null, names: Record<string, string> = {}) =>
  !target
    ? "nowhere"
    : target.kind === "local"
      ? "This Mac"
      : names[targetKey(target)] ?? names[target.kind === "remote" ? target.workspaceId : target.machineId] ?? "the selected machine";

const fallbackTargets: DisplayTarget[] = [
  { target: { kind: "local" }, name: "This Mac", online: true },
];

export function PlacementPicker({
  label = "Run on",
  value,
  onChange,
  decision,
  names,
  targets = fallbackTargets,
  allowInherit = false,
}: {
  label?: string;
  value: Preference;
  onChange: (preference: Preference) => void;
  /** What launching would do now; shown for every choice. */
  decision?: PlacementDecision;
  names?: Record<string, string>;
  targets?: DisplayTarget[];
  /** Project and agent overrides can inherit. Global placement cannot. */
  allowInherit?: boolean;
}) {
  const listed = targets.some((item) => item.target.kind === "local")
    ? targets
    : [...fallbackTargets, ...targets];
  const concrete = value.mode === "target" && !listed.some((item) => targetKey(item.target) === targetKey(value.target))
    ? [...listed, {
        target: value.target,
        name: `Unavailable machine (${value.target.kind === "remote" ? value.target.workspaceId : value.target.kind === "t3" ? value.target.machineId : "This Mac"})`,
        online: false,
      }]
    : listed;
  const selected = preferenceKey(value);
  const change = (key: string) => {
    if (key === "inherit") onChange(inheritPreference());
    else if (key === "automatic") onChange(automaticPreference());
    else {
      const match = concrete.find((item) => targetKey(item.target) === key);
      if (match) onChange(targetPreference(match.target));
    }
  };
  const displayNames = { ...names };
  for (const item of concrete) displayNames[targetKey(item.target)] = item.name;

  return (
    <label className="field placement-picker">
      <span>{label}</span>
      <select value={selected} onChange={(event) => change(event.target.value)} aria-label={label}>
        {allowInherit && <option value="inherit">Use default</option>}
        <option value="automatic">Automatic</option>
        {concrete.map((item) => (
          <option key={targetKey(item.target)} value={targetKey(item.target)}>
            {item.name}
          </option>
        ))}
      </select>
      {decision && (
        <small className="placement-decision" role="status">
          {decision.target ? `Would run on ${decision.targetName ?? targetName(decision.target, displayNames)}. ` : ""}
          {decision.reason}
          {decision.needsSetup ? " The project needs setting up there first." : ""}
        </small>
      )}
    </label>
  );
}
