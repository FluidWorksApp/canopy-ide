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
import {
  AGENT_CLIS,
  binName,
  BUILTIN_AGENT_CLIS,
  currentPlatform,
  customCliIssue,
  namesArguments,
  newCustomCliId,
  refreshAgentClis,
  type AgentCliDef,
  type CustomAgentCli,
} from "../projects";
import { AGENT_TOOL_GROUPS, ALL_AGENT_TOOLS } from "../agentTools";
import {
  BUILTIN_MAP,
  EXTRA_ASSOCIATIONS,
  LANGUAGES,
  describePattern,
  languageLabel,
  normalizePattern,
} from "../fileAssociations";

export type SettingsTab =
  | "appearance"
  | "agents"
  | "editor"
  | "terminal"
  | "dictation"
  | "integrations"
  | "browser"
  | "remote"
  | "privacy";

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
  { id: "integrations", label: "Integrations" },
  { id: "browser", label: "Browser" },
  { id: "remote", label: "Remote access" },
  { id: "privacy", label: "Privacy" },
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

/**
 * Which language each file type is highlighted as.
 *
 * Monaco's bundled grammars leave real holes — C++ registers .c/.h and nothing
 * else, there is no JSON grammar at all, and .astro/.svelte/.vue/.toml are
 * unknown — so Canopy ships a table pointing each gap at the closest grammar
 * that does exist. This screen shows that table rather than hiding it: every
 * shipped row is re-pointable, and anything missing is one row away.
 */
