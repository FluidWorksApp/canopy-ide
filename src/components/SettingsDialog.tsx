// The one settings surface. Every control writes through updateSettings and
// applies immediately where the runtime allows it (appearance, font size);
// the few that only affect new terminals say so instead of pretending.
import { useState } from "react";
import { getSettings, updateSettings, type Settings } from "../settings";
import { ACCENTS, applyAppearance } from "../themes";
import { useEscape } from "../useEscape";

interface SettingsDialogProps {
  onClose: () => void;
}

const THEMES: { id: Settings["theme"]; label: string; hint: string }[] = [
  { id: "system", label: "System", hint: "follow macOS day/night" },
  { id: "dark", label: "Dark", hint: "always night" },
  { id: "light", label: "Light", hint: "always day" },
];

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [s, setS] = useState<Settings>(getSettings());
  useEscape(onClose, true);

  const patch = (p: Partial<Settings>, appearance = false) => {
    const next = updateSettings(p);
    setS(next);
    if (appearance) applyAppearance();
  };

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div className="confirm settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="side-panel-head">
          <span>Settings</span>
        </div>

        <div className="set-section">
          <div className="set-head">Appearance</div>
          <div className="set-row">
            <span className="set-label">Theme</span>
            <div className="set-choices">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`btn ${s.theme === t.id ? "btn-accent" : ""}`}
                  title={t.hint}
                  onClick={() => patch({ theme: t.id }, true)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="set-row">
            <span className="set-label">Accent</span>
            <div className="set-choices">
              {Object.entries(ACCENTS).map(([name, color]) => (
                <button
                  key={name}
                  className={`accent-swatch ${s.accent === name ? "accent-swatch-active" : ""}`}
                  style={{ background: color }}
                  title={name}
                  onClick={() => patch({ accent: name }, true)}
                />
              ))}
            </div>
          </div>
          <div className="set-row">
            <span className="set-label">Terminal font size</span>
            <input
              type="number"
              min={9}
              max={22}
              value={s.fontSize}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 9 && v <= 22) patch({ fontSize: v }, true);
              }}
            />
          </div>
        </div>

        <div className="set-section">
          <div className="set-head">Terminal</div>
          <div className="set-row">
            <span className="set-label">
              Scrollback lines
              <small>applies to newly opened terminals</small>
            </span>
            <input
              type="number"
              min={1000}
              max={100000}
              step={1000}
              value={s.scrollback}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 1000) patch({ scrollback: v });
              }}
            />
          </div>
        </div>

        <div className="set-section">
          <div className="set-head">Runaway-process guard</div>
          <div className="set-row">
            <span className="set-label">
              CPU warning threshold
              <small>% across a terminal's process tree</small>
            </span>
            <input
              type="number"
              min={50}
              max={1600}
              step={50}
              value={s.runawayCpuPercent}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) patch({ runawayCpuPercent: v });
              }}
            />
          </div>
          <div className="set-row">
            <span className="set-label">
              Memory warning threshold
              <small>GB across a terminal's process tree</small>
            </span>
            <input
              type="number"
              min={1}
              max={64}
              value={Math.round(s.runawayMemBytes / 1024 ** 3)}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) patch({ runawayMemBytes: v * 1024 ** 3 });
              }}
            />
          </div>
        </div>

        <div className="confirm-actions">
          <button className="btn btn-accent" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
