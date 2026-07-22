// The one settings surface, VS Code-style: section nav on the left; each
// setting stacks name → description → control (side-by-side rows squeezed
// long labels into slivers and pushed wide control groups out of the modal).
// Skins render as preview cards — a palette is a thing you look at, not a
// word you read.
import { useCallback, useEffect, useState } from "react";
import {
  applyTheme,
  THEME_CHANGE_EVENT,
  getSettings,
  updateSettings,
  THEMES,
  formatHotkey,
  DEFAULT_DICTATION_HOTKEY,
  type CursorStyle,
  type Hotkey,
  type Settings,
  type Theme,
} from "../settings";
import { useEscape } from "../useEscape";
import { TRACKERS, setTrackerKey, trackerKey } from "../trackers";
import * as ipc from "../ipc";
import { availableMonoFonts, fontLabel, fontStack } from "../fonts";
import { AgentIcon, TrackerIcon } from "./icons";
import { AGENT_CLIS, currentPlatform } from "../projects";

export type SettingsTab =
  | "appearance"
  | "agents"
  | "editor"
  | "terminal"
  | "dictation"
  | "guard"
  | "integrations"
  | "remote";

interface SettingsDialogProps {
  onClose: () => void;
  initialTab?: SettingsTab;
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "agents", label: "Agents" },
  { id: "editor", label: "Editor" },
  { id: "terminal", label: "Terminal" },
  { id: "dictation", label: "Dictation" },
  { id: "guard", label: "Process guard" },
  { id: "integrations", label: "Integrations" },
  { id: "remote", label: "Remote access" },
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

  // Every write announces itself. Term and MonacoEditor apply font/cursor
  // changes live off this event, and only applyTheme was dispatching it — so
  // picking a new terminal font did nothing until the next new terminal.
  const patch = (p: Partial<Settings>) => {
    const next = updateSettings(p);
    setS(next);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
  };

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
                <Item
                  name="Hibernate idle agents"
                  desc="Reclaim memory from finished background agents automatically. Hibernating kills the terminal — its scrollback exists nowhere else — so only sessions that are idle or ended (never mid-turn) and beyond the limit below are ever touched, oldest first, and each stays resumable from the Restorable list."
                >
                  <label className="set-inline-check">
                    <input
                      type="checkbox"
                      checked={s.autoHibernate}
                      onChange={(e) => patch({ autoHibernate: e.target.checked })}
                    />
                    <span>Hibernate the stalest idle agents past the limit</span>
                  </label>
                </Item>
                <Item
                  name="Live agents per project"
                  desc="How many agent terminals to keep before auto-hibernation starts reclaiming the stalest idle ones. Only applies when the option above is on."
                >
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={s.maxLiveAgents}
                    disabled={!s.autoHibernate}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v >= 1) patch({ maxLiveAgents: Math.floor(v) });
                    }}
                  />
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

            {tab === "dictation" && <DictationSettings />}

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

            {tab === "remote" && <RemoteSettings runInTerminal={runInTerminal} />}

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

/** Voice dictation setup: the model is a one-time ~700 MB download; after
 *  that everything runs locally. Lives here so setup is discoverable before
 *  the first shortcut press (which would otherwise trigger the download). */
/** BCP-47 → display name for the languages our models cover. */
const LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", nl: "Dutch", pl: "Polish", ru: "Russian", uk: "Ukrainian",
  cs: "Czech", sk: "Slovak", hr: "Croatian", ro: "Romanian", bg: "Bulgarian",
  hu: "Hungarian", fi: "Finnish", da: "Danish", sv: "Swedish", el: "Greek",
  et: "Estonian", lv: "Latvian", lt: "Lithuanian", sl: "Slovenian", mt: "Maltese",
  zh: "Chinese", yue: "Cantonese", ja: "Japanese", ko: "Korean",
};
const langName = (code: string) => LANG_NAMES[code] ?? code;

/** Capture a single keystroke and store it as the dictation hotkey. While
 *  armed, the next non-modifier keydown (with its modifiers) becomes the
 *  binding. Escape cancels; the physical `code` is stored so it survives
 *  non-US layouts. */
