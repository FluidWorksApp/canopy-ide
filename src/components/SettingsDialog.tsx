// The one settings surface, VS Code-style: section nav on the left; each
// setting stacks name → description → control (side-by-side rows squeezed
// long labels into slivers and pushed wide control groups out of the modal).
// Skins render as preview cards — a palette is a thing you look at, not a
// word you read.
import { useState } from "react";
import {
  applyTheme,
  getSettings,
  updateSettings,
  THEMES,
  type CursorStyle,
  type Settings,
  type Theme,
} from "../settings";
import { useEscape } from "../useEscape";

export type SettingsTab = "appearance" | "editor" | "terminal" | "guard";

interface SettingsDialogProps {
  onClose: () => void;
  initialTab?: SettingsTab;
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "terminal", label: "Terminal" },
  { id: "guard", label: "Process guard" },
];

const CURSOR_OPTIONS: { id: CursorStyle; label: string }[] = [
  { id: "block", label: "Block" },
  { id: "underline", label: "Underline" },
  { id: "bar", label: "Bar" },
];

/** Mirror of each skin's defining colors in index.css — the preview must
 *  show the palette without applying it. Custom previews the user's own
 *  accent on the Default base. */
const SKIN_PREVIEWS: Record<Theme, { bg: string; raised: string; text: string; accent?: string }> = {
  // Auto previews as a split card: Default when the OS is dark, Daylight when light.
  auto: {
    bg: "linear-gradient(105deg, #1a1b26 50%, #f5f6f8 50%)",
    raised: "#1f2335",
    text: "#f5f6f8",
    accent: "#7aa2f7",
  },
  default: { bg: "#1a1b26", raised: "#1f2335", text: "#c9d1d9", accent: "#7aa2f7" },
  gotham: { bg: "#0d0f12", raised: "#171b20", text: "#e8e6df", accent: "#d4af37" },
  daylight: { bg: "#f5f6f8", raised: "#ffffff", text: "#1c1f26", accent: "#3b6fd6" },
  custom: { bg: "#1a1b26", raised: "#1f2335", text: "#c9d1d9" },
};

function Item({
  name,
  desc,
  children,
}: {
  name: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="set-item">
      <div className="set-item-name">{name}</div>
      {desc && <div className="set-item-desc">{desc}</div>}
      <div className="set-item-control">{children}</div>
    </div>
  );
}

export function SettingsDialog({ onClose, initialTab = "appearance" }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [s, setS] = useState<Settings>(() => getSettings());
  useEscape(onClose, true);

  const patch = (p: Partial<Settings>) => setS(updateSettings(p));

  const pickTheme = (next: Theme) => {
    patch({ theme: next });
    applyTheme(next, s.customAccent);
  };

  const cursorControls = (
    styleKey: "editorCursorStyle" | "terminalCursorStyle",
    blinkKey: "editorCursorBlink" | "terminalCursorBlink",
  ) => (
    <div className="set-inline">
      <select
        value={s[styleKey]}
        onChange={(e) => patch({ [styleKey]: e.target.value as CursorStyle })}
      >
        {CURSOR_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <label className="set-inline-check">
        <input
          type="checkbox"
          checked={s[blinkKey]}
          onChange={(e) => patch({ [blinkKey]: e.target.checked })}
        />
        <span>Blink</span>
      </label>
    </div>
  );

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div className="confirm settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-layout">
          <nav className="settings-nav">
            <div className="settings-title">Settings</div>
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`settings-nav-item ${tab === t.id ? "settings-nav-active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {tab === "appearance" && (
              <>
                <Item name="Skin" desc="Colors for the whole app — applies immediately, terminals and editor included.">
                  <div className="skin-grid">
                    {THEMES.map((t) => {
                      const p = SKIN_PREVIEWS[t.id];
                      const accent = t.id === "custom" ? s.customAccent : p.accent;
                      return (
                        <button
                          key={t.id}
                          className={`skin-card ${s.theme === t.id ? "skin-card-active" : ""}`}
                          onClick={() => pickTheme(t.id)}
                        >
                          <span className="skin-preview" style={{ background: p.bg }}>
                            <span className="skin-chip" style={{ background: accent }} />
                            <span className="skin-chip" style={{ background: p.raised }} />
                            <span className="skin-chip" style={{ background: p.text }} />
                          </span>
                          <span className="skin-name">{t.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </Item>
                <Item
                  name="Accent color"
                  desc="Your own highlight color. Picking one switches to the Custom skin."
                >
                  <div className="set-inline">
                    <input
                      type="color"
                      value={s.customAccent}
                      onChange={(e) => {
                        patch({ customAccent: e.target.value, theme: "custom" });
                        applyTheme("custom", e.target.value);
                      }}
                    />
                    <code className="set-hexcode">{s.customAccent}</code>
                  </div>
                </Item>
              </>
            )}

            {tab === "editor" && (
              <>
                <Item name="Font family" desc="Applies to newly opened files.">
                  <input
                    className="set-wide"
                    value={s.editorFontFamily}
                    onChange={(e) => patch({ editorFontFamily: e.target.value })}
                  />
                </Item>
                <Item name="Font size">
                  <input
                    type="number"
                    min={8}
                    max={32}
                    value={s.editorFontSize}
                    onChange={(e) => patch({ editorFontSize: Number(e.target.value) || 13 })}
                  />
                </Item>
                <Item name="Cursor">{cursorControls("editorCursorStyle", "editorCursorBlink")}</Item>
              </>
            )}

            {tab === "terminal" && (
              <>
                <Item name="Font family" desc="Applies to newly opened terminals.">
                  <input
                    className="set-wide"
                    value={s.terminalFontFamily}
                    onChange={(e) => patch({ terminalFontFamily: e.target.value })}
                  />
                </Item>
                <Item name="Font size">
                  <input
                    type="number"
                    min={8}
                    max={32}
                    value={s.fontSize}
                    onChange={(e) => patch({ fontSize: Number(e.target.value) || 13 })}
                  />
                </Item>
                <Item name="Cursor">
                  {cursorControls("terminalCursorStyle", "terminalCursorBlink")}
                </Item>
                <Item
                  name="Scrollback"
                  desc="Lines of history each terminal keeps. Applies to newly opened terminals."
                >
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
                </Item>
              </>
            )}

            {tab === "guard" && (
              <>
                <Item
                  name="CPU warning threshold"
                  desc="Warn when a terminal's process tree exceeds this much CPU (%)."
                >
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
                </Item>
                <Item
                  name="Memory warning threshold"
                  desc="Warn when a terminal's process tree exceeds this much memory (GB)."
                >
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
                </Item>
              </>
            )}
          </div>
        </div>
        <div className="settings-footer">
          <button className="btn btn-accent" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