function FileAssociations({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"ext" | "name">("ext");
  const [pattern, setPattern] = useState("");
  const [language, setLanguage] = useState("html");
  const [error, setError] = useState<string | null>(null);

  const set = (p: string, lang: string) => onChange({ ...value, [p]: lang });
  const clear = (p: string) => {
    const next = { ...value };
    delete next[p];
    onChange(next);
  };

  const add = () => {
    const p = normalizePattern(pattern, kind);
    if (!p) {
      setError(kind === "ext" ? "Type an extension, e.g. astro" : "Type a file name.");
      return;
    }
    setError(null);
    setPattern("");
    set(p, language);
  };

  const q = query.trim().toLowerCase();
  const hit = (p: string, lang: string) =>
    !q || p.toLowerCase().includes(q) || languageLabel(lang).toLowerCase().includes(q);

  const custom = Object.entries(value)
    .filter(([p]) => BUILTIN_MAP[p] == null)
    .filter(([p, lang]) => hit(p, lang));

  const picker = (current: string, onPick: (id: string) => void) => (
    <select value={current} onChange={(e) => onPick(e.target.value)}>
      {LANGUAGES.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  );

  const row = (p: string, lang: string, shipped: string | null) => (
    <div key={p} className="assoc-row">
      <code className="assoc-pattern">{describePattern(p)}</code>
      {picker(lang, (id) => (shipped === id ? clear(p) : set(p, id)))}
      {shipped == null ? (
        <button className="btn-mini" onClick={() => clear(p)} title="Remove this mapping">
          Remove
        </button>
      ) : value[p] != null ? (
        <button className="btn-mini" onClick={() => clear(p)} title={`Back to ${languageLabel(shipped)}`}>
          Reset
        </button>
      ) : (
        <span className="assoc-spacer" />
      )}
    </div>
  );

  return (
    <div className="assoc">
      <div className="assoc-add">
        <select value={kind} onChange={(e) => setKind(e.target.value as "ext" | "name")}>
          <option value="ext">Extension</option>
          <option value="name">File name</option>
        </select>
        <input
          className="assoc-input"
          placeholder={kind === "ext" ? "astro" : "Dockerfile.*"}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <span className="assoc-arrow">→</span>
        {picker(language, setLanguage)}
        <button className="btn btn-accent" onClick={add}>
          Add
        </button>
      </div>
      {error && <div className="assoc-error">{error}</div>}
      <input
        className="assoc-search"
        placeholder="Search mappings…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="assoc-list">
        {custom.length > 0 && (
          <div className="assoc-group">
            <div className="assoc-group-name">Your mappings</div>
            <div className="assoc-group-blurb">
              Added here, and checked before every grammar Canopy ships.
            </div>
            {custom.map(([p, lang]) => row(p, lang, null))}
          </div>
        )}
        {EXTRA_ASSOCIATIONS.map((group) => {
          const entries = group.entries.filter((e) => hit(e.pattern, value[e.pattern] ?? e.language));
          if (entries.length === 0) return null;
          return (
            <div key={group.label} className="assoc-group">
              <div className="assoc-group-name">{group.label}</div>
              <div className="assoc-group-blurb">{group.blurb}</div>
              {entries.map((e) => row(e.pattern, value[e.pattern] ?? e.language, e.language))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Point a registry entry at the binary this machine actually has.
 *
 * The case this exists for: an enterprise build of Claude Code installed as
 * `acme-claude`. Canopy probed the stock name, found nothing, and offered to
 * install a public copy the user couldn't authenticate — forever, because
 * nothing they did could make a `claude` appear.
 *
 * Each edit re-probes and says what it found, so the answer arrives before the
 * dialog closes rather than as a launcher row that still says "install".
 */
function AgentBinaries({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({ ...value }));
  const [found, setFound] = useState<Record<string, boolean>>({});
  /** Rows whose last entry named arguments rather than an executable — kept out
   *  of the stored overrides, and said out loud instead of probed. */
  const [rejected, setRejected] = useState<Record<string, boolean>>({});

  // Probe the resolved binaries — AGENT_CLIS already carries the overrides.
  // Keyed on the overrides' *contents*: `updateSettings` rebuilds the settings
  // object on every write, so once any override is stored, depending on the
  // object's identity would spawn a login shell — the costly part of the probe
  // — for every unrelated toggle on this tab.
  const overridesKey = JSON.stringify(value);
  useEffect(() => {
    void ipc
      .whichCheck(AGENT_CLIS.map((c) => c.bin))
      .then(setFound)
      .catch(() => {});
  }, [overridesKey]);

  const commit = (def: AgentCliDef, raw: string) => {
    const typed = raw.trim();
    // A command line, not a command — see namesArguments.
    if (namesArguments(typed)) {
      setDrafts((d) => ({ ...d, [def.id]: typed }));
      setRejected((r) => ({ ...r, [def.id]: true }));
      return;
    }
    setRejected((r) => ({ ...r, [def.id]: false }));
    const next = { ...value };
    // An empty box, or the vendor's own name typed back in, is not an override
    // — storing it would pin the entry to a name that may change in a later
    // release of Canopy.
    if (typed && typed !== def.bin) next[def.id] = typed;
    else delete next[def.id];
    setDrafts((d) => ({ ...d, [def.id]: typed }));
    onChange(next);
  };

  return (
    <div className="cli-bins">
      {BUILTIN_AGENT_CLIS.map((def) => {
        const resolved = AGENT_CLIS.find((c) => c.id === def.id);
        const bin = resolved?.bin ?? def.bin;
        const state = found[bin];
        return (
          <div key={def.id} className="cli-bin-row">
            <label className="cli-bin-name" htmlFor={`cli-bin-${def.id}`}>
              <AgentIcon id={def.id} size={16} />
              <span>{def.name}</span>
            </label>
            <input
              id={`cli-bin-${def.id}`}
              className="cli-bin-input"
              type="text"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={def.bin}
              value={drafts[def.id] ?? ""}
              onChange={(e) => setDrafts((d) => ({ ...d, [def.id]: e.target.value }))}
              onBlur={(e) => commit(def, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setDrafts((d) => ({ ...d, [def.id]: value[def.id] ?? "" }));
                  e.currentTarget.blur();
                }
              }}
            />
            <span
              className={`cli-bin-state ${state === false || rejected[def.id] ? "cli-bin-missing" : ""}`}
              title={
                rejected[def.id]
                  ? "This field names one executable — a path or a command name, with no arguments"
                  : state === false
                    ? `Nothing named ${bin} on your PATH`
                    : bin
              }
            >
              {rejected[def.id]
                ? "✗ a command, not a command line"
                : state === undefined
                  ? ""
                  : state
                    ? "✓ found"
                    : "✗ not found"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Add an agent CLI Canopy ships no entry for.
 *
 * The four fields are the whole of what only the user can tell us: what to run,
 * what to call it, and the two argument shapes worth knowing. Everything a
 * built-in entry also carries — installer, registry, package identity, hook and
 * MCP wiring — is absent by design rather than left blank for later, so this
 * screen must not imply otherwise: what it buys is a launcher, a named terminal
 * and (if they say how) resume.
 *
 * Rows are drafted locally and committed on blur, like the binaries list above:
 * each commit re-resolves the registry and re-probes PATH, neither of which
 * should happen per keystroke.
 */
function CustomClis({
  value,
  onChange,
}: {
  value: CustomAgentCli[];
  onChange: (next: CustomAgentCli[]) => void;
}) {
  const [rows, setRows] = useState<CustomAgentCli[]>(() => value);
  const [found, setFound] = useState<Record<string, boolean>>({});

  // Keyed on the bins themselves: probing costs a login shell, and every other
  // field on this row is irrelevant to whether the executable exists.
  const binsKey = value.map((c) => c.bin.trim()).filter(Boolean).join("\n");
  useEffect(() => {
    const bins = binsKey.split("\n").filter(Boolean);
    if (bins.length === 0) return;
    void ipc.whichCheck(bins).then(setFound).catch(() => {});
  }, [binsKey]);

  const edit = (i: number, patch: Partial<CustomAgentCli>) =>
    setRows((r) => r.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const commit = (next: CustomAgentCli[]) => {
    setRows(next);
    onChange(next);
  };

  /** Name it, and — the first time only — give it its id. Renaming afterwards
   *  leaves the id alone: it is what `defaultAgent` and every recorded task run
   *  refer to, and rewriting it would silently strand them. */
  const commitName = (i: number, raw: string) => {
    const name = raw.trim();
    const next = rows.map((c, n) =>
      n === i
        ? {
            ...c,
            name,
            id: c.id || (name ? newCustomCliId(name, rows.map((o) => o.id)) : ""),
          }
        : c,
    );
    commit(next);
  };

  return (
    <div className="cli-customs">
      {rows.map((c, i) => {
        const bin = c.bin.trim();
        // The registry's own rule, asked rather than re-implemented: a row this
        // marks is a row that won't be registered, so the two can't disagree.
        const issue = customCliIssue(c, rows.slice(0, i));
        const state = issue || !bin ? undefined : found[bin];
        return (
          <div key={c.id || `draft-${i}`} className="cli-custom">
            <div className="cli-custom-head">
              <input
                className="cli-bin-input"
                placeholder="Name"
                title="What to call it — in the launcher, the ＋ menu and its terminal tab"
                spellCheck={false}
                value={c.name}
                onChange={(e) => edit(i, { name: e.target.value })}
                onBlur={(e) => commitName(i, e.target.value)}
              />
              <input
                className="cli-bin-input"
                placeholder="Command or path"
                title="The executable to run — a command name on your PATH, or a full path"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={c.bin}
                onChange={(e) => edit(i, { bin: e.target.value })}
                onBlur={(e) => commit(rows.map((o, n) => (n === i ? { ...o, bin: e.target.value.trim() } : o)))}
              />
              <span
                className={`cli-bin-state ${state === false || issue ? "cli-bin-missing" : ""}`}
                title={
                  issue === "arguments"
                    ? "This field names one executable — a path or a command name, with no arguments"
                    : issue === "duplicate"
                      ? `Another entry already launches ${binName(bin)}, so this one isn't registered`
                      : state === false
                        ? `Nothing named ${bin} on your PATH`
                        : bin
                }
              >
                {/* Shorter than the binaries list says it, because here the
                    column has a Remove button after it to stay clear of; the
                    full sentence is the tooltip. */}
                {issue === "arguments"
                  ? "✗ not a command"
                  : issue === "duplicate"
                    ? "✗ in use"
                    : state === undefined
                      ? ""
                      : state
                        ? "✓ found"
                        : "✗ not found"}
              </span>
              <button
                className="btn btn-small"
                title={`Remove ${c.name || "this CLI"} from the launcher`}
                onClick={() => commit(rows.filter((_, n) => n !== i))}
              >
                Remove
              </button>
            </div>
            <div className="cli-custom-args">
              <input
                className="cli-bin-input"
                placeholder="Resume args, e.g. --resume {id}"
                spellCheck={false}
                title="How this CLI reopens a session by id. Leave blank if it can't — a flag that doesn't exist starts a fresh session while Canopy says the conversation was restored."
                value={c.resumeArgs ?? ""}
                onChange={(e) => edit(i, { resumeArgs: e.target.value })}
                onBlur={(e) =>
                  commit(rows.map((o, n) => (n === i ? { ...o, resumeArgs: e.target.value.trim() } : o)))
                }
              />
              <input
                className="cli-bin-input"
                placeholder="Prompt args, e.g. {prompt}"
                spellCheck={false}
                title="How this CLI takes an opening prompt and stays interactive. Leave blank to have Canopy launch it bare and type the prompt in instead."
                value={c.promptArgs ?? ""}
                onChange={(e) => edit(i, { promptArgs: e.target.value })}
                onBlur={(e) =>
                  commit(rows.map((o, n) => (n === i ? { ...o, promptArgs: e.target.value.trim() } : o)))
                }
              />
            </div>
          </div>
        );
      })}
      {/* The placeholders name the two tokens, but a placeholder is gone the
          moment you type — so the list says it once, where a row being edited
          can still be seen. */}
      {rows.length > 0 && (
        <div className="cli-custom-hint">
          <code>{"{id}"}</code> the session id · <code>{"{prompt}"}</code> your text · omit
          either and it's appended
        </div>
      )}
      <button
        className="btn btn-small"
        onClick={() => commit([...rows, { id: "", name: "", bin: "" }])}
      >
        ＋ Add a CLI
      </button>
    </div>
  );
}

export function SettingsDialog({ onClose, initialTab = "appearance" }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [keysVersion, setKeysVersion] = useState(0);
  const [gh, setGh] = useState<ipc.GhAuth | null>(null);
  const [ghBusy, setGhBusy] = useState(false);
  // Dictation rides on the bundled ONNX Runtime, absent on unsupported builds
  // (Intel macOS). Default true so the tab doesn't flicker in on every supported
  // platform while the check resolves; only hide once we learn it's unavailable.
  const [dictationOk, setDictationOk] = useState(true);
  // Whether this platform has the real embedded browser at all. Only macOS
  // does so far; everywhere else the engine choice is decoration and the
  // section says so instead of offering a switch that does nothing.
  const [browserOk, setBrowserOk] = useState(false);
  const [clearing, setClearing] = useState<null | "busy" | "done" | string>(null);
  const fonts = availableMonoFonts();

  useEffect(() => {
    void ipc
      .dictationSupported()
      .then((ok) => {
        setDictationOk(ok);
        // Don't strand the user on a tab that's about to disappear.
        if (!ok) setTab((t) => (t === "dictation" ? "appearance" : t));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    void ipc.browserSupported().then(setBrowserOk);
  }, []);
  const visibleTabs = TABS.filter((t) => t.id !== "dictation" || dictationOk);

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
            {visibleTabs.map((t) => (
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
                <Item name="Skin" desc="Colors for the whole app; applies immediately.">
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
                  desc="Overrides the skin's accent; leave unset to keep it."
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
                <Item
                  name="Side panel"
                  desc="How the file tree, changes and the rest of the rail's panels come and go."
                >
                  <div className="set-checks">
                    <label className="set-inline-check">
                      <input
                        type="checkbox"
                        checked={s.sidebarHover}
                        onChange={(e) => patch({ sidebarHover: e.target.checked })}
                      />
                      <span>
                        Hover to view
                        <em>Rest on a rail icon and its panel opens; otherwise click to open.</em>
                      </span>
                    </label>
                    <label className="set-inline-check">
                      <input
                        type="checkbox"
                        checked={s.sidebarClickOutsideCloses}
                        onChange={(e) => patch({ sidebarClickOutsideCloses: e.target.checked })}
                      />
                      <span>
                        Click outside to close
                        <em>A click in the editor puts the panel away.</em>
                      </span>
                    </label>
                    <label className="set-inline-check">
                      <input
                        type="checkbox"
                        checked={s.sidebarOverlay}
                        onChange={(e) => patch({ sidebarOverlay: e.target.checked })}
                      />
                      <span>
                        Sidebar as overlay
                        <em>
                          The panel floats over your work. Off docks it in a column of its own,
                          which moves the editor across each time it opens.
                        </em>
                      </span>
                    </label>
                  </div>
                </Item>
              </>
            )}

            {tab === "agents" && (
              <>
                <Item
                  name="Default agent"
                  desc="The CLI the primary Start button launches; you can pick another per ticket."
                >
                  {/* Chips, not cards: picking a CLI is a one-line choice, and
                      the card grid took half the page to say it. */}
                  <div className="agent-chips">
                    {AGENT_CLIS.map((cli) => (
                      <button
                        key={cli.id}
                        className={`agent-chip ${s.defaultAgent === cli.id ? "agent-chip-active" : ""}`}
                        onClick={() => patch({ defaultAgent: cli.id })}
                      >
                        <AgentIcon id={cli.id} size={16} />
                        <span>{cli.name}</span>
                      </button>
                    ))}
                  </div>
                </Item>
                <Item
                  name="CLI commands"
                  desc="What each CLI is called here. Leave blank unless yours was renamed or lives off your PATH."
                >
                  <AgentBinaries
                    value={s.cliBins}
                    onChange={(cliBins) => {
                      patch({ cliBins });
                      // Re-resolve before anything re-renders: the launcher, the
                      // probes and the resume commands all read the registry.
                      refreshAgentClis();
                    }}
                  />
                </Item>
                <Item
                  name="Other CLIs"
                  desc="Agents Canopy ships no entry for. Each one joins the launcher; no installer, and hooks stay yours to wire."
                >
                  <CustomClis
                    value={s.customClis}
                    onChange={(customClis) => {
                      patch({ customClis });
                      refreshAgentClis();
                    }}
                  />
                </Item>
                <Item
                  name="Tools available"
                  desc="What MCP-capable agents running in a Canopy terminal can do through the built-in MCP server. Switching one off removes it from the agent's tool list entirely — it costs no context and can't be called."
                >
                  <div className="tool-groups">
                    <div className="tool-bulk">
                      <span className="tool-count">
                        {ALL_AGENT_TOOLS.length - s.disabledTools.length} of{" "}
                        {ALL_AGENT_TOOLS.length} on
                      </span>
                      <button className="btn btn-small" onClick={() => patch({ disabledTools: [] })}>
                        Enable all
                      </button>
                      <button
                        className="btn btn-small"
                        onClick={() => patch({ disabledTools: [...ALL_AGENT_TOOLS] })}
                      >
                        Disable all
                      </button>
                    </div>
                    {AGENT_TOOL_GROUPS.map((group) => {
                      const off = group.tools.filter((t) => s.disabledTools.includes(t.name));
                      const allOff = off.length === group.tools.length;
                      return (
                        <div key={group.id} className="tool-group">
                          <div className="tool-group-head">
                            <label className="set-inline-check">
                              <input
                                type="checkbox"
                                checked={!allOff}
                                ref={(el) => {
                                  if (el) el.indeterminate = off.length > 0 && !allOff;
                                }}
                                onChange={() => {
                                  const names = group.tools.map((t) => t.name);
                                  patch({
                                    disabledTools: allOff
                                      ? s.disabledTools.filter((n) => !names.includes(n))
                                      : [...new Set([...s.disabledTools, ...names])],
                                  });
                                }}
                              />
                              <span className="tool-group-name">{group.label}</span>
                            </label>
                            <span className="tool-group-blurb">{group.blurb}</span>
                          </div>
                          <div className="tool-list">
                            {group.tools.map((tool) => {
                              const on = !s.disabledTools.includes(tool.name);
                              return (
                                <label key={tool.name} className="tool-row" title={tool.name}>
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    onChange={() =>
                                      patch({
                                        disabledTools: on
                                          ? [...s.disabledTools, tool.name]
                                          : s.disabledTools.filter((n) => n !== tool.name),
                                      })
                                    }
                                  />
                                  <span className="tool-name">{tool.label}</span>
                                  <span className="tool-note">{tool.note}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Item>
                <Item
                  name="Hibernate idle agents"
                  desc="Auto-reclaim memory from idle/ended agents past the limit below; they stay resumable."
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
                  desc="Agent terminals to keep before hibernation reclaims the stalest idle ones."
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
                <Item
                  name="File associations"
                  desc="Which language each file type is highlighted as. Open files re-colour immediately."
                >
                  <FileAssociations
                    value={s.fileAssociations}
                    onChange={(fileAssociations) => patch({ fileAssociations })}
                  />
                </Item>
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
                  desc="Lines of history each terminal keeps; applies to new terminals."
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

            {tab === "dictation" && dictationOk && <DictationSettings />}

            {tab === "remote" && <RemoteSettings runInTerminal={runInTerminal} />}

            {tab === "privacy" && (
              <>
                <Item
                  name="Crash reporting"
                  desc="A crashed panel always offers to file a GitHub issue — public, under your own account, and shown to you in full before anything is sent. This setting governs the other route: an anonymous email to the maintainers with no name attached, which is also what a native crash found on the next launch uses. Either way the report is the error and stack, app version and your OS, and nothing else."
                >
                  <label className="set-inline-check">
                    <input
                      type="checkbox"
                      checked={s.crashReporting}
                      onChange={(e) => patch({ crashReporting: e.target.checked })}
                    />
                    <span>Offer to send anonymous crash reports</span>
                  </label>
                </Item>
              </>
            )}

            {tab === "browser" && (
              <>
                <Item
                  name="Engine"
                  desc="How preview tabs show a page. The embedded browser loads the real URL at its real origin in its own webview, on a profile that persists — log into a site once and you stay logged in, exactly as in Safari. The loopback proxy serves every site from 127.0.0.1 instead, which no session survives, but it is the only engine that exists off macOS."
                >
                  {browserOk ? (
                    <div className="set-checks">
                      <label className="set-inline-check">
                        <input
                          type="radio"
                          name="browser-engine"
                          checked={s.browserEngine === "webview"}
                          onChange={() => patch({ browserEngine: "webview" })}
                        />
                        <span>
                          Embedded browser
                          <em>Real origins, real cookies, sessions that survive a restart.</em>
                        </span>
                      </label>
                      <label className="set-inline-check">
                        <input
                          type="radio"
                          name="browser-engine"
                          checked={s.browserEngine === "proxy"}
                          onChange={() => patch({ browserEngine: "proxy" })}
                        />
                        <span>
                          Loopback proxy
                          <em>The older engine. No sessions, but it logs every request it forwards.</em>
                        </span>
                      </label>
                      <p className="set-item-desc">
                        Preview tabs already open keep the engine they started on; reopen them to
                        switch.
                      </p>
                    </div>
                  ) : (
                    <p className="set-item-desc">
                      This build runs preview tabs through the loopback proxy. The embedded browser
                      is macOS-only so far.
                    </p>
                  )}
                </Item>
                {browserOk && (
                  <Item
                    name="Layering (experimental)"
                    desc="How the embedded browser sits against the app. Overlay floats the page above the window and freezes it behind a still whenever a panel or menu opens over it. Punch-through puts the page underneath instead, so panels and menus genuinely slide over the live page — new, and still being proven."
                  >
                    <div className="set-checks">
                      <label className="set-inline-check">
                        <input
                          type="radio"
                          name="browser-layering"
                          checked={s.browserLayering !== "punch"}
                          onChange={() => patch({ browserLayering: "overlay" })}
                        />
                        <span>
                          Overlay
                          <em>The shipped behaviour: hide under overlays, show a freeze-frame.</em>
                        </span>
                      </label>
                      <label className="set-inline-check">
                        <input
                          type="radio"
                          name="browser-layering"
                          checked={s.browserLayering === "punch"}
                          onChange={() => patch({ browserLayering: "punch" })}
                        />
                        <span>
                          Punch-through
                          <em>The live page stays visible under panels and menus.</em>
                        </span>
                      </label>
                    </div>
                  </Item>
                )}
                <Item
                  name="Browsing data"
                  desc="One profile is shared by every preview tab, which is what keeps you signed in across them — so clearing it signs you out of everything at once, like a browser's own “clear browsing data”. Cookies, local storage and caches; nothing else on this machine is touched."
                >
                  <div className="set-inline">
                    <button
                      className="btn"
                      disabled={!browserOk || clearing === "busy"}
                      onClick={() => {
                        setClearing("busy");
                        void ipc.browserClearData().then(
                          () => setClearing("done"),
                          (err) => setClearing(String(err)),
                        );
                      }}
                    >
                      {clearing === "busy" ? "Clearing…" : "Clear browsing data"}
                    </button>
                    {clearing === "done" && (
                      <span className="set-item-desc">Cleared. Reload any open page to see it.</span>
                    )}
                    {typeof clearing === "string" && clearing !== "busy" && clearing !== "done" && (
                      <span className="set-item-desc">{clearing}</span>
                    )}
                  </div>
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

function CopyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
function RefreshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

/** An on/off switch. */
function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      style={{
        width: 40,
        height: 23,
        borderRadius: 12,
        border: "none",
        padding: 3,
        cursor: "pointer",
        flex: "none",
        background: checked ? "var(--accent)" : "var(--border)",
        transition: "background .15s",
      }}
    >
      <span
        style={{
          display: "block",
          width: 17,
          height: 17,
          borderRadius: "50%",
          background: "#fff",
          transform: checked ? "translateX(17px)" : "translateX(0)",
          transition: "transform .15s",
        }}
      />
    </button>
  );
}

/** A click-to-copy pill: shows the value and a copy/✓ icon. */
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
          fontSize: big ? 17 : 13,
          letterSpacing: big ? 3 : 0,
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
          display: "inline-flex",
          opacity: copied ? 1 : 0.55,
          color: copied ? "var(--accent, #7aa2f7)" : "inherit",
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
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
  /** Whether the public URL stays the same across sessions. Quick tunnels
   *  (Cloudflare) and a bare ngrok agent hand out a fresh random name every run;
   *  Tailscale Funnel's name is tied to the machine, so it persists. */
  fixed: boolean;
  install: Record<"macos" | "windows" | "linux", string>;
}[] = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    bin: "cloudflared",
    needsToken: false,
    blurb: "No account — an instant https:// link. Recommended.",
    fixed: false,
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
    fixed: false,
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
    fixed: true,
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
  // Reach + provider are UI selections that outlive this dialog, so they read
  // from and write back to persisted settings — otherwise reopening Settings
  // dropped "Internet" back to "This network" even while the tunnel ran on.
  const [scope, setScope] = useState<"local" | "internet">(() => getSettings().remoteReach);
  const [provider, setProvider] = useState(() => getSettings().remoteTunnelProvider);
  const changeScope = (v: "local" | "internet") => {
    setScope(v);
    updateSettings({ remoteReach: v });
  };
  const changeProvider = (v: string) => {
    setProvider(v);
    updateSettings({ remoteTunnelProvider: v });
  };
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
  // The portal is served under /remote, so a tunnel's bare URL needs the path
  // appended or it 404s at the domain root. The URL/QR only belong to the
  // SELECTED provider — switching tabs to one that isn't running shows no link.
  const withRemote = (u: string) => (u.endsWith("/remote") ? u : `${u.replace(/\/+$/, "")}/remote`);
  const tunnelForProvider = tunnel.provider === provider;
  const tunnelUrl =
    tunnelForProvider && tunnel.running && tunnel.url ? withRemote(tunnel.url) : null;
  const activeUrl = scope === "internet" ? tunnelUrl : lanUrl;

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

  const seg = (opts: { id: string; label: string }[], value: string, onChange: (v: string) => void) => (
    <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          style={{
            padding: "5px 13px",
            border: "none",
            cursor: "pointer",
            fontSize: 13,
            background: value === o.id ? "var(--accent)" : "transparent",
            color: value === o.id ? "var(--on-accent)" : "var(--text)",
            fontWeight: 600,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
  const iconBtn = {
    background: "var(--bg-raised)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "8px 9px",
    color: "var(--text)",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
  } as const;

  return (
    <>
      <Item name="Remote access" desc="Drive your agents from your phone. A PIN unlocks a control panel; off by default.">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Toggle checked={on} disabled={busy} onChange={() => run(on ? ipc.remoteDisable : ipc.remoteEnable)} />
          {on && (
            <span style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.35, maxWidth: 460 }}>
              ⚠ Anyone with the PIN can drive your agents — turn off when you're done.
            </span>
          )}
        </div>
      </Item>

      {on && (
        <>
          <Item name="Reach">
            {seg(
              [
                { id: "local", label: "This network" },
                { id: "internet", label: "Internet" },
              ],
              scope,
              (v) => changeScope(v as "local" | "internet"),
            )}
          </Item>

          {scope === "internet" && (
            <Item name="Public link" desc="One tunnel, loads in any browser — shared with internet team sessions.">
              <div style={{ display: "grid", gap: 12, justifyItems: "start", width: "100%" }}>
                {seg(TUNNELS.map((t) => ({ id: t.id, label: t.name })), provider, changeProvider)}
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {prov.note ? `${prov.blurb} ${prov.note}` : prov.blurb}
                </div>
                {/* Whether the link survives a restart — the thing people trip
                    on when they bookmark a quick-tunnel URL and it 404s next
                    session. */}
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {prov.fixed
                    ? "🔗 Same link every session — safe to bookmark."
                    : "↻ A new link each session. For one that stays the same, use Tailscale Funnel."}
                </div>

                {prov.needsToken && (
                  <input
                    type="password"
                    className="set-wide"
                    placeholder={prov.tokenHelp ?? "ngrok authtoken"}
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      setTrackerKey("ngrok", e.target.value.trim());
                    }}
                    style={{ maxWidth: 380 }}
                  />
                )}

                {!provInstalled ? (
                  <button className="btn" onClick={() => runInTerminal(prov.install[currentPlatform()], `Install ${prov.name}`)}>
                    Install {prov.name}
                  </button>
                ) : tunnel.running && tunnel.provider === provider ? (
                  <button className="btn" disabled={busy} onClick={stopTunnel}>
                    Stop public link
                  </button>
                ) : (
                  <button className="btn" disabled={busy || (prov.needsToken && !token.trim())} onClick={startTunnel}>
                    Start public link
                  </button>
                )}

                {tunnel.message && tunnelForProvider && (
                  <div style={{ fontSize: 12, color: tunnel.running ? "var(--text-dim)" : "var(--danger)", whiteSpace: "pre-wrap", maxWidth: 460, fontFamily: tunnel.running ? undefined : "ui-monospace, monospace" }}>
                    {tunnel.message}
                  </div>
                )}
              </div>
            </Item>
          )}

          {activeUrl && (
            <Item
              name="Scan to connect"
              desc={
                scope === "local"
                  ? "Scan, then enter the PIN."
                  : "Scan from anywhere, then enter the PIN."
              }
            >
              <div className="set-inline" style={{ alignItems: "center", gap: 18 }}>
                {qr && (
                  <div
                    style={{ width: 128, height: 128, padding: 7, background: "#fff", borderRadius: 10, flex: "none" }}
                    dangerouslySetInnerHTML={{ __html: qr }}
                  />
                )}
                <div style={{ display: "grid", gap: 12, minWidth: 0, flex: 1 }}>
                  <div>
                    <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 5 }}>PIN</div>
                    <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
                      <Copyable text={status?.pin ?? ""} big />
                      <button
                        style={{ ...iconBtn, padding: "0 12px" }}
                        title="Generate a new PIN"
                        disabled={busy}
                        onClick={() => run(ipc.remoteRotatePin)}
                      >
                        <RefreshIcon />
                      </button>
                    </div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 5 }}>Address</div>
                    <Copyable text={activeUrl} />
                  </div>
                </div>
              </div>
            </Item>
          )}
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
        desc="Press to start dictating, again to insert; Esc cancels. Runs fully locally."
      >
        <HotkeyCapture value={s.dictationHotkey} onChange={(h) => patch({ dictationHotkey: h })} />
      </Item>

      <Item
        name="Model"
        desc="Local speech model; larger is more accurate, Moonshine fastest for English."
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
