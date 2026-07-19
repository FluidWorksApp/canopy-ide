// One entry point for everything visual, in three labeled sections: Skin
// (the CSS-variable themes — index.css / settings.ts applyTheme()),
// Background (the chrome wallpaper — background.ts), and Font & Cursor
// (Editor/Terminal, independently). Deliberately one button/panel rather
// than scattering a theme picker, a background uploader, and a font control
// across the status bar as separate widgets.
//
// Font/cursor changes apply to newly opened terminals and editor tabs —
// there's no live-remount of what's already open, same as `fontSize` and
// `scrollback` have always behaved. A full ANSI-16-color terminal theme
// editor was in scope for consideration and was deliberately skipped: it's a
// big UI on its own (16 swatches × contrast-checking against both dark and
// light bases), and font/cursor/accent are what this panel is actually for.
import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  getSettings,
  updateSettings,
  applyTheme,
  THEMES,
  type CursorStyle,
  type Settings,
  type Theme,
} from "../settings";
import { setBackground, clearBackground, setBackgroundOpacity } from "../background";
import { useEscape } from "../useEscape";

interface AppearancePanelProps {
  onClose: () => void;
}

const CURSOR_OPTIONS: { id: CursorStyle; label: string }[] = [
  { id: "block", label: "Block" },
  { id: "underline", label: "Underline" },
  { id: "bar", label: "Bar" },
];

export function AppearancePanel({ onClose }: AppearancePanelProps) {
  const [settings, setSettings] = useState<Settings>(() => getSettings());
  const [bgBusy, setBgBusy] = useState(false);
  useEscape(onClose);

  const patch = (p: Partial<Settings>) => setSettings(updateSettings(p));

  const pickTheme = (next: Theme) => {
    patch({ theme: next });
    applyTheme(next, settings.customAccent);
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
      setSettings(getSettings());
    } finally {
      setBgBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Appearance</h3>

        {/* ---------- Skin ---------- */}
        <div className="personalize-section personalize-section-first">Skin</div>
        <label className="field">
          <span>Theme</span>
          <select value={settings.theme} onChange={(e) => pickTheme(e.target.value as Theme)}>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Accent color</span>
          <div className="personalize-accent-row">
            <input
              type="color"
              value={settings.customAccent}
              onChange={(e) => {
                patch({ customAccent: e.target.value, theme: "custom" });
                applyTheme("custom", e.target.value);
              }}
            />
            <small>Switches to the Custom skin and applies immediately.</small>
          </div>
        </label>

        {/* ---------- Background ---------- */}
        <div className="personalize-section">Background</div>
        <div className="field">
          <span>Chrome wallpaper</span>
          <div className="personalize-bg-row">
            <button className="btn-mini" disabled={bgBusy} onClick={() => void uploadBackground()}>
              {settings.backgroundMime ? "Change…" : "Upload…"}
            </button>
            {settings.backgroundMime && (
              <button
                className="btn-mini"
                onClick={async () => {
                  await clearBackground();
                  setSettings(getSettings());
                }}
              >
                Clear
              </button>
            )}
          </div>
          <small>Behind the chrome, welcome screen, terminal, and sidebar content. Never the code editor.</small>
        </div>
        {settings.backgroundMime && (
          <label className="field">
            <span>Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              value={settings.backgroundOpacity}
              onChange={(e) => {
                const v = Number(e.target.value);
                setBackgroundOpacity(v);
                setSettings(getSettings());
              }}
            />
          </label>
        )}

        {/* ---------- Font & Cursor ---------- */}
        <div className="personalize-section">Font & Cursor — Editor (Monaco)</div>
        <label className="field">
          <span>Font family</span>
          <input
            value={settings.editorFontFamily}
            onChange={(e) => patch({ editorFontFamily: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Font size</span>
          <input
            type="number"
            min={8}
            max={32}
            value={settings.editorFontSize}
            onChange={(e) => patch({ editorFontSize: Number(e.target.value) || 13 })}
          />
        </label>
        <label className="field">
          <span>Cursor</span>
          <div className="personalize-cursor-row">
            <select
              value={settings.editorCursorStyle}
              onChange={(e) => patch({ editorCursorStyle: e.target.value as CursorStyle })}
            >
              {CURSOR_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <label className="personalize-blink">
              <input
                type="checkbox"
                checked={settings.editorCursorBlink}
                onChange={(e) => patch({ editorCursorBlink: e.target.checked })}
              />
              <span>blink</span>
            </label>
          </div>
        </label>

        <div className="personalize-section">Font & Cursor — Terminal (xterm)</div>
        <label className="field">
          <span>Font family</span>
          <input
            value={settings.terminalFontFamily}
            onChange={(e) => patch({ terminalFontFamily: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Font size</span>
          <input
            type="number"
            min={8}
            max={32}
            value={settings.fontSize}
            onChange={(e) => patch({ fontSize: Number(e.target.value) || 13 })}
          />
        </label>
        <label className="field">
          <span>Cursor</span>
          <div className="personalize-cursor-row">
            <select
              value={settings.terminalCursorStyle}
              onChange={(e) => patch({ terminalCursorStyle: e.target.value as CursorStyle })}
            >
              {CURSOR_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <label className="personalize-blink">
              <input
                type="checkbox"
                checked={settings.terminalCursorBlink}
                onChange={(e) => patch({ terminalCursorBlink: e.target.checked })}
              />
              <span>blink</span>
            </label>
          </div>
        </label>

        <p className="personalize-note">
          Font and cursor changes apply the next time you open a terminal or a file — already-open
          tabs keep what they started with. Skin and background apply immediately.
        </p>

        <div className="modal-actions">
          <button className="btn btn-accent" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