/** Copy to the clipboard, with a hidden-textarea fallback for webviews where
 *  the async clipboard API is unavailable. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** A click-to-copy pill: shows the value and a Copy/✓ affordance. */
function Copyable({
  text,
  display,
  big,
}: {
  text: string;
  display?: React.ReactNode;
  big?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button
      type="button"
      className="copyable"
      onClick={onClick}
      title="Click to copy"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        cursor: "pointer",
        border: "1px solid var(--line, #2a2f3a)",
        background: "var(--raised, #1f2335)",
        color: "inherit",
        borderRadius: 6,
        padding: big ? "4px 12px" : "4px 10px",
        font: "inherit",
        maxWidth: "100%",
      }}
    >
      <code
        style={{
          fontSize: big ? 26 : 13,
          letterSpacing: big ? 5 : 0,
          background: "transparent",
          padding: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {display ?? text}
      </code>
      <span
        style={{
          fontSize: 11,
          opacity: copied ? 1 : 0.6,
          color: copied ? "var(--accent, #7aa2f7)" : "inherit",
          whiteSpace: "nowrap",
        }}
      >
        {copied ? "✓ Copied" : "Copy"}
      </span>
    </button>
  );
}

/** Canopy Remote — turn on the embedded control-panel server, show the PIN and
 *  the connect URL. Off by default; see src-tauri/src/portal.rs. */
/** Canopy's theme CSS variables, read live from the DOM so the portal inherits
 *  the exact skin (including a custom accent). */
const THEME_VARS = [
  "bg",
  "bg-alt",
  "bg-raised",
  "border",
  "text",
  "text-dim",
  "accent",
  "danger",
  "ok",
  "warn",
  "on-accent",
];
function readThemeTokens(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const v of THEME_VARS) {
    const val = cs.getPropertyValue(`--${v}`).trim();
    if (val) out[v] = val;
  }
  return out;
}

/** Public-link tunnel providers, with the per-OS install command (same model as
 *  the prerequisite installers) and whether they need an account token. */
const TUNNELS: {
  id: string;
  name: string;
  bin: string;
  needsToken: boolean;
  blurb: string;
  tokenHelp?: string;
  note?: string;
  install: Record<"macos" | "windows" | "linux", string>;
}[] = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    bin: "cloudflared",
    needsToken: false,
    blurb: "No account — an instant https:// link. Recommended.",
    install: {
      macos: "brew install cloudflared",
      windows: "winget install --id Cloudflare.cloudflared -e --source winget",
      linux: "curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared",
    },
  },
  {
    id: "ngrok",
    name: "ngrok",
    bin: "ngrok",
    needsToken: true,
    blurb: "Paste your free authtoken.",
    tokenHelp: "From dashboard.ngrok.com → Your Authtoken.",
    install: {
      macos: "brew install ngrok",
      windows: "winget install --id ngrok.ngrok -e --source winget",
      linux: "curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null && echo 'deb https://ngrok-agent.s3.amazonaws.com buster main' | sudo tee /etc/apt/sources.list.d/ngrok.list && sudo apt update && sudo apt install ngrok",
    },
  },
  {
    id: "tailscale",
    name: "Tailscale",
    bin: "tailscale",
    needsToken: false,
    blurb: "Uses Funnel for a public link.",
    note: "Requires Funnel enabled in your tailnet admin (plain Tailscale needs the app on both devices).",
    install: {
      macos: "brew install tailscale",
      windows: "winget install --id tailscale.tailscale -e --source winget",
      linux: "curl -fsSL https://tailscale.com/install.sh | sh",
    },
  },
];

