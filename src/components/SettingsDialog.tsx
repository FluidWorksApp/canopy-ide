// The one settings surface, VS Code-style: section nav on the left, controls
// on the right. Appearance (skins, accent, wallpaper, fonts, cursors —
// everything that was the standalone Appearance panel) is a section here, not
// a second competing dialog.
import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  applyTheme,
  getSettings,
  updateSettings,
  THEMES,
  type CursorStyle,
  type Settings,
  type Theme,
} from "../settings";
import { setBackground, clearBackground, setBackgroundOpacity } from "../background";
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

export function SettingsDialog({ onClose, initialTab = "appearance" }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [s, setS] = useState<Settings>(() => getSettings());
  const [bgBusy, setBgBusy] = useState(false);
  useEscape(onClose, true);

  const patch = (p: Partial<Settings>) => setS(updateSettings(p));

  const pickTheme = (next: Theme) => {
    patch({ theme: next });
    applyTheme(next, s.customAccent);
  };

  const uploadBackground = async () => {
    const selection = await openDialog({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    const path = Array.isArray(selection) ? selection[0] : selection;
    if (!path) return;
    setBgBusy(true);
    try {
      await setBackground(path);
      setS(getSettings());
    } finally {
      setBgBusy(false);
    }
  };

  const cursorControls = (
    styleKey: "editorCursorStyle" | "terminalCursorStyle",
    blinkKey: "editorCursorBlink" | "terminalCursorBlink",
  ) => (
    <div className="set-choices">
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
        <span>blink</span>
      </label>
    </div>
  );

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div className="confirm settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="side-panel-head">
          <span>Settings</span>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav">
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
                <div className="set-head">Theme</div>
                <div className="set-row">
                  <span className="set-label">
                    Skin
                    <small>applies immediately, terminals included</small>
                  </span>
                  <div className="set-choices">
                    {THEMES.map((t) => (
                      <button
                        key={t.id}
                        className={`btn ${s.theme === t.id ? "btn-accent" : ""}`}
                        onClick={() => pickTheme(t.id)}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="set-row">
                  <span className="set-label">
                    Accent color
                    <small>picking one switches to the Custom skin</small>
                  </span>
                  <input
                    type="color"
                    value={s.customAccent}
                    onChange={(e) => {
                      patch({ customAccent: e.target.value, theme: "custom" });
                      applyTheme("custom", e.target.value);
                    }}
                  />
                </div>

                <div className="set-head">Background</div>
                <div className="set-row">
                  <span className="set-label">
                    Chrome wallpaper
                    <small>behind chrome, sidebar and terminal — never the editor</small>
                  </span>
                  <div className="set-choices">
                    <button
                      className="btn"
                      disabled={bgBusy}
                      onClick={() => void uploadBackground()}
                    >
                      {s.backgroundMime ? "Change…" : "Upload…"}
                    </button>
                    {s.backgroundMime && (
                      <button
                        className="btn"
                        onClick={async () => {
                          await clearBackground();
                          setS(getSettings());
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                {s.backgroundMime && (
                  <div className="set-row">
                    <span className="set-label">Wallpaper opacity</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={s.backgroundOpacity}
                      onChange={(e) => {
                        setBackgroundOpacity(Number(e.target.value));
                        setS(getSettings());
                      }}
                    />
                  </div>
                )}
              </>
            )}

            {tab === "editor" && (
              <>
                <div className="set-head">Font</div>
                <div className="set-row">
                  <span className="set-label">
                    Font family
                    <small>applies to newly opened files</small>
                  </span>
                  <input
                    className="set-wide"
                    value={s.editorFontFamily}
                    onChange={(e) => patch({ editorFontFamily: e.target.value })}
                  />
                </div>
                <div className="set-row">
                  <span className="set-label">Font size</span>
                  <input
                    type="number"
                    min={8}
                    max={32}
                    value={s.editorFontSize}
                    onChange={(e) => patch({ editorFontSize: Number(e.target.value) || 13 })}
                  />
                </div>
                <div className="set-head">Cursor</div>
                <div className="set-row">
                  <span className="set-label">Style</span>
                  {cursorControls("editorCursorStyle", "editorCursorBlink")}
                </div>
              </>
            )}

            {tab === "terminal" && (
              <>
                <div className="set-head">Font</div>
                <div className="set-row">
                  <span className="set-label">
                    Font family
                    <small>applies to newly opened terminals</small>
                  </span>
                  <input
                    className="set-wide"
                    value={s.terminalFontFamily}
                    onChange={(e) => patch({ terminalFontFamily: e.target.value })}
                  />
                </div>
                <div className="set-row">
                  <span className="set-label">Font size</span>
                  <input
                    type="number"
                    min={8}
                    max={32}
                    value={s.fontSize}
                    onChange={(e) => patch({ fontSize: Number(e.target.value) || 13 })}
                  />
                </div>
                <div className="set-head">Cursor</div>
                <div className="set-row">
                  <span className="set-label">Style</span>
                  {cursorControls("terminalCursorStyle", "terminalCursorBlink")}
                </div>
                <div className="set-head">Buffer</div>
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
              </>
            )}

            {tab === "guard" && (
              <>
                <div className="set-head">Runaway-process warnings</div>
                <div className="set-row">
                  <span className="set-label">
                    CPU threshold
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
                    Memory threshold
                    <small>GB across a terminal's process tree</small>
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={Math.round(s.runawayMemBytes / 1024 ** 3)}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v > 0)
                        patch({ runawayMemBytes: v * 1024 ** 3 });
                    }}
                  />
                </div>
              </>
            )}
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
