// The one settings surface, VS Code-style: section nav on the left; each
// setting stacks name → description → control (side-by-side rows squeezed
// long labels into slivers and pushed wide control groups out of the modal).
// Skins render as preview cards — a palette is a thing you look at, not a
// word you read.
import { useCallback, useEffect, useState } from "react";
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
import { TRACKERS, setTrackerKey, trackerKey } from "../trackers";
import * as ipc from "../ipc";
import { availableMonoFonts, fontLabel, fontStack } from "../fonts";
import { AgentIcon, TrackerIcon } from "./icons";
import { AGENT_CLIS } from "../projects";

export type SettingsTab = "appearance" | "agents" | "editor" | "terminal" | "guard" | "integrations";

interface SettingsDialogProps {
  onClose: () => void;
  initialTab?: SettingsTab;
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "agents", label: "Agents" },
  { id: "editor", label: "Editor" },
  { id: "terminal", label: "Terminal" },
  { id: "guard", label: "Process guard" },
  { id: "integrations", label: "Integrations" },
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
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [keysVersion, setKeysVersion] = useState(0);
  const [gh, setGh] = useState<ipc.GhAuth | null>(null);
  const [ghBusy, setGhBusy] = useState(false);
  const fonts = availableMonoFonts();

  const refreshGh = useCallback(() => {
    setGhBusy(true);
    void ipc
      .ghAuth()
      .then(setGh)
      .catch(() => setGh(null))
      .finally(() => setGhBusy(false));
  }, []);
  useEffect(() => {
    if (tab === "integrations") refreshGh();
  }, [tab, refreshGh]);

  /** gh's sign-in and sign-out are interactive (device code, browser
   *  hand-off, confirmations) so they belong in a real terminal the user can
   *  watch and answer — not a silent subprocess. ProjectView owns terminals;
   *  this asks it to open one. */
  const runInTerminal = (command: string, title: string) => {
    window.dispatchEvent(
      new CustomEvent("canopy:run-command", { detail: { command, title } }),
    );
    onClose();
  };
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
                      // Preview the accent the skin would actually render
                      // with — the user's override wins on every skin now.
                      const accent = s.customAccent || p.accent;
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
                  desc="Applies on top of whichever skin is selected — including Auto and Daylight. Leave it unset to use the skin's own accent."
                >
                  <div className="set-inline">
                    <input
                      type="color"
                      value={s.customAccent || "#7aa2f7"}
                      onChange={(e) => {
                        patch({ customAccent: e.target.value });
                        applyTheme(s.theme, e.target.value);
                      }}
                    />
                    <code className="set-hexcode">
                      {s.customAccent || "skin default"}
                    </code>
                    {s.customAccent && (
                      <button
                        className="btn"
                        onClick={() => {
                          patch({ customAccent: "" });
                          applyTheme(s.theme, "");
                        }}
                      >
                        Use skin colour
                      </button>
                    )}
                  </div>
                </Item>
              </>
            )}

            {tab === "agents" && (
              <>
                <Item
                  name="Default agent"
                  desc="Which CLI starts work when you hand it a ticket. You can always pick a different one at the moment you start — this is just what the primary button does."
                >
                  <div className="skin-grid">
                    {AGENT_CLIS.map((cli) => (
                      <button
                        key={cli.id}
                        className={`skin-card ${s.defaultAgent === cli.id ? "skin-card-active" : ""}`}
                        onClick={() => patch({ defaultAgent: cli.id })}
                      >
                        <span className="agent-card-mark">
                          <AgentIcon id={cli.id} size={22} />
                        </span>
                        <span className="skin-name">{cli.name}</span>
                      </button>
                    ))}
                  </div>
                </Item>
                <Item
                  name="Opening context"
                  desc="Every agent is handed the ticket's id, title and URL, and asked to read it, look around the code, and propose a plan before working. Agents whose CLI takes an opening prompt get it as an argument; the rest have it typed in once their interface is up."
                >
                  <span className="set-item-desc">
                    Canopy never commits, pushes or opens a PR on your behalf.
                  </span>
                </Item>
              </>
            )}

            {tab === "editor" && (
              <>
                <Item name="Font family" desc="Monospace fonts found on this machine. Applies to newly opened files.">
                  <select
                    className="set-wide"
                    value={fontLabel(s.editorFontFamily)}
                    onChange={(e) => patch({ editorFontFamily: fontStack(e.target.value) })}
                  >
                    <option value="">System default</option>
                    {fonts.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                    {/* A font stored from another machine (or an older text
                        box) that isn't installed here — keep it selectable
                        rather than silently switching them off it. */}
                    {fontLabel(s.editorFontFamily) && !fonts.includes(fontLabel(s.editorFontFamily)) && (
                      <option value={fontLabel(s.editorFontFamily)}>
                        {fontLabel(s.editorFontFamily)} (not installed)
                      </option>
                    )}
                  </select>
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
                <Item name="Font family" desc="Monospace fonts found on this machine. Applies to newly opened terminals.">
                  <select
                    className="set-wide"
                    value={fontLabel(s.terminalFontFamily)}
                    onChange={(e) => patch({ terminalFontFamily: fontStack(e.target.value) })}
                  >
                    <option value="">System default</option>
                    {fonts.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                    {/* A font stored from another machine (or an older text
                        box) that isn't installed here — keep it selectable
                        rather than silently switching them off it. */}
                    {fontLabel(s.terminalFontFamily) && !fonts.includes(fontLabel(s.terminalFontFamily)) && (
                      <option value={fontLabel(s.terminalFontFamily)}>
                        {fontLabel(s.terminalFontFamily)} (not installed)
                      </option>
                    )}
                  </select>
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

            {tab === "integrations" && (
              <>
                {TRACKERS.map((p) => (
                  <div key={p.id} className="set-item">
                    <div className="set-item-name set-inline">
                      <TrackerIcon id={p.id} size={14} />
                      {p.name}
                    </div>
                    {p.config ? (
                      trackerKey(p.id) ? (
                        <>
                          <div className="set-item-desc">
                            Connected. The key is stored locally on this machine only.
                          </div>
                          <div className="set-item-control">
                            <button
                              className="btn"
                              onClick={() => {
                                setTrackerKey(p.id, "");
                                setKeysVersion((v) => v + 1);
                              }}
                            >
                              Disconnect
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="set-item-desc">{p.config.help}</div>
                          <div className="set-item-control set-inline">
                            <input
                              type="password"
                              className="set-wide"
                              placeholder={p.config.placeholder}
                              value={keyDrafts[p.id] ?? ""}
                              onChange={(e) =>
                                setKeyDrafts((d) => ({ ...d, [p.id]: e.target.value }))
                              }
                            />
                            <button
                              className="btn btn-accent"
                              disabled={!(keyDrafts[p.id] ?? "").trim()}
                              onClick={() => {
                                setTrackerKey(p.id, (keyDrafts[p.id] ?? "").trim());
                                setKeyDrafts((d) => ({ ...d, [p.id]: "" }));
                                setKeysVersion((v) => v + 1);
                              }}
                            >
                              Connect
                            </button>
                          </div>
                        </>
                      )
                    ) : (
                      // GitHub has no key of ours — it rides on the user's own
                      // gh CLI, so this section manages that instead: install
                      // it, sign in, or show who is signed in with a way out.
                      <>
                        <div className="set-item-desc">
                          {!gh
                            ? ghBusy
                              ? "Checking the GitHub CLI…"
                              : "Couldn't check the GitHub CLI."
                            : !gh.installed
                              ? "The GitHub CLI (gh) isn't installed. Canopy uses it for issues and pull requests — no token of its own."
                              : gh.authenticated
                                ? `Signed in as ${gh.account}${gh.host ? ` on ${gh.host}` : ""} · ${gh.path}`
                                : `Installed at ${gh.path}, but not signed in.${gh.detail ? ` ${gh.detail}` : ""}`}
                        </div>
                        <div className="set-item-control set-inline">
                          {gh && !gh.installed && (
                            <button
                              className="btn btn-accent"
                              onClick={() =>
                                runInTerminal("brew install gh", "install gh")
                              }
                            >
                              Install with Homebrew
                            </button>
                          )}
                          {gh?.installed && !gh.authenticated && (
                            <button
                              className="btn btn-accent"
                              onClick={() =>
                                runInTerminal("gh auth login", "gh auth login")
                              }
                            >
                              Sign in to GitHub
                            </button>
                          )}
                          {gh?.authenticated && (
                            <>
                              <button
                                className="btn"
                                onClick={() =>
                                  runInTerminal(
                                    "gh auth login",
                                    "gh auth login",
                                  )
                                }
                              >
                                Switch account
                              </button>
                              <button
                                className="btn"
                                onClick={() =>
                                  runInTerminal("gh auth logout", "gh auth logout")
                                }
                              >
                                Sign out
                              </button>
                            </>
                          )}
                          <button className="btn" disabled={ghBusy} onClick={refreshGh}>
                            {ghBusy ? "Checking…" : "Recheck"}
                          </button>
                        </div>
                        <div className="set-item-desc set-note">
                          Sign-in runs in a terminal because GitHub's flow is
                          interactive — Canopy never sees the token; gh stores
                          it in your keychain.
                        </div>
                      </>
                    )}
                  </div>
                ))}
                <div className="set-item-desc" data-v={keysVersion}>
                  Issues from connected trackers appear unified in the ◎ Issues
                  panel in the sidebar.
                </div>
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