function RemoteSettings({
  runInTerminal,
}: {
  runInTerminal: (command: string, title: string) => void;
}) {
  const [status, setStatus] = useState<ipc.RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<"local" | "internet">("local");
  const [provider, setProvider] = useState("cloudflare");
  const [tunnel, setTunnel] = useState<ipc.TunnelState>({
    running: false,
    provider: null,
    url: null,
    message: null,
  });
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [token, setToken] = useState(() => trackerKey("ngrok"));
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    void ipc.remoteStatus().then(setStatus).catch(() => setStatus(null));
    void ipc.tunnelStatus().then(setTunnel).catch(() => {});
    void ipc
      .whichCheck(TUNNELS.map((t) => t.bin))
      .then(setInstalled)
      .catch(() => {});
    const un = ipc.onTunnelState(setTunnel);
    return () => void un.then((f) => f());
  }, []);

  // Push our theme to the portal whenever remote access is on.
  useEffect(() => {
    if (status?.enabled) void ipc.remoteSetTheme(readThemeTokens()).catch(() => {});
  }, [status?.enabled]);

  const on = status?.enabled ?? false;
  const lanUrl = status?.urls?.[0] ?? null;
  const activeUrl = scope === "internet" ? tunnel.url : lanUrl;

  // Repoint the QR at whichever URL the chosen scope resolves to.
  useEffect(() => {
    if (!on || !activeUrl) {
      setQr(null);
      return;
    }
    void ipc.remoteQr(activeUrl).then(setQr).catch(() => setQr(null));
  }, [on, activeUrl]);

  const run = (op: () => Promise<ipc.RemoteStatus>) => {
    setBusy(true);
    void op().then(setStatus).catch(() => {}).finally(() => setBusy(false));
  };
  const prov = TUNNELS.find((t) => t.id === provider)!;
  const provInstalled = installed[prov.bin] ?? true;

  const startTunnel = () => {
    if (!status) return;
    setBusy(true);
    const tok = prov.needsToken ? token.trim() : undefined;
    void ipc
      .tunnelStart(provider, status.port, tok)
      .then(setTunnel)
      .catch((e) => setTunnel({ running: false, provider, url: null, message: String(e) }))
      .finally(() => setBusy(false));
  };
  const stopTunnel = () => {
    setBusy(true);
    void ipc.tunnelStop().then(setTunnel).finally(() => setBusy(false));
  };

  return (
    <>
      <Item
        name="Remote access"
        desc="Drive your agents from a phone or browser. A dedicated PIN unlocks a control panel that lists every project and agent, streams each agent's output, and lets you reply, approve, or stop them. Off by default; the PIN is separate from the team join code."
      >
        <button
          className="btn"
          disabled={busy}
          onClick={() => run(on ? ipc.remoteDisable : ipc.remoteEnable)}
        >
          {on ? "Turn off" : "Turn on"}
        </button>
      </Item>

      {on && (
        <>
          {/* Scope toggle — the QR follows this. */}
          <Item name="Reach" desc="Who can open the portal — and what the QR points at.">
            <div style={{ display: "inline-flex", border: "1px solid var(--border, #2a2f3a)", borderRadius: 9, overflow: "hidden" }}>
              {(["local", "internet"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  style={{
                    padding: "7px 14px",
                    border: "none",
                    background: scope === s ? "var(--accent, #7aa2f7)" : "transparent",
                    color: scope === s ? "var(--on-accent, #fff)" : "var(--text, #ccc)",
                    fontWeight: 600,
                  }}
                >
                  {s === "local" ? "This network" : "Internet"}
                </button>
              ))}
            </div>
          </Item>

          <Item
            name="Scan to connect"
            desc={
              scope === "local"
                ? "Same Wi-Fi: scan with your phone's camera, then enter the PIN."
                : tunnel.url
                  ? "Scan from anywhere, then enter the PIN. This link works on any network."
                  : "Start a public link below — the QR will point at it."
            }
          >
            <div className="set-inline" style={{ alignItems: "center", gap: 16 }}>
              {qr ? (
                <div
                  style={{ width: 148, height: 148, padding: 8, background: "#fff", borderRadius: 8, flex: "none" }}
                  dangerouslySetInnerHTML={{ __html: qr }}
                />
              ) : (
                <div
                  style={{ width: 148, height: 148, borderRadius: 8, flex: "none", background: "var(--bg-raised, #1f2335)", display: "grid", placeItems: "center", color: "var(--text-dim, #888)", fontSize: 12, textAlign: "center", padding: 10 }}
                >
                  {scope === "internet" ? "no public link yet" : "…"}
                </div>
              )}
              <div>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>PIN</div>
                <Copyable text={status?.pin ?? ""} big />
                <div style={{ marginTop: 10 }}>
                  <button className="btn" disabled={busy} onClick={() => run(ipc.remoteRotatePin)}>
                    New PIN
                  </button>
                </div>
              </div>
            </div>
          </Item>

          {scope === "local" && (
            <Item name="Or type the address" desc="Same Wi-Fi — open one of these and enter the PIN.">
              <div style={{ display: "grid", gap: 6, justifyItems: "start" }}>
                {status?.urls.map((u) => (
                  <Copyable key={u} text={u} />
                ))}
              </div>
            </Item>
          )}

          {scope === "internet" && (
            <>
              <Item name="Public link via" desc="Canopy runs the tunnel for you; the link loads in any browser, no router setup.">
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {TUNNELS.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setProvider(t.id)}
                      style={{
                        padding: "7px 12px",
                        borderRadius: 8,
                        border: `1px solid ${provider === t.id ? "var(--accent, #7aa2f7)" : "var(--border, #2a2f3a)"}`,
                        background: provider === t.id ? "color-mix(in srgb, var(--accent, #7aa2f7) 16%, transparent)" : "transparent",
                        color: "var(--text, #ccc)",
                        fontWeight: 600,
                      }}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              </Item>

              <Item name={prov.name} desc={prov.note ? `${prov.blurb} ${prov.note}` : prov.blurb}>
                <div style={{ display: "grid", gap: 10, justifyItems: "start", width: "100%" }}>
                  {prov.needsToken && (
                    <div style={{ display: "grid", gap: 4, width: "100%", maxWidth: 380 }}>
                      <input
                        type="password"
                        className="set-wide"
                        placeholder="ngrok authtoken"
                        value={token}
                        onChange={(e) => {
                          setToken(e.target.value);
                          setTrackerKey("ngrok", e.target.value.trim());
                        }}
                      />
                      {prov.tokenHelp && (
                        <div style={{ fontSize: 12, color: "var(--text-dim, #888)" }}>{prov.tokenHelp}</div>
                      )}
                    </div>
                  )}

                  {!provInstalled ? (
                    <button
                      className="btn"
                      onClick={() => runInTerminal(prov.install[currentPlatform()], `Install ${prov.name}`)}
                    >
                      Install {prov.name}
                    </button>
                  ) : tunnel.running && tunnel.provider === provider ? (
                    <button className="btn" disabled={busy} onClick={stopTunnel}>
                      Stop public link
                    </button>
                  ) : (
                    <button
                      className="btn"
                      disabled={busy || (prov.needsToken && !token.trim())}
                      onClick={startTunnel}
                    >
                      Start public link
                    </button>
                  )}

                  {tunnel.url && tunnel.provider === provider && (
                    <Copyable text={tunnel.url} />
                  )}
                  {tunnel.message && (
                    <div
                      style={{
                        fontSize: 12,
                        color: tunnel.running ? "var(--text-dim, #888)" : "var(--danger, #f7768e)",
                        whiteSpace: "pre-wrap",
                        maxWidth: 460,
                        fontFamily: tunnel.running ? undefined : "ui-monospace, monospace",
                      }}
                    >
                      {tunnel.message}
                    </div>
                  )}
                </div>
              </Item>
            </>
          )}

          <Item
            name="Security"
            desc="⚠ While this is on, anyone with the PIN on a reachable network (or the public link) can send input to your agents and approve their actions. Turn it off when you're done."
          >
            <span />
          </Item>
        </>
      )}
    </>
  );
}

