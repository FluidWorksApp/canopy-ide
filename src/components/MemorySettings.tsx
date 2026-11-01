// Settings → Agents → Team memory. Three choices a person should be able to
// make without reading the design: whether the brain suggests memories at
// all, how long a memory is trusted before it must be reconfirmed, and what
// happens to suggestions from a session that read the outside world.
import type { Settings } from "../settings";
import { Checkbox, Radio, Stepper } from "./ui";
import "./memoryPanel.css";

export function MemorySettings({
  s,
  patch,
}: {
  s: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  return (
    <div className="memory-settings">
      <Checkbox
        checked={s.memoryAutoExtract}
        onChange={(v) => patch({ memoryAutoExtract: v })}
        label="Suggest team memory after agents work"
        hint={
          s.memoryAutoExtract
            ? "Suggestions wait for your approval."
            : "Agents can still propose entries."
        }
      />
      <div className="memory-settings-row">
        <span>Facts are trusted for</span>
        <Stepper
          aria-label="Days a fact is trusted"
          value={s.memoryFactExpiryDays}
          min={7}
          max={730}
          step={15}
          suffix="days"
          onChange={(v) => patch({ memoryFactExpiryDays: v })}
        />
      </div>
      <div className="memory-settings-row">
        <span>Decisions, constraints and conventions for</span>
        <Stepper
          aria-label="Days a decision is trusted"
          value={s.memoryDecisionExpiryDays}
          min={7}
          max={1095}
          step={30}
          suffix="days"
          onChange={(v) => patch({ memoryDecisionExpiryDays: v })}
        />
      </div>
      <Checkbox
        checked={s.memoryInstructionAutoUpdate !== false}
        onChange={(v) => patch({ memoryInstructionAutoUpdate: v })}
        label="Keep the instruction file's Team memory section up to date"
        hint={
          s.memoryInstructionAutoUpdate === false
            ? "Changes only when you update it from the Memory panel."
            : Object.keys(s.memoryInstructionFiles).length
              ? "Rewrites only the Team memory section."
              : "Starts after you first update it from the Memory panel."
        }
      />
      <Radio
        name="memory-quarantine"
        checked={s.memoryQuarantine === "quarantine"}
        onChange={() => patch({ memoryQuarantine: "quarantine" })}
        label="Quarantine suggestions from sessions that read web pages, tickets or PR comments"
        hint="Need “Approve anyway”."
      />
      <Radio
        name="memory-quarantine"
        checked={s.memoryQuarantine === "skip"}
        onChange={() => patch({ memoryQuarantine: "skip" })}
        label="Don't learn from those sessions at all"
        hint="Safest."
      />
    </div>
  );
}