function HotkeyCapture({ value, onChange }: { value: Hotkey; onChange: (h: Hotkey) => void }) {
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (!arming) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setArming(false);
        return;
      }
      // Ignore lone modifier presses — wait for the actual key.
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      onChange({
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        code: e.code,
      });
      setArming(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [arming, onChange]);

  return (
    <span className="set-inline">
      <button
        className={`btn dictation-hotkey ${arming ? "dictation-hotkey-arming" : ""}`}
        onClick={() => setArming((a) => !a)}
      >
        {arming ? "Press a key…" : formatHotkey(value)}
      </button>
      <button className="btn" onClick={() => onChange(DEFAULT_DICTATION_HOTKEY)}>
        Reset
      </button>
    </span>
  );
}

function DictationSettings() {
  const [models, setModels] = useState<ipc.DictationModel[]>([]);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [s, setS] = useState<Settings>(() => getSettings());
  const patch = (p: Partial<Settings>) => setS(updateSettings(p));
  const refresh = () => void ipc.dictationModels().then(setModels).catch(() => {});

  useEffect(() => {
    refresh();
    const sub = ipc.onDictationProgress((p) => {
      if (p.phase === "download") {
        setProgress((m) => ({ ...m, [p.model]: `${Math.floor(p.pct)}%` }));
      } else if (p.phase === "extract") {
        setProgress((m) => ({ ...m, [p.model]: "unpacking…" }));
      } else {
        setProgress((m) => {
          const next = { ...m };
          delete next[p.model];
          return next;
        });
        if (p.phase === "error") setErr(p.message ?? "Download failed");
        refresh();
      }
    });
    return () => void sub.then((fn) => fn());
  }, []);

  // The active model: the stored id, or the registry default when unset.
  const activeId = s.dictationModel || models.find((m) => m.is_default)?.id || "";
  const active = models.find((m) => m.id === activeId);

  return (
    <>
      <Item
        name="Shortcut"
        desc="Press this anywhere — terminal, editor, or any text field — to start dictating; press again to insert the transcription. Esc cancels a recording. Everything runs locally; audio never leaves this machine."
      >
        <HotkeyCapture value={s.dictationHotkey} onChange={(h) => patch({ dictationHotkey: h })} />
      </Item>

      <Item
        name="Model"
        desc="Choose which local speech model to use. The first is installed on first use; others download on demand. Larger models are more accurate; Moonshine is fastest for English."
      >
        <div className="dictation-models">
          {models.map((m) => {
            const dl = progress[m.id];
            return (
              <label key={m.id} className="dictation-model">
                <input
                  type="radio"
                  name="dictation-model"
                  checked={m.id === activeId}
                  onChange={() => patch({ dictationModel: m.id, dictationLanguage: "" })}
                />
                <span className="dictation-model-main">
                  <span className="dictation-model-name">
                    {m.name}
                    {m.is_default && <span className="dictation-tag">default</span>}
                  </span>
                  <span className="dictation-model-sub">
                    {m.multilingual ? `${m.languages.length} languages` : langName(m.languages[0])}
                    {" · ~"}
                    {m.size_mb} MB
                  </span>
                </span>
                {dl ? (
                  <span className="dictation-model-state">{dl}</span>
                ) : m.downloaded ? (
                  <button
                    className="btn dictation-model-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      setErr(null);
                      void ipc
                        .dictationDeleteModel(m.id)
                        .then(refresh)
                        .catch((er) => setErr(String(er)));
                    }}
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    className="btn btn-accent dictation-model-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      setErr(null);
                      setProgress((mm) => ({ ...mm, [m.id]: "0%" }));
                      void ipc.dictationDownload(m.id).catch((er) => {
                        setProgress((mm) => {
                          const next = { ...mm };
                          delete next[m.id];
                          return next;
                        });
                        setErr(String(er));
                      });
                    }}
                  >
                    Install
                  </button>
                )}
              </label>
            );
          })}
        </div>
      </Item>

      {active && (
        <Item
          name="Language"
          desc={
            active.multilingual
              ? "Auto-detect works well; pick a language to bias transcription when you always dictate in one."
              : "This model is English-only."
          }
        >
          <select
            className="set-wide"
            disabled={!active.multilingual}
            value={s.dictationLanguage}
            onChange={(e) => patch({ dictationLanguage: e.target.value })}
          >
            <option value="">Auto-detect</option>
            {active.languages.map((code) => (
              <option key={code} value={code}>
                {langName(code)}
              </option>
            ))}
          </select>
        </Item>
      )}

      {err && <div className="set-item-desc set-error">{err}</div>}
    </>
  );
}
