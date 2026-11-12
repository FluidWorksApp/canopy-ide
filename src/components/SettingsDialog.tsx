// The one settings surface, VS Code-style: section nav on the left; each
// setting stacks name → description → control (side-by-side rows squeezed
// long labels into slivers and pushed wide control groups out of the modal).
// Skins render as rich choices — a palette is a thing you look at, not a word
// you read.
import { RulesSettings, type RulesSettingsProject } from "./RulesSettings";
import { BrainConnectPanel } from "./BrainConnect";
import { BrainSpendTable } from "./BrainChip";
import { BrainAutomation, BrainExceptions } from "./BrainSettings";
import { accountSummary, cliLoginText, signedInClis } from "../accountState";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useContext,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  applyTheme,
  THEME_CHANGE_EVENT,
  getSettings,
  updateSettings,
  THEMES,
  formatHotkey,
  modKeyLabel,
  TERMINAL_SCROLLBACK_MAX_ROWS,
  TERMINAL_SCROLLBACK_MIN_ROWS,
  DEFAULT_DICTATION_HOTKEY,
  DICTATION_WAVE_STYLES,
  type CursorStyle,
  type DictationModKey,
  type DictationTriggerMode,
  type DictationWaveStyle,
  type Hotkey,
  type Settings,
  type TabSwitchMode,
  type Theme,
} from "../settings";
import { skinDef } from "../skins/registry";
import { MASCOTS, mascotDef } from "../mascots";
import {
  COMPANION_AUTHORITIES,
  companionCli,
  forgetCompanionSession,
  tierNote,
} from "../companion";
import { clearCompanionView, clearRun } from "../companionSession";
import { Mascot } from "./Mascot";
import { Button, Checkbox, Field, Row, Segmented, Select, Stepper, Switch, TextInput } from "./ui";
import { notOnServerYet, serverFeatureError } from "../accountErrors";
import { peekTeamIdentity, subscribeTeamIdentity, teamIdentity, type TeamIdentity } from "../teamIdentity";

import { CANOPY_LINK } from "../internetLink";
import "./receipts.css";
import { drawWave } from "../waveStyles";
import { useEscape, useEscapeLayer } from "../useEscape";
import { SettingsSearch } from "./SettingsSearch";
import { settingAnchor, type SettingHit } from "./settingsIndex";
import { SettingsNavContext } from "./settingsNav";
import { TRACKERS, setTrackerKey, trackerKey } from "../trackers";
import * as ipc from "../ipc";
import { TailscaleStatus } from "./TailscaleStatus";
import { AcpProviderPicker } from "./AcpProviderPicker";
import { partitionBuiltins } from "../agentCliVisibility";
import { registerConnectorIcon } from "../acp/connectorIcons";
import { AcpAgentToggle } from "./AcpAgentToggle";
import { joinArgv, splitArgv } from "../acp/providers";
import { SlackSettings } from "./SlackSettings";
import { VaultSettings } from "./VaultSettings";
import { availableMonoFonts, fontLabel, fontStack } from "../fonts";
import {
  AgentIcon,
  CheckIcon,
  ChevronIcon,
  CopyIcon,
  RestartIcon,
  TrackerIcon,
} from "./icons";
import {
  AGENT_CLIS,
  AGENT_CLIS_CHANGED_EVENT,
  agentCliFor,
  agentModelSwitchFor,
  binName,
  BUILTIN_AGENT_CLIS,
  checkInstalledClis,
  CLI_INSTALLS_CHANGED_EVENT,
  currentPlatform,
  customCliIssue,
  namesArguments,
  newCustomCliId,
  refreshAgentClis,
  type AgentCli,
  type AgentCliDef,
  type CustomAgentCli,
} from "../projects";
import {
  inspectFleetTable,
  type FleetRouteSnapshot,
} from "../fleetSnapshot";
import { FleetReadinessPanel } from "./FleetReadinessPanel";
import { AgentMemorySettings } from "./AgentMemorySettings";
import {OrganizationSettings} from "./OrganizationSettings";
import { AccountSettings } from "./AccountSettings";
import {
  loginCommand,
  supportsProfiles,
  PROFILE_CHANGE_EVENT,
} from "../profiles";
import { AGENT_TOOL_GROUPS, ALL_AGENT_TOOLS } from "../agentTools";
import { spotSources } from "../spotSources";
import * as clipboardStore from "../clipboardStore";
import { INDEXABLE_AGENTS, fmtBytes, runIngest } from "../spotIndex";
import {
  BUILTIN_MAP,
  EXTRA_ASSOCIATIONS,
  LANGUAGES,
  describePattern,
  languageLabel,
  normalizePattern,
} from "../fileAssociations";
import {
  format,
  formatChord,
  modifierOnly,
  resolve,
  SHORTCUT_PROFILES,
  type ShortcutProfile,
} from "../shortcuts";
import {
  SESSION_NAME_THEMES,
  sessionNameThemeDef,
  type SessionNameTheme,
} from "../sessionNameThemes";

export type SettingsTab =
  | "account"
  | "teams"
  | "appearance"
  | "agents"
  | "brain"
  | "sessions"
  | "notifications"
  | "mascot"
  | "editor"
  | "terminal"
  | "spotsearch"
  | "clipboard"
  | "dictation"
  | "integrations"
  | "browser"
  | "remote"
  | "vault"
  | "privacy"
  | "rules";

interface SettingsDialogProps {
  onClose: () => void;
  initialTab?: SettingsTab;
  /** Every project, for the Rules tab (RulesSettings.tsx). */
  projects?: readonly RulesSettingsProject[];
  /** Open one project's Rules panel. */
  onOpenRules?: (projectId: string, cwd: string) => void;
}

/** Ordered, and grouped by what you came here to change: how it looks, what
 *  the agents do, what reaches out of this machine. A dozen flat entries was a
 *  list you had to read end to end; three headings turn it into three short
 *  ones you can skip.
 *
 *  Mascot sits in Agents, not Look: the face is only half of it — the other
 *  half turns that face into a companion that runs a CLI, which is a question
 *  about agents rather than about colours. */
const TABS: { id: SettingsTab; label: string; group: string }[] = [
  { id: "account", label: "Accounts", group: "Your account" },
  { id: "teams", label: "Teams", group: "Your account" },
  { id: "appearance", label: "Appearance", group: "Look & feel" },
  { id: "editor", label: "Editor", group: "Look & feel" },
  { id: "terminal", label: "Terminal", group: "Look & feel" },
  { id: "mascot", label: "Mascot", group: "Look & feel" },
  { id: "notifications", label: "Notifications", group: "Look & feel" },
  { id: "agents", label: "Agents", group: "Agents" },
  { id: "brain", label: "Brain & memory", group: "Agents" },
  { id: "sessions", label: "Sessions & budget", group: "Agents" },
  { id: "rules", label: "Rules", group: "Agents" },
  { id: "dictation", label: "Dictation", group: "Input & tools" },
  { id: "spotsearch", label: "SpotSearch", group: "Input & tools" },
  { id: "clipboard", label: "Clipboard", group: "Input & tools" },
  { id: "integrations", label: "Integrations", group: "Access" },
  { id: "browser", label: "Browser & Vault", group: "Access" },
  { id: "remote", label: "Remote access", group: "Access" },
  { id: "privacy", label: "Privacy", group: "Access" },
];

const CURSOR_OPTIONS: { id: CursorStyle; label: string }[] = [
  { id: "block", label: "Block" },
  { id: "underline", label: "Underline" },
  { id: "bar", label: "Bar" },
];

/** The preview must show a skin's palette without applying it, so every skin
 *  carries its own three swatches in src/skins/<id>.ts. Only the two ids that
 *  isn't a skin is spelled out here: Auto previews as a split card — Gotham
 *  when the OS is dark, Daylight when light. */
const NON_SKIN_PREVIEWS: Record<
  "auto",
  { bg: string; raised: string; text: string; accent?: string; note: string }
> = {
  // The two halves are what Auto actually resolves to: Gotham in dark, Daylight
  // in light. See resolveTheme().
  auto: {
    bg: "linear-gradient(105deg, #0d0f12 50%, #f5f6f8 50%)",
    raised: "#171b20",
    text: "#f5f6f8",
    accent: "#d4af37",
    note: "follows the OS",
  },
};

function skinPreview(id: Theme) {
  if (id === "auto") return NON_SKIN_PREVIEWS[id];
  const s = skinDef(id);
  return { ...s.preview, note: s.note };
}

function SkinChoice({ theme, accent }: { theme: Theme; accent: string }) {
  const p = skinPreview(theme);
  return (
    <>
      <span className="skin-preview" style={{ background: p.bg }} aria-hidden="true">
        <span className="skin-preview-panel" style={{ background: p.raised }}>
          <span className="skin-preview-accent" style={{ background: accent || p.accent }} />
          <span className="skin-preview-copy">
            <span className="skin-preview-line" style={{ background: p.text }} />
            <span className="skin-preview-line short" style={{ background: p.text }} />
          </span>
        </span>
      </span>
      <span className="skin-copy">
        <span className="skin-name">{THEMES.find((t) => t.id === theme)?.label}</span>
        <span className="skin-note">{p.note}</span>
      </span>
    </>
  );
}

function SkinPicker({
  value,
  accent,
  open,
  trigger,
  onOpenChange,
  onChange,
}: {
  value: Theme;
  accent: string;
  open: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  onChange: (theme: Theme) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(0, THEMES.findIndex((t) => t.id === value));

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) onOpenChange(false);
    };
    window.addEventListener("mousedown", away);
    requestAnimationFrame(() => options.current[selected]?.focus());
    return () => window.removeEventListener("mousedown", away);
  }, [onOpenChange, open, selected]);

  const move = (from: number, by: number) => {
    const next = (from + by + THEMES.length) % THEMES.length;
    options.current[next]?.focus();
  };

  return (
    <div className="skin-select" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className={`skin-select-trigger${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          onOpenChange(true);
        }}
      >
        <SkinChoice theme={value} accent={accent} />
        <ChevronIcon size={16} className="skin-select-chevron" />
      </button>
      {open && (
        <div className="skin-select-menu" role="listbox" aria-label="Skin">
          {THEMES.map((theme, i) => (
            <button
              key={theme.id}
              ref={(node) => {
                options.current[i] = node;
              }}
              type="button"
              role="option"
              aria-selected={theme.id === value}
              className={`skin-select-option${theme.id === value ? " selected" : ""}`}
              onClick={() => {
                onChange(theme.id);
                onOpenChange(false);
                trigger.current?.focus();
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                  e.preventDefault();
                  move(i, 1);
                } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  move(i, -1);
                } else if (e.key === "Home" || e.key === "End") {
                  e.preventDefault();
                  options.current[e.key === "Home" ? 0 : THEMES.length - 1]?.focus();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onOpenChange(false);
                  trigger.current?.focus();
                }
              }}
            >
              <SkinChoice theme={theme.id} accent={accent} />
              <span className="skin-select-check" aria-hidden="true">
                {theme.id === value && <CheckIcon size={15} />}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Turning the mascot into a companion.
 *
 * ONE section, not one per control. Every field here is part of a single
 * decision — "should that face be an assistant, and on what terms" — and split
 * across five stacked sections it read as five unrelated settings and pushed
 * everything below it off the screen. Related controls that each need a few
 * characters belong on a row (see Field/Row); the authority choice is a
 * segmented control rather than three labelled radios for the same reason.
 *
 * Lives under the mascot picker, in the Mascot section, because the question it
 * answers is "what is that face doing on my screen" — and the CLI it runs on is
 * a detail of *this* choice, not another entry in the Agents list of CLIs that
 * write code.
 */
function CompanionSettings({
  s,
  patch,
}: {
  s: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    void checkInstalledClis().then(setInstalled);
  }, []);
  const usable = AGENT_CLIS.filter((c) => installed[c.bin]);
  // The same resolver the session uses, so this row can never show one CLI
  // while the companion runs on another.
  const chosen = companionCli((bin) => Boolean(installed[bin]));
  const models = chosen ? agentModelSwitchFor(chosen.id) : undefined;
  const name = s.companionName.trim() || mascotDef(s.mascot).label;
  const authority = COMPANION_AUTHORITIES.find((a) => a.id === s.companionAuthority);

  return (
    <>
      <Item
        name={`${name} as a companion`}
        tag="Starts an agent"
        desc={`A floating assistant across every project.`}
      >
        <Row>
          <Switch
            checked={s.companionEnabled}
            onChange={(v) => patch({ companionEnabled: v })}
            aria-label={`Enable ${name} as a companion`}
          />
          <span className="set-item-desc">
            {s.companionEnabled
              ? `Notices arrive from ${name}.${chosen ? ` ${tierNote(chosen.id)}` : ""}`
              : "Off."}
          </span>
        </Row>

        {s.companionEnabled && (
          <>
            <Row className="set-gap">
              <Field label="Name">
                <TextInput
                  width="sm"
                  value={s.companionName}
                  placeholder={mascotDef(s.mascot).label}
                  aria-label="Companion name"
                  onChange={(e) => patch({ companionName: e.target.value })}
                />
              </Field>
              <Field label="Agent">
                <Select
                  width="sm"
                  value={chosen?.id ?? ""}
                  aria-label="Companion agent"
                  onChange={(e) => patch({ companionCli: e.target.value, companionModel: "" })}
                >
                  {usable.length === 0 && <option value="">None installed</option>}
                  {usable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Model">
                {models?.kind === "inline" ? (
                  <Select
                    width="md"
                    value={s.companionModel}
                    aria-label="Companion model"
                    onChange={(e) => patch({ companionModel: e.target.value })}
                  >
                    <option value="">{chosen?.name ?? "Agent"} default</option>
                    {models.choices.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} — {m.hint}
                      </option>
                    ))}
                  </Select>
                ) : (
                  // A CLI whose catalogue is per-account has no list Canopy can
                  // be right about (see agentModels.ts), so it is not offered one.
                  <span className="set-item-desc">{chosen ? "Chosen by the agent" : "—"}</span>
                )}
              </Field>
              <Field label="It may">
                <span className="set-inline">
                  <Segmented
                    options={COMPANION_AUTHORITIES.map((a) => ({ id: a.id, label: a.label }))}
                    value={s.companionAuthority}
                    onChange={(id) => patch({ companionAuthority: id })}
                    aria-label="What the companion may do"
                  />
                  <span className="set-item-desc">{authority?.note}</span>
                </span>
              </Field>
              <Field label=" ">
                <Button
                  onClick={() => {
                    if (!chosen) return;
                    forgetCompanionSession(chosen.id);
                    clearRun(chosen.id);
                    clearCompanionView();
                  }}
                  disabled={!chosen}
                  title={`Forget this conversation with ${name}. Not undoable.`}
                >
                  Start over
                </Button>
              </Field>
            </Row>
            <BrainExceptions only="Companion" />
          </>
        )}
      </Item>
      {s.companionEnabled && <SlackSettings companion={name} />}
    </>
  );
}

function Item({
  name,
  tag,
  desc,
  children,
}: {
  name: string;
  /** Small caps note beside the title, for the one thing worth knowing before
   *  you touch the control — "applies immediately", "needs a restart". */
  tag?: string;
  desc?: string;
  children: React.ReactNode;
}) {
  // Which tab this row is on, from the dialog: names repeat across tabs, so the
  // anchor a search result scrolls to is tab + name.
  const nav = useContext(SettingsNavContext);
  const id = nav.tab ? settingAnchor(nav.tab, name) : undefined;
  return (
    <div className={`set-item${id && nav.highlight === id ? " set-item-flash" : ""}`} id={id}>
      <div className="set-item-head">
        <span className="set-item-name">{name}</span>
        {tag && <span className="set-item-tag">{tag}</span>}
      </div>
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

  const picker = (
    current: string,
    onPick: (id: string) => void,
    width: "sm" | "md" = "md",
  ) => (
    <Select width={width} value={current} onChange={(e) => onPick(e.target.value)}>
      {LANGUAGES.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </Select>
  );

  const row = (p: string, lang: string, shipped: string | null) => (
    <div key={p} className="assoc-row">
      <code className="assoc-pattern">{describePattern(p)}</code>
      {picker(lang, (id) => (shipped === id ? clear(p) : set(p, id)))}
      {shipped == null ? (
        <Button size="sm" onClick={() => clear(p)} title="Remove this mapping">
          Remove
        </Button>
      ) : value[p] != null ? (
        <Button size="sm" onClick={() => clear(p)} title={`Back to ${languageLabel(shipped)}`}>
          Reset
        </Button>
      ) : (
        <span className="assoc-spacer" />
      )}
    </div>
  );

  return (
    <div className="assoc">
      <div className="assoc-add">
        <Select
          width="sm"
          value={kind}
          onChange={(e) => setKind(e.target.value as "ext" | "name")}
        >
          <option value="ext">Extension</option>
          <option value="name">File name</option>
        </Select>
        <TextInput
          width="md"
          placeholder={kind === "ext" ? "astro" : "Dockerfile.*"}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <span className="assoc-arrow">→</span>
        {picker(language, setLanguage, "sm")}
        <Button variant="accent" onClick={add}>
          Add
        </Button>
      </div>
      {error && <div className="assoc-error">{error}</div>}
      <TextInput
        search
        width="full"
        placeholder="Search mappings…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="assoc-list">
        {custom.length > 0 && (
          <div className="assoc-group">
            <div className="assoc-group-name">Your mappings</div>
            <div className="assoc-group-blurb">
              Checked before every shipped grammar.
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
  /** The install probe failed: every CLI is then shown as unknown rather than
   *  hidden for good. */
  const [probeFailed, setProbeFailed] = useState(false);
  /** Rows whose last entry named arguments rather than an executable — kept out
   *  of the stored overrides, and said out loud instead of probed. */
  const [rejected, setRejected] = useState<Record<string, boolean>>({});
  /** CLIs added by hand from the list this session. */
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  /** Sign-in state per CLI in the default account, where Canopy can read it. */
  const [logins, setLogins] = useState<Record<string, ipc.AccountStatus>>({});
  useEffect(() => {
    let stale = false;
    void ipc
      .profilesList()
      .then((ps) => ps.find((p) => !p.removable) ?? ps[0])
      .then((p) => (p ? ipc.profileAccounts(p.id) : []))
      .then((rows) => {
        if (!stale) setLogins(Object.fromEntries(rows.map((r) => [r.agent, r])));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  // Probe the resolved binaries — AGENT_CLIS already carries the overrides.
  // Keyed on the overrides' *contents*: `updateSettings` rebuilds the settings
  // object on every write, so once any override is stored, depending on the
  // object's identity would spawn a login shell — the costly part of the probe
  // — for every unrelated toggle on this tab.
  const overridesKey = JSON.stringify(value);
  useEffect(() => {
    void ipc
      .whichCheck(AGENT_CLIS.map((c) => c.bin))
      .then((result) => {
        setFound(result);
        setProbeFailed(false);
      })
      .catch(() => setProbeFailed(true));
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
    // Emptying a row's path must not make the row vanish under the cursor.
    setRevealed((r) => new Set([...r, def.id]));
    const next = { ...value };
    // An empty box, or the vendor's own name typed back in, is not an override
    // — storing it would pin the entry to a name that may change in a later
    // release of Canopy.
    if (typed && typed !== def.bin) next[def.id] = typed;
    else delete next[def.id];
    setDrafts((d) => ({ ...d, [def.id]: typed }));
    onChange(next);
  };

  const { shown: probed_shown, hidden: probed_hidden } = partitionBuiltins([...BUILTIN_AGENT_CLIS], {
    found,
    overrides: value,
    revealed,
    resolveBin: (def) => agentCliFor(def.id)?.bin ?? def.bin,
  });
  // A failed probe means nothing is known about any CLI: show them all so one
  // can still be set up, rather than leaving the list empty with no way to add.
  const shown = probeFailed ? [...BUILTIN_AGENT_CLIS] : probed_shown;
  const hidden = probeFailed ? [] : probed_hidden;
  const probed = probeFailed || Object.keys(found).length > 0;

  return (
    <div className="cli-bins">
      {!probed && <div className="cli-custom-hint" role="status">Looking for your agents…</div>}
      {probed && shown.length === 0 && (
        <div className="cli-custom-hint" role="status">
          No agent CLIs found on this computer. Add one below.
        </div>
      )}
      {shown.map((def) => {
        const resolved = agentCliFor(def.id);
        const bin = resolved?.bin ?? def.bin;
        const state = found[bin];
        return (
          <div key={def.id} className="cli-bin-row">
            <label className="cli-bin-name" htmlFor={`cli-bin-${def.id}`}>
              <AgentIcon id={def.id} size={16} />
              <span>{def.name}</span>
              {state && logins[def.id] && (() => {
                const login = cliLoginText(logins[def.id], def.name);
                // "—" is Canopy saying it cannot read this CLI's login; say nothing.
                if (login.text === "—") return null;
                return (
                  <span
                    className={`cli-login-dot ${login.signedIn ? "cli-login-dot-on" : "cli-login-dot-off"}`}
                    role="img"
                    aria-label={login.signedIn ? "signed in" : "not signed in"}
                    title={login.title || (login.signedIn ? "Signed in" : "Not signed in")}
                  />
                );
              })()}
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
      {probed && hidden.length > 0 && (
        <label className="cli-bin-add">
          <span className="cli-custom-hint">Not on your PATH:</span>
          <select
            aria-label="Add an agent CLI"
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id) setRevealed((r) => new Set([...r, id]));
            }}
          >
            <option value="">＋ Add an agent CLI…</option>
            {hidden.map((def) => (
              <option key={def.id} value={def.id}>
                {def.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function AgentFleetReadout({
  open,
  trigger,
  onOpenChange,
}: {
  open: boolean;
  trigger: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
}) {
  const [rows, setRows] = useState<FleetRouteSnapshot[]>([]);
  const [profiles, setProfiles] = useState<ipc.AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshSeq = useRef(0);

  const refresh = useCallback(() => {
    const seq = ++refreshSeq.current;
    setLoading(true);
    setError(null);
    void Promise.all([checkInstalledClis(), ipc.profilesList()])
      .then(([installed, nextProfiles]) =>
        inspectFleetTable(AGENT_CLIS, nextProfiles, installed).then((nextRows) => ({
          nextProfiles,
          nextRows,
        })),
      )
      .then(({ nextProfiles, nextRows }) => {
        if (seq !== refreshSeq.current) return;
        setProfiles(nextProfiles);
        setRows(nextRows);
      })
      .catch((reason: unknown) => {
        if (seq === refreshSeq.current) setError(String(reason));
      })
      .finally(() => {
        if (seq === refreshSeq.current) setLoading(false);
      });
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    window.addEventListener(PROFILE_CHANGE_EVENT, refresh);
    window.addEventListener(AGENT_CLIS_CHANGED_EVENT, refresh);
    window.addEventListener(CLI_INSTALLS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void ipc.onIntegrationHealth(refresh).then((off) => {
      if (disposed) off();
      else unlisten = off;
    }).catch(() => {});
    return () => {
      disposed = true;
      refreshSeq.current += 1;
      window.removeEventListener(PROFILE_CHANGE_EVENT, refresh);
      window.removeEventListener(AGENT_CLIS_CHANGED_EVENT, refresh);
      window.removeEventListener(CLI_INSTALLS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
      unlisten?.();
    };
  }, [refresh]);

  return (
    <FleetReadinessPanel
      rows={rows}
      profiles={profiles}
      loading={loading}
      error={error}
      open={open}
      trigger={trigger}
      onOpenChange={onOpenChange}
    />
  );
}

/**
 * Account profiles: more than one login per CLI.
 *
 * Canopy never sees a token — signing in happens in a terminal, in the CLI's
 * own browser flow, against the profile's config dir. Hence no "paste your
 * key" field here. Only CLIs with a config-home variable can hold one.
 */
export function AgentAccounts({
  onRunInTerminal,
}: {
  onRunInTerminal: (
    command: string,
    title: string,
    env: [string, string][],
    profile: string,
  ) => void;
}) {
  const [profiles, setProfiles] = useState<ipc.AgentProfile[]>([]);
  // Who each profile is signed in as, keyed by id.
  const [accounts, setAccounts] = useState<
    Record<string, ipc.AccountStatus[]>
  >({});
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** Which account rows are unfolded. Folded is the default and nothing is
   *  persisted: this is a reading position, not a preference. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    void ipc
      .profilesList()
      .then((list) => {
        setProfiles(list);
        for (const p of list) {
          void ipc
            .profileAccounts(p.id)
            .then((a) => setAccounts((prev) => ({ ...prev, [p.id]: a })))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  // The dialog closes to open the sign-in terminal, so re-read on focus.
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const [rotation, setRotation] = useState(() => getSettings().accountRotation);

  const create = () => {
    const label = draft.trim();
    if (!label || busy) return;
    setBusy(true);
    setNote(null);
    void ipc
      .profileCreate(label)
      .then((p) => {
        setDraft("");
        refresh();
        // Open it: signing in is the next step, and those buttons are inside.
        setExpanded((prev) => ({ ...prev, [p.id]: true }));
        // So open launchers pick it up.
        window.dispatchEvent(new CustomEvent(PROFILE_CHANGE_EVENT));
        setNote(
          `Created "${p.label}". Sign it in below.`,
        );
      })
      .catch((e: unknown) => setNote(String(e)))
      .finally(() => setBusy(false));
  };

  const remove = (p: ipc.AgentProfile) => {
    setBusy(true);
    void ipc
      .profileDelete(p.id)
      .then((where) => {
        refresh();
        window.dispatchEvent(new CustomEvent(PROFILE_CHANGE_EVENT));
        // The opposite of what "remove" usually means — say so.
        setNote(`Removed "${p.label}". Its login is still on disk at ${where}.`);
      })
      .catch((e: unknown) => setNote(String(e)))
      .finally(() => setBusy(false));
  };

  const signIn = (p: ipc.AgentProfile, cli: AgentCli) => {
    void ipc
      .profileEnv(cli.id, p.id)
      .then((env) =>
        onRunInTerminal(loginCommand(cli.bin), `${cli.name} — ${p.label}`, env, p.id),
      )
      .catch((e: unknown) => setNote(String(e)));
  };

  const capable = AGENT_CLIS.filter((c) => supportsProfiles(c.id));

  return (
    <div className="cli-accounts">
      <Row>
        <Switch
          checked={rotation}
          aria-label="Rotate accounts at limits"
          onChange={(on) => { setRotation(on); updateSettings({ accountRotation: on }); }}
        />
        <span className="set-item-desc">
          {rotation
            ? "At a limit, a session moves to the next signed-in account."
            : "Off. Sessions stop at their limit."}
        </span>
      </Row>
      <div className="cli-account-new">
        <input
          className="cli-bin-input"
          type="text"
          placeholder="Work, Personal, Client X…"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              create();
            }
          }}
        />
        <Button onClick={create} disabled={busy || !draft.trim()}>
          Add account
        </Button>
      </div>
      {note && <p className="cli-account-note">{note}</p>}

      {profiles.map((p) => {
        // Folded by default: four CLI rows per account is a page of settings,
        // and the summary line already answers "who is in this one".
        const isOpen = expanded[p.id] ?? false;
        // Emails where the store names one, else the CLI — the same CLIs the
        // status-bar switcher lists (src/accountState.ts).
        const held = signedInClis(accounts[p.id]);
        const summary = held.length
          ? held
              .map((agent) => accounts[p.id]?.find((a) => a.agent === agent)?.account ?? agent)
              .join(" · ")
          : accounts[p.id]
            ? accountSummary(accounts[p.id])
            : "checking…";
        return (
        <div key={p.id} className={`cli-account-row ${isOpen ? "is-open" : ""}`}>
          <div
            className="cli-account-head"
            onClick={() =>
              setExpanded((prev) => ({ ...prev, [p.id]: !isOpen }))
            }
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setExpanded((prev) => ({ ...prev, [p.id]: !isOpen }));
              }
            }}
            title={isOpen ? "Collapse" : "Show which CLIs this account is signed into"}
          >
            <span className="cli-account-caret">{isOpen ? "▾" : "▸"}</span>
            <span className="cli-account-name">{p.label}</span>
            {/* Who is in this account, without expanding it. */}
            <span className="cli-account-summary">
              {summary}
            </span>
            {!p.removable && <span className="cli-account-tag">in use everywhere</span>}
            {p.removable && (
              <Button
                size="sm"
                onClick={(e) => {
                  // The head is a fold toggle.
                  e.stopPropagation();
                  remove(p);
                }}
                disabled={busy}
                title="Forget this account. Its files, including the login, stay on disk."
              >
                Remove
              </Button>
            )}
          </div>
          {isOpen && (
          <>
          <div className="cli-account-path" title={p.root}>
            {p.root}
          </div>
          {/* One row per CLI, showing the account it holds. */}
          <div className="cli-account-clis">
            {capable.map((cli) => {
              const st = (accounts[p.id] ?? []).find((a) => a.agent === cli.id);
              const login = cliLoginText(st, cli.name);
              const signedIn = login.signedIn;
              return (
                <div key={cli.id} className="cli-account-cli">
                  <AgentIcon id={cli.id} size={13} />
                  <span className="cli-account-cli-name">{cli.name}</span>
                  <span
                    className={`cli-account-who ${signedIn ? "" : "cli-account-who-out"}`}
                    title={login.title}
                  >
                    {login.text}
                  </span>
                  <Button
                    size="sm"
                    onClick={() => signIn(p, cli)}
                    title={`Open a terminal running ${cli.bin} against this account — log in there`}
                  >
                    {signedIn ? "Re-sign in" : "Sign in"}
                  </Button>
                </div>
              );
            })}
          </div>
          </>
          )}
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
  const [acpText, setAcpText] = useState<Record<number, string>>({});

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
              <Button
                title={`Remove ${c.name || "this CLI"} from the launcher`}
                onClick={() => commit(rows.filter((_, n) => n !== i))}>
                Remove
              </Button>
            </div>
            <div className="cli-custom-args">
              <input
                className="cli-bin-input"
                placeholder="Resume args, e.g. --resume {id}"
                spellCheck={false}
                title="How this CLI reopens a session by id. Leave blank if it can't."
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
                title="How this CLI takes an opening prompt. Leave blank to type it in instead."
                value={c.promptArgs ?? ""}
                onChange={(e) => edit(i, { promptArgs: e.target.value })}
                onBlur={(e) =>
                  commit(rows.map((o, n) => (n === i ? { ...o, promptArgs: e.target.value.trim() } : o)))
                }
              />
            </div>
            <div className="cli-custom-args">
              <input
                className="cli-bin-input"
                placeholder="ACP args, e.g. --acp (blank = not ACP)"
                spellCheck={false}
                aria-label={`ACP arguments for ${c.name || "this CLI"}`}
                title="Arguments that put this CLI in Agent Client Protocol mode. Set, Canopy drives it as a first-class ACP agent."
                value={acpText[i] ?? (c.acp ? joinArgv(c.acp.args) : "")}
                onChange={(e) => setAcpText((t) => ({ ...t, [i]: e.target.value }))}
                onBlur={(e) => {
                  const text = e.target.value.trim();
                  setAcpText((t) => {
                    const { [i]: _drop, ...rest } = t;
                    return rest;
                  });
                  commit(
                    rows.map((o, n) => {
                      if (n !== i) return o;
                      const { acp: _old, ...base } = o;
                      return text ? { ...base, acp: { ...o.acp, args: splitArgv(text) } } : base;
                    }),
                  );
                }}
              />
              {c.acp && <span className="cli-bin-state" title="Runs over the Agent Client Protocol">ACP</span>}
              {c.acp && (
                <span className="cli-custom-hint">
                  Read-only is advisory; an agent can still write.
                </span>
              )}
            </div>
          </div>
        );
      })}
      {/* The placeholders name the two tokens, but a placeholder is gone the
          moment you type — so the list says it once, where a row being edited
          can still be seen. */}
      {rows.length > 0 && (
        <div className="cli-custom-hint">
          <code>{"{id}"}</code> session · <code>{"{prompt}"}</code> text
        </div>
      )}
      <Button
        onClick={() => commit([...rows, { id: "", name: "", bin: "" }])}>
        ＋ Add a CLI
      </Button>
      <AcpProviderPicker
        onAdd={(choice) => {
          const id = newCustomCliId(choice.name, rows.map((o) => o.id));
          registerConnectorIcon(id, choice.icon);
          commit([...rows, { id, name: choice.name, bin: choice.bin, acp: choice.acp }]);
        }}
      />
    </div>
  );
}

/** The modifier half of the Settings section jump, resolved once — the nav
 *  badges render it and the key handler matches on it, so a badge can never
 *  advertise a key the handler does not answer. */
const SECTION_MOD = resolve("settings-section")!;

export function SettingsDialog({ onClose, initialTab = "appearance", projects = [], onOpenRules }: SettingsDialogProps) {
  // "vault" is still a valid deep-link target (agentOps and the status bar
  // both open it by name); it now lands on the tab the vault lives in.
  const [tab, setTab] = useState<SettingsTab>(
    initialTab === "vault" ? "browser" : initialTab,
  );
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [, setKeysVersion] = useState(0);
  const [gh, setGh] = useState<ipc.GhAuth | null>(null);
  const [ghBusy, setGhBusy] = useState(false);
  // Dictation rides on the bundled ONNX Runtime, absent on unsupported builds
  // (Intel macOS). Default true so the tab doesn't flicker in on every supported
  // platform while the check resolves; only hide once we learn it's unavailable.
  const [dictationOk, setDictationOk] = useState(true);
  const [skinPickerOpen, setSkinPickerOpen] = useState(false);
  const skinPickerTrigger = useRef<HTMLButtonElement>(null);
  const [fleetReadoutOpen, setFleetReadoutOpen] = useState(false);
  const fleetReadoutTrigger = useRef<HTMLButtonElement>(null);
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
  // Memoised so the key handler below isn't rebound on every render.
  const visibleTabs = useMemo(
    () => TABS.filter((t) => t.id !== "dictation" || dictationOk),
    [dictationOk],
  );
  // Only the first nine get a digit, because there are only nine digits. The
  // hint is rendered from the same slice that the handler reads, so a tab
  // never advertises a chord that does nothing (Dictation drops out on
  // machines without it, and everything below it shifts up by one).
  const shortcutTabs = useMemo(() => visibleTabs.slice(0, 9), [visibleTabs]);
  // Search: results replace the tab list; picking one opens its tab, scrolls to
  // the row and flashes it.
  const [query, setQuery] = useState("");
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tabLabels = useMemo(
    () => Object.fromEntries(visibleTabs.map((t) => [t.id, t.label])) as Partial<Record<SettingsTab, string>>,
    [visibleTabs],
  );
  const nav = useMemo(() => ({ tab, highlight }), [tab, highlight]);

  // The digit chord jumps between sections. Bound while the dialog is open and
  // nowhere else, which is why the manifest marks it `scoped` and lets it reuse
  // tab-jump's chord — ⌘0 is the window's zoom reset (App.tsx) and stays
  // untouched. e.code, not e.key, so a non-US layout that puts a symbol on the
  // number row still works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!modifierOnly(e, "settings-section")) return;
      const n = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (!n) return;
      const target = shortcutTabs[Number(n) - 1];
      if (!target) return;
      e.preventDefault();
      setTab(target.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutTabs]);

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
  const runInTerminal = (
    command: string,
    title: string,
    env?: [string, string][],
    profile?: string,
  ) => {
    window.dispatchEvent(
      new CustomEvent("canopy:run-command", {
        detail: { command, title, env, profile },
      }),
    );
    onClose();
  };
  const [s, setS] = useState<Settings>(() => getSettings());
  const pickSetting = (hit: SettingHit) => {
    setSkinPickerOpen(false);
    setFleetReadoutOpen(false);
    setTab(hit.entry.tab);
    setPendingAnchor(hit.anchor);
  };
  useEffect(() => {
    if (!pendingAnchor) return;
    // After the tab has rendered, so the row exists to scroll to.
    const frame = requestAnimationFrame(() => {
      document.getElementById(pendingAnchor)?.scrollIntoView({ block: "center", behavior: "smooth" });
      setHighlight(pendingAnchor);
      setPendingAnchor(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingAnchor, tab]);
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), 1800);
    return () => clearTimeout(timer);
  }, [highlight]);
  useEscape(() => {
    if (query) {
      setQuery("");
      searchRef.current?.focus();
    } else if (skinPickerOpen) {
      skinPickerTrigger.current?.focus();
      setSkinPickerOpen(false);
    } else if (fleetReadoutOpen) {
      fleetReadoutTrigger.current?.focus();
      setFleetReadoutOpen(false);
    } else {
      onClose();
    }
  }, true);

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

  /** Font, size and caret for the editor or the terminal. One row, because
   *  they are one decision about how text looks and none of them needs more
   *  than a few characters of width — stacked full-width they read as three
   *  unrelated settings and the pane becomes a column of near-empty boxes. */
  const typeRow = (
    familyKey: "editorFontFamily" | "terminalFontFamily",
    sizeKey: "editorFontSize" | "fontSize",
    styleKey: "editorCursorStyle" | "terminalCursorStyle",
    blinkKey: "editorCursorBlink" | "terminalCursorBlink",
  ) => {
    const family = fontLabel(s[familyKey]);
    return (
      <Row>
        <Field label="Font family">
          <Select
            width="md"
            value={family}
            onChange={(e) => patch({ [familyKey]: fontStack(e.target.value) })}
          >
            <option value="">System default</option>
            {fonts.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            {/* A font stored from another machine (or an older text box) that
                isn't installed here — keep it selectable rather than silently
                switching them off it. */}
            {family && !fonts.includes(family) && (
              <option value={family}>{family} (not installed)</option>
            )}
          </Select>
        </Field>
        <Field label="Size">
          <Stepper
            aria-label="Font size"
            value={s[sizeKey]}
            min={8}
            max={32}
            onChange={(v) => patch({ [sizeKey]: v })}
          />
        </Field>
        <Field label="Cursor">
          <Select
            width="sm"
            value={s[styleKey]}
            onChange={(e) => patch({ [styleKey]: e.target.value as CursorStyle })}
          >
            {CURSOR_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          <Checkbox
            checked={s[blinkKey]}
            onChange={(v) => patch({ [blinkKey]: v })}
            label="Blink"
          />
        </Field>
      </Row>
    );
  };

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div className="confirm settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <SettingsNavContext.Provider value={nav}>
        <div className="settings-layout">
          <nav className="settings-nav">
            <div className="settings-title">Settings</div>
            <SettingsSearch
              ref={searchRef}
              query={query}
              onQuery={setQuery}
              onPick={pickSetting}
              tabLabels={tabLabels}
            />
            {!query.trim() && visibleTabs.map((t, i) => (
              <Fragment key={t.id}>
                {/* A heading only where the group actually turns over. */}
                {(i === 0 || visibleTabs[i - 1].group !== t.group) && (
                  <div className="settings-nav-group">{t.group}</div>
                )}
                <button
                  className={`settings-nav-item ${tab === t.id ? "settings-nav-active" : ""}`}
                  onClick={() => {
                    setSkinPickerOpen(false);
                    setFleetReadoutOpen(false);
                    setTab(t.id);
                  }}
                >
                  <span>{t.label}</span>
                  {i < shortcutTabs.length && (
                    <span className="settings-nav-key">
                      {/* The section jump's own modifier, so this badge and
                          the handler below can never name different keys. */}
                      {formatChord({ ...SECTION_MOD, code: null })}
                      {i + 1}
                    </span>
                  )}
                </button>
              </Fragment>
            ))}
          </nav>
          <div className="settings-content">
            {tab === "account" && <Item name="Accounts" desc="Your balance and workspace usage."><AccountSettings onTeams={()=>setTab("teams")} onWorkspaces={()=>{onClose();window.dispatchEvent(new Event("canopy:open-workspaces"));}} /></Item>}
            {tab === "teams" && <OrganizationSettings />}
            {tab === "rules" && (
              <Item name="Rules" desc="Team rules and which CLIs enforce them.">
                <RulesSettings
                  projects={projects}
                  onOpen={(id, cwd) => {
                    onClose();
                    onOpenRules?.(id, cwd);
                  }}
                />
              </Item>
            )}
            {tab === "appearance" && (
              <>
                <Item
                  name="Skin"
                  tag="Applies immediately"
                  desc="Colours for the whole app."
                >
                  <SkinPicker
                    value={s.theme}
                    accent={s.customAccent}
                    open={skinPickerOpen}
                    trigger={skinPickerTrigger}
                    onOpenChange={setSkinPickerOpen}
                    onChange={pickTheme}
                  />
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
                      <Button
                        onClick={() => {
                          patch({ customAccent: "" });
                          applyTheme(s.theme, "");
                        }}>
                        Use skin colour
                      </Button>
                    )}
                  </div>
                </Item>
                <Item
                  name="Side panel"
                  desc="How the rail's panels open and close."
                >
                  <div className="set-checks">
                    <Checkbox
                      checked={s.sidebarHover}
                      onChange={(v) => patch({ sidebarHover: v })}
                      label="Hover to view"
                      hint="Rest on a rail icon to open its panel."
                    />
                    <Checkbox
                      checked={s.sidebarClickOutsideCloses}
                      onChange={(v) => patch({ sidebarClickOutsideCloses: v })}
                      label="Click outside to close"
                      hint="A click in the editor puts the panel away."
                    />
                    <Checkbox
                      checked={s.sidebarOverlay}
                      onChange={(v) => patch({ sidebarOverlay: v })}
                      label="Sidebar as overlay"
                      hint="Floats over your work instead of docking beside it."
                    />
                  </div>
                </Item>
              </>
            )}

            {/* Its own section rather than a tail on Appearance: the face and
                the companion it becomes are one subject, and stacked under the
                skins they read as decoration and pushed Side panel off the
                page. */}
            {tab === "mascot" && (
              <>
                <Item
                  name="Mascot"
                  tag="Applies immediately"
                  desc="Shown in agents and notifications."
                >
                  <div className="mascot-grid">
                    {MASCOTS.map((m) => (
                      <button
                        key={m.id}
                        className={`mascot-card${
                          s.mascot === m.id ? " mascot-card-active" : ""
                        }`}
                        onClick={() => patch({ mascot: m.id })}
                      >
                        {/* The mascot itself, drawn by the thing being picked —
                            a swatch would go stale the moment one is edited.
                            `as` pins each card to its own rather than to the
                            chosen one, which is what makes this a comparison.
                            The four states are the ones that carry meaning:
                            waiting on you, blocked, done, asleep. */}
                        <span className="mascot-faces">
                          {(["needs", "blocked", "done", "sleeping"] as const).map(
                            (state) => (
                              <Mascot key={state} as={m.id} state={state} size={30} />
                            ),
                          )}
                        </span>
                        <span className="mascot-name">{m.label}</span>
                        <span className="mascot-note">{m.note}</span>
                      </button>
                    ))}
                  </div>
                </Item>
                <CompanionSettings s={s} patch={patch} />
              </>
            )}

            {tab === "agents" && (
              <>
                <Item
                  name="Default agent"
                  desc="What Start launches."
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
                  name="Use ACP"
                  desc="Run these agents over the Agent Client Protocol. Off uses the agent's built-in runner."
                >
                  <div className="agent-chips">
                    {AGENT_CLIS.map((cli) => (
                      <AcpAgentToggle
                        key={cli.id}
                        cliId={cli.id}
                        name={cli.name}
                        value={s.acpAgents[cli.id]}
                        onChange={(id, on) => patch({ acpAgents: { ...s.acpAgents, [id]: on } })}
                      />
                    ))}
                  </div>
                </Item>
                <Item
                  name="Skip permission prompts"
                  desc="Run every agent in its CLI's bypass mode."
                >
                  <Checkbox
                    checked={s.dangerouslySkipPermissions}
                    onChange={(v) => patch({ dangerouslySkipPermissions: v })}
                    label="Dangerously skip permission checks"
                    hint="Uses each CLI's own flag. Skips the outside-project delete check. New agents only."
                  />
                  {s.dangerouslySkipPermissions && (
                    <div className="set-danger-note" role="alert">
                      Agents act without asking. Use only with trusted repos.
                    </div>
                  )}
                </Item>
                <Item
                  name="CLI commands"
                  desc="Leave blank unless renamed or off your PATH."
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
                  name="Accounts"
                  desc="Several logins per CLI. Pick one from the ＋ menu."
                >
                  <AgentAccounts
                    onRunInTerminal={(command, title, env, profile) =>
                      runInTerminal(command, title, env, profile)
                    }
                  />
                </Item>
                <Item
                  name="Other CLIs"
                  desc="Add agents Canopy doesn't list."
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
                  desc="What agents can do through Canopy. Off hides it."
                >
                  <div className="tool-groups">
                    <div className="tool-bulk">
                      <span className="tool-count">
                        {ALL_AGENT_TOOLS.length - s.disabledTools.length} of{" "}
                        {ALL_AGENT_TOOLS.length} on
                      </span>
                      <Button onClick={() => patch({ disabledTools: [] })}>
                        Enable all
                      </Button>
                      <Button
                        onClick={() => patch({ disabledTools: [...ALL_AGENT_TOOLS] })}>
                        Disable all
                      </Button>
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
                  name="CLI updates"
                  desc="Keep local agent CLIs updated."
                >
                  <Checkbox
                    checked={s.autoUpdateClis}
                    onChange={(v) => patch({ autoUpdateClis: v })}
                    label="Keep agent CLIs up to date automatically"
                    hint={
                      s.autoUpdateClis
                        ? "Updated about daily, never while one is running."
                        : "No automatic updates."
                    }
                  />
                </Item>
                <Item
                  name="Fleet readiness"
                  desc="What can launch now."
                >
                  <AgentFleetReadout
                    open={fleetReadoutOpen}
                    trigger={fleetReadoutTrigger}
                    onOpenChange={setFleetReadoutOpen}
                  />
                </Item>
                <Item
                  name="Agent delegation"
                  desc="Let agents open agent tabs."
                >
                  <Checkbox
                    checked={s.agentsMaySpawn}
                    onChange={(v) => patch({ agentsMaySpawn: v })}
                    label="Agents may spawn new agent tabs"
                    hint={
                      s.agentsMaySpawn
                        ? "Agents can delegate bounded work to a new tab."
                        : "Agents can't open new tabs."
                    }
                  />
                </Item>
                {/* Plans and review (src/plans, src/review): the brain plans
                    dispatched work and writes the review's intent summary. */}
                <Item
                  name="Plan before an agent starts"
                  desc="Plan first; risky work waits for approval."
                >
                  <Checkbox
                    checked={s.planBeforeDispatch}
                    onChange={(v) => patch({ planBeforeDispatch: v })}
                    label="Plan dispatched work first"
                    hint={
                      s.planBeforeDispatch
                        ? "Uses your brain's plan once per task you start."
                        : "Agents start straight from what you typed."
                    }
                  />
                </Item>
                <Item
                  name="Intent & evidence review"
                  desc="Open reviews on plan, receipt and risk map first."
                >
                  <Checkbox
                    checked={s.reviewAutoSummary}
                    onChange={(v) => patch({ reviewAutoSummary: v })}
                    label="Summarize changes when a review opens"
                    hint={
                      s.reviewAutoSummary
                        ? "One brain call per new diff."
                        : "A button asks for it instead."
                    }
                  />
                  <Stepper
                    aria-label="Most changed lines per reviewable slice"
                    suffix="lines"
                    value={s.reviewSliceBudgetLines}
                    min={50}
                    max={5000}
                    step={50}
                    onChange={(v) => patch({ reviewSliceBudgetLines: v })}
                  />
                </Item>
                <Item
                  name="Turn rollback"
                  desc="Snapshot each turn so it can be undone."
                >
                  <Checkbox
                    checked={s.turnRollback}
                    onChange={(v) => patch({ turnRollback: v })}
                    label="Snapshot each agent turn"
                    hint={
                      s.turnRollback
                        ? "Adds “Undo this turn” for Claude Code in git checkouts."
                        : "Saved snapshots stay until they age out."
                    }
                  />
                </Item>
                {/* Session documents (src/sessionDoc). */}
                <Item
                  name="Session documents"
                  desc="View a session as a document."
                >
                  <Checkbox
                    checked={s.sessionDocAutoSummary}
                    onChange={(v) => patch({ sessionDocAutoSummary: v })}
                    label="Write a summary when a session document opens"
                    hint={
                      s.sessionDocAutoSummary
                        ? "Written in the background on the cheaper model."
                        : "Only when you press “Write summary”."
                    }
                  />
                  <Checkbox
                    checked={s.commitSessionTrailers}
                    onChange={(v) => patch({ commitSessionTrailers: v })}
                    label="Add Agent-Session trailers to commits"
                    hint={
                      s.commitSessionTrailers
                        ? "Traces each line back to its agent session."
                        : "Commits are made exactly as you write them."
                    }
                  />
                </Item>
                <Item
                  name="Proof receipts"
                  desc="Check the work after each agent finishes."
                >
                  <span className="rc-settings">
                    <Segmented<"auto" | "manual" | "off">
                      aria-label="When to verify agent turns"
                      options={[
                        { id: "auto", label: "After every turn" },
                        { id: "manual", label: "When I ask" },
                        { id: "off", label: "Off" },
                      ]}
                      value={s.receiptMode}
                      onChange={(receiptMode) => patch({ receiptMode })}
                    />
                    <span className="set-item-desc">
                      {s.receiptMode === "auto"
                        ? "Verified in the background after each turn."
                        : s.receiptMode === "manual"
                          ? "Nothing runs until you choose Verify now."
                          : "No checks and no badges."}
                    </span>
                    {Object.entries(s.receiptCommands).map(([root, lines]) => (
                      <span key={root} className="set-item-desc">
                        <code>{root.split(/[\\/]/).pop()}</code>: {lines.join(" · ")}{" "}
                        <Button
                          size="sm"
                          variant="ghost"
                          title={`Forget the check commands set for ${root}`}
                          onClick={() => {
                            const next = { ...s.receiptCommands };
                            delete next[root];
                            patch({ receiptCommands: next });
                          }}
                        >
                          Use detected checks
                        </Button>
                      </span>
                    ))}
                  </span>
                </Item>
                <Item
                  name="Claude Code editor link"
                  desc="Let Claude Code use Canopy as its IDE."
                >
                  <Checkbox
                    checked={s.claudeIdeIntegration}
                    onChange={(v) => patch({ claudeIdeIntegration: v })}
                    label="Connect Claude Code to the editor"
                    hint={
                      s.claudeIdeIntegration
                        ? "Edits open as diffs here. New tabs only."
                        : "Claude uses the MCP editor tools. New tabs only."
                    }
                  />
                </Item>
              </>
            )}

            {tab === "brain" && (
              <>
                {/* First, because everything smart in Canopy runs on it. The
                    same panel as the first-run step and the chip's dialog. */}
                <Item
                  name="Brain"
                  desc="The CLI that powers Canopy's smart features."
                >
                  <BrainConnectPanel onTerminalOpened={onClose} />
                </Item>
                <Item
                  name="Brain spending"
                  desc="Today's spend and daily caps per feature."
                >
                  <BrainSpendTable />
                </Item>
                <Item
                  name="Features not using your brain"
                  desc="Per-feature overrides. The rest follow the brain."
                >
                  <BrainExceptions />
                </Item>
                <Item name="Automatic brain work" desc="Small background calls the brain makes on its own.">
                  <BrainAutomation />
                </Item>
                <Item
                  name="Builder lens summaries"
                  desc="Explain each saved step in plain words."
                >
                  <Checkbox
                    checked={s.lensAutoSummaries}
                    onChange={(v) => patch({ lensAutoSummaries: v })}
                    label="Summarise changes automatically"
                    hint={
                      s.lensAutoSummaries
                        ? "Written in the background, once per step."
                        : "Steps show your request. Layers on demand."
                    }
                  />
                </Item>
                <Item
                  name="Agent awareness"
                  desc="Tell other agents on the same code what changed."
                >
                  <Checkbox
                    checked={s.awarenessEnabled}
                    onChange={(v) => patch({ awarenessEnabled: v })}
                    label="Tell agents about each other's changes"
                    hint={
                      s.awarenessEnabled
                        ? "Your brain writes the notes. Busy files get a claim."
                        : "Agents work without hearing about each other."
                    }
                  />
                </Item>
                <Item
                  name="Memory monitoring prompts"
                  desc="Show memory warnings."
                >
                  <Checkbox
                    checked={s.terminalMemoryPromptsEnabled}
                    onChange={(v) => patch({ terminalMemoryPromptsEnabled: v })}
                    label="Show terminal memory prompts"
                    hint={
                      s.terminalMemoryPromptsEnabled
                        ? "Warns when an agent exceeds its allowance."
                        : "Monitoring continues silently."
                    }
                  />
                </Item>
                <Item
                  name="Memory allowance maximums"
                  desc="Max allowance per agent."
                >
                  <AgentMemorySettings />
                </Item>
              </>
            )}

            {tab === "sessions" && (
              <>
                {/* Spend & outcomes (src/outcomes): session budgets and the
                    brain's weekly insight in the Outcomes panel. */}
                <Item
                  name="Session budget"
                  desc="Per-session cap: warns at 80%, pauses at 100%."
                >
                  <TextInput
                    type="number"
                    width="xs"
                    aria-label="Default session budget in dollars"
                    min={0}
                    step={1}
                    placeholder="None"
                    value={s.sessionBudgetUsd ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      const v = Number(raw);
                      patch({ sessionBudgetUsd: raw === "" || !Number.isFinite(v) || v <= 0 ? null : v });
                    }}
                  />
                </Item>
                <Item
                  name="Prototype session cap"
                  desc="Cap for Build projects. Empty for none."
                >
                  <TextInput
                    type="number"
                    width="xs"
                    aria-label="Prototype session cap in dollars"
                    min={0}
                    step={1}
                    placeholder="None"
                    value={s.builderSessionCapUsd ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      const v = Number(raw);
                      patch({ builderSessionCapUsd: raw === "" || !Number.isFinite(v) || v <= 0 ? null : v });
                    }}
                  />
                </Item>
                <Item
                  name="At the budget"
                  desc="What happens when a session hits its budget."
                >
                  <Checkbox
                    checked={s.budgetPauseAtLimit}
                    onChange={(v) => patch({ budgetPauseAtLimit: v })}
                    label="Pause the agent (press Esc in its terminal)"
                    hint={
                      s.budgetPauseAtLimit
                        ? "Stops the current step. Raise the budget to continue."
                        : "Canopy only warns. The agent keeps going."
                    }
                  />
                </Item>
                <Item
                  name="Spend & outcomes"
                  desc="Track outcomes locally."
                >
                  <Checkbox
                    checked={s.outcomesInsight}
                    onChange={(v) => patch({ outcomesInsight: v })}
                    label="Write a weekly insight from the numbers"
                    hint={
                      s.outcomesInsight
                        ? "At most daily. Sees totals only, never code."
                        : "The panel shows the numbers only."
                    }
                  />
                </Item>
                <Item
                  name="Live agents per project"
                  desc="Terminals kept before idle ones hibernate."
                >
                  <Stepper
                    aria-label="Live agents per project"
                    value={s.maxLiveAgents}
                    min={1}
                    max={64}
                    disabled={!s.autoHibernate}
                    onChange={(v) => patch({ maxLiveAgents: v })}
                  />
                </Item>
                <Item
                  name="Settle into Idle after"
                  desc="Seconds of quiet before a tab drops into Idle."
                >
                  <TextInput
                    type="number"
                    width="xs"
                    aria-label="Settle into Idle after"
                    min={0}
                    max={3600}
                    step={5}
                    value={s.idleGroupDelaySeconds}
                    disabled={!s.groupTabsByStatus}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v >= 0)
                        patch({ idleGroupDelaySeconds: Math.min(3600, Math.floor(v)) });
                    }}
                  />
                </Item>
                <Item
                  name="Hibernate idle agents"
                  desc="Free memory from idle agents. They stay resumable."
                >
                  <Checkbox
                    checked={s.autoHibernate}
                    onChange={(v) => patch({ autoHibernate: v })}
                    label="Hibernate the stalest idle agents past the limit"
                  />
                </Item>
                <Item
                  name="Restore sessions I close"
                  desc="Also keep sessions you closed."
                >
                  <Checkbox
                    checked={s.restoreUserClosedSessions}
                    onChange={(v) => patch({ restoreUserClosedSessions: v })}
                    label="Include sessions I closed myself"
                  />
                </Item>
                <Item
                  name="New agents get a workspace"
                  desc="Open each new agent in its own worktree."
                >
                  <Checkbox
                    checked={s.agentWorkspaceByDefault}
                    onChange={(v) => patch({ agentWorkspaceByDefault: v })}
                    label="Start new agents in their own workspace"
                  />
                  <Checkbox
                    checked={s.closeAgentOnMerge}
                    onChange={(v) => patch({ closeAgentOnMerge: v })}
                    label="Close an agent's tab when its pull request merges"
                    hint="Only when the agent is idle. Closing removes its workspace."
                  />
                </Item>
                <Item
                  name="Set up new workspaces"
                  desc="Copy config and install deps."
                >
                  <Checkbox
                    checked={s.workspaceBootstrap}
                    onChange={(v) => patch({ workspaceBootstrap: v })}
                    label="Prepare a workspace when it's created"
                  />
                </Item>
                <Item
                  name="Workspace ports"
                  desc="Base port. Each workspace takes the next free one."
                >
                  <TextInput
                    type="number"
                    width="sm"
                    aria-label="Workspace ports"
                    min={1024}
                    max={65000}
                    value={s.workspaceBasePort}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v >= 1024 && v <= 65000)
                        patch({ workspaceBasePort: Math.floor(v) });
                    }}
                  />
                </Item>
                <Item
                  name="Ctrl+Tab switching"
                  desc="Switcher order."
                >
                  <Segmented<TabSwitchMode>
                    aria-label="Ctrl+Tab switching order"
                    options={[
                      { id: "recent", label: "Recent activity" },
                      { id: "order", label: "Tab order" },
                      { id: "items", label: "Work items" },
                    ]}
                    value={s.tabSwitchMode}
                    onChange={(tabSwitchMode) => patch({ tabSwitchMode })}
                  />
                </Item>
                <Item
                  name="Stack tabs by status"
                  desc="Group agents: Needs you, Working, Idle."
                >
                  <Checkbox
                    checked={s.groupTabsByStatus}
                    onChange={(v) => patch({ groupTabsByStatus: v })}
                    label="Keep agents that need you on the left"
                  />
                </Item>
              </>
            )}

            {tab === "notifications" && (
              <>
                <Item
                  name="Ask for attention"
                  desc="Let agents bring their tab to the front."
                >
                  <Checkbox
                    checked={s.agentAskForAttention}
                    onChange={(v) => patch({ agentAskForAttention: v })}
                    label="Let agents switch to files, previews and runs"
                    hint="Off keeps their work in the background."
                  />
                </Item>
                <Item
                  name="Notification pop-ups"
                  desc="Interrupt, or wait in the bell."
                >
                  <Checkbox
                    checked={s.notificationPopupsEnabled}
                    onChange={(v) => patch({ notificationPopupsEnabled: v })}
                    label="Show notification pop-ups"
                    hint={
                      s.notificationPopupsEnabled
                        ? "Corner cards, companion notices and banners."
                        : "Off keeps every notice in the top-right bell."
                    }
                  />
                </Item>
                <Item
                  name="Team messages"
                  desc="Notify on teammate messages."
                >
                  <Checkbox
                    checked={s.teamMessageNotifications}
                    onChange={(v) => patch({ teamMessageNotifications: v })}
                    label="Notify me about team messages"
                  />
                  <Checkbox
                    checked={s.teamMessagePreviews}
                    disabled={!s.teamMessageNotifications}
                    onChange={(v) => patch({ teamMessagePreviews: v })}
                    label="Show message previews"
                    hint={
                      s.teamMessagePreviews
                        ? "Shows the first line of each message."
                        : "Shows only who wrote."
                    }
                  />
                  <Checkbox
                    checked={s.teamMentionNotifications}
                    onChange={(v) => patch({ teamMentionNotifications: v })}
                    label="Always notify me when I'm mentioned"
                    hint="Overrides muted chats. @channel doesn't count."
                  />
                  <Checkbox
                    checked={s.teamReadReceipts}
                    onChange={(v) => patch({ teamReadReceipts: v })}
                    label="Send and show read receipts"
                    hint={
                      s.teamReadReceipts
                        ? "You and teammates see when messages are read."
                        : "Read status stays hidden."
                    }
                  />
                </Item>
              </>
            )}

            {tab === "editor" && (
              <>
                <Item
                  name="Keyboard shortcuts"
                  tag="Cross-platform"
                  desc={SHORTCUT_PROFILES.find((p) => p.id === s.keymapProfile)?.description}
                >
                  <Select
                    width="lg"
                    value={s.keymapProfile}
                    onChange={(e) =>
                      patch({ keymapProfile: e.target.value as ShortcutProfile })
                    }
                  >
                    {SHORTCUT_PROFILES.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.label}
                      </option>
                    ))}
                  </Select>
                </Item>
                <Item
                  name="Font and cursor"
                  tag="New files only"
                  desc="Monospace fonts found on this machine."
                >
                  {typeRow(
                    "editorFontFamily",
                    "editorFontSize",
                    "editorCursorStyle",
                    "editorCursorBlink",
                  )}
                </Item>
                <Item
                  name="File associations"
                  desc="Which language each file type is highlighted as."
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
                <Item
                  name="Automatic session names"
                  tag="New terminals only"
                  desc="Agent callsign words."
                >
                  <div className="session-name-theme">
                    <Select
                      width="lg"
                      aria-label="Automatic session names"
                      value={s.sessionNameTheme}
                      onChange={(e) =>
                        patch({
                          sessionNameTheme: e.target.value as SessionNameTheme,
                        })
                      }
                    >
                      {SESSION_NAME_THEMES.map((theme) => (
                        <option key={theme.id} value={theme.id}>
                          {theme.label} — {theme.note}
                        </option>
                      ))}
                    </Select>
                    <div className="session-name-preview" aria-live="polite">
                      {sessionNameThemeDef(s.sessionNameTheme).preview.map(
                        (name, index) => (
                          <span
                            className="session-name-chip"
                            style={
                              {
                                "--name-opacity": String(1 - index * 0.14),
                              } as CSSProperties
                            }
                            key={name}
                          >
                            {name}
                          </span>
                        ),
                      )}
                    </div>
                  </div>
                </Item>
                <Item
                  name="Font and cursor"
                  tag="New terminals only"
                  desc="Monospace fonts found on this machine."
                >
                  {typeRow(
                    "terminalFontFamily",
                    "fontSize",
                    "terminalCursorStyle",
                    "terminalCursorBlink",
                  )}
                </Item>
                <Item
                  name="Scrollback"
                  desc="Lines kept per terminal. New terminals only."
                >
                  <TextInput
                    type="number"
                    width="sm"
                    aria-label="Scrollback"
                    min={TERMINAL_SCROLLBACK_MIN_ROWS}
                    max={TERMINAL_SCROLLBACK_MAX_ROWS}
                    step={1000}
                    value={s.scrollback}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) {
                        patch({
                          scrollback: Math.min(
                            TERMINAL_SCROLLBACK_MAX_ROWS,
                            Math.max(TERMINAL_SCROLLBACK_MIN_ROWS, v),
                          ),
                        });
                      }
                    }}
                  />
                </Item>
              </>
            )}

            {tab === "spotsearch" && <SpotSearchSettings s={s} patch={patch} />}
            {tab === "clipboard" && <ClipboardSettings s={s} patch={patch} />}


            {tab === "dictation" && dictationOk && <DictationSettings />}

            {tab === "remote" && <RemoteSettings runInTerminal={runInTerminal} />}

            {tab === "privacy" && (
              <>
                <Item
                  name="Crash reporting"
                  desc="Send crash details anonymously."
                >
                  <Checkbox
                    checked={s.crashReporting}
                    onChange={(v) => patch({ crashReporting: v })}
                    label="Offer to send anonymous crash reports"
                  />
                </Item>
                <Item
                  name="Files outside projects"
                  desc="Open them from terminal links."
                >
                  <Checkbox
                    checked={s.allowOutsideFileLinks}
                    onChange={(v) => patch({ allowOutsideFileLinks: v })}
                    label="Let a clicked terminal link open a file outside the project folders"
                  />
                  <div className="set-note">
                    Only the file you click, and never credential folders like ~/.ssh.
                  </div>
                </Item>
              </>
            )}

            {tab === "browser" && (
              <>
                {/* The vault is the browser's other half: it exists to fill
                    logins into these same preview tabs, and as its own tab it
                    read as an unrelated feature. */}
                <VaultSettings />
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
                            Connected. Key stored on this machine only.
                          </div>
                          <div className="set-item-control">
                            <Button
                              onClick={() => {
                                setTrackerKey(p.id, "");
                                setKeysVersion((v) => v + 1);
                              }}>
                              Disconnect
                            </Button>
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
                            <Button variant="accent"
                              disabled={!(keyDrafts[p.id] ?? "").trim()}
                              onClick={() => {
                                setTrackerKey(p.id, (keyDrafts[p.id] ?? "").trim());
                                setKeyDrafts((d) => ({ ...d, [p.id]: "" }));
                                setKeysVersion((v) => v + 1);
                              }}>
                              Connect
                            </Button>
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
                              ? "The GitHub CLI (gh) isn't installed."
                              : gh.authenticated
                                ? `Signed in as ${gh.account}${gh.host ? ` on ${gh.host}` : ""} · ${gh.path}`
                                : `Installed at ${gh.path}, but not signed in.${gh.detail ? ` ${gh.detail}` : ""}`}
                        </div>
                        <div className="set-item-control set-inline">
                          {gh && !gh.installed && (
                            <Button variant="accent"
                              onClick={() =>
                                runInTerminal("brew install gh", "install gh")
                              }>
                              Install with Homebrew
                            </Button>
                          )}
                          {gh?.installed && !gh.authenticated && (
                            <Button variant="accent"
                              onClick={() =>
                                runInTerminal("gh auth login", "gh auth login")
                              }>
                              Sign in to GitHub
                            </Button>
                          )}
                          {gh?.authenticated && (
                            <>
                              <Button
                                onClick={() =>
                                  runInTerminal(
                                    "gh auth login",
                                    "gh auth login",
                                  )
                                }>
                                Switch account
                              </Button>
                              <Button
                                onClick={() =>
                                  runInTerminal("gh auth logout", "gh auth logout")
                                }>
                                Sign out
                              </Button>
                            </>
                          )}
                          <Button disabled={ghBusy} onClick={refreshGh}>
                            {ghBusy ? "Checking…" : "Recheck"}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
        </SettingsNavContext.Provider>
        <div className="settings-footer">
          <Button variant="accent" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Voice dictation setup: the model is a one-time ~700 MB download; after
 *  that everything runs locally. Lives here so setup is discoverable before
 *  the first shortcut press (which would otherwise trigger the download). */

/** Command is deliberately absent: both sides are reserved for application and
 *  system shortcuts. Left Shift leads because it is the default. */
const MOD_KEY_CHOICES: DictationModKey[] = [
  "ShiftLeft",
  "AltRight",
  "ControlRight",
  "ShiftRight",
  "CapsLock",
  "AltLeft",
  "ControlLeft",
  "Alt",
  "Control",
  "Shift",
];

/** A looping sample of a visualiser, so the picker shows what each one does
 *  rather than naming it and hoping. Driven by a synthetic level — there is no
 *  microphone open on the Settings screen. */
function WavePreview({ style }: { style: DictationWaveStyle }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    let phase = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      phase += 0.07;
      // Two beating sines stand in for speech: loud, quiet, loud again.
      const level = 0.45 + 0.35 * Math.sin(phase * 0.9) * Math.sin(phase * 0.31);
      drawWave(style, { ctx, w, h, level, phase });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [style]);
  return <canvas ref={ref} className="dictation-wave-preview" />;
}
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

/** An on/off switch. */
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
        {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
      </span>
    </button>
  );
}

/** Canopy Remote — turn on the embedded control-panel server, show the PIN and
 *  the connect URL. Off by default; see src-tauri/src/portal.rs. */
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
    note: "Requires Funnel enabled in your tailnet admin.",
    fixed: true,
    install: {
      macos: "brew install tailscale",
      windows: "winget install --id tailscale.tailscale -e --source winget",
      linux: "curl -fsSL https://tailscale.com/install.sh | sh",
    },
  },
];

/** Signed in to Canopy, remote access is your own link on canopyide.dev:
 *  no tunnel to pick, no PIN to read out. Signed out, the self-hosted
 *  options below stay. */
export function RemoteSettings({
  runInTerminal,
}: {
  runInTerminal: (command: string, title: string) => void;
}) {
  const [me, setMe] = useState<TeamIdentity | null | undefined>(() => peekTeamIdentity() ?? undefined);
  useEffect(() => {
    const read = () => void teamIdentity().then(setMe).catch(() => setMe(null));
    read();
    const off = subscribeTeamIdentity(read);
    window.addEventListener("canopy:account-changed", read);
    return () => {
      off();
      window.removeEventListener("canopy:account-changed", read);
    };
  }, []);
  if (me === undefined) return null;
  return (
    <>
      {me ? <CanopyLinkSettings /> : <SelfHostedRemoteSettings runInTerminal={runInTerminal} />}
      <TailscaleSettings />
    </>
  );
}

/** The Tailscale already installed on this machine, signed in to Canopy or
 *  not. Separate from the Tailscale choice under Public link, which is Funnel
 *  for the phone portal. */
function TailscaleSettings() {
  return (
    <Item name="Tailscale" desc="Uses the Tailscale app on this machine.">
      <TailscaleStatus />
    </Item>
  );
}

/** The portal is served under /remote. */
const remotePath = (u: string) => (u.endsWith("/remote") ? u : `${u.replace(/\/+$/, "")}/remote`);

function CanopyLinkSettings() {
  const [status, setStatus] = useState<ipc.RemoteStatus | null>(null);
  const [tunnel, setTunnel] = useState<ipc.TunnelState>({ running: false, provider: null, url: null, message: null });
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [showLan, setShowLan] = useState(false);

  useEffect(() => {
    void ipc.remoteStatus().then(setStatus).catch(() => setStatus(null));
    void ipc.tunnelStatus().then(setTunnel).catch(() => {});
    const un = ipc.onTunnelState(setTunnel);
    return () => void un.then((f) => f());
  }, []);

  const on = status?.enabled ?? false;
  const linked = tunnel.provider === CANOPY_LINK;
  const url = linked && tunnel.url ? remotePath(tunnel.url) : null;
  const connected = linked && tunnel.running && !!tunnel.url && !tunnel.message;
  const failed = linked && !tunnel.running && !!tunnel.message;
  // Canopy's server doesn't offer links yet: a quiet note, not a failure.
  const pending = failed && notOnServerYet(serverFeatureError(tunnel.message, "Your Canopy link"));

  const connect = (port: number) =>
    ipc
      .tunnelStart(CANOPY_LINK, port)
      .then(setTunnel)
      .catch((e) => setTunnel({ running: false, provider: CANOPY_LINK, url: null, message: String(e) }));

  // Remote access left on from an earlier run, or a link another computer
  // took over and this one is asked to reclaim: bring the link up with it.
  useEffect(() => {
    if (on && status && !linked) void connect(status.port);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, linked]);

  useEffect(() => {
    if (!url) {
      setQr(null);
      return;
    }
    void ipc.remoteQr(url).then(setQr).catch(() => setQr(null));
  }, [url]);

  const toggle = () => {
    setBusy(true);
    const op = on
      ? ipc.tunnelStop().then(setTunnel).then(() => ipc.remoteDisable())
      : ipc.remoteEnable().then(async (next) => {
          await connect(next.port);
          return next;
        });
    void op.then(setStatus).catch(() => {}).finally(() => setBusy(false));
  };

  const state = !on
    ? null
    : connected
      ? "Connected. Open it on your phone and sign in to Canopy."
      : pending
        ? "Not live yet — use On this network."
        : failed
          ? serverFeatureError(tunnel.message, "Your Canopy link").message
          : (tunnel.message ?? "Connecting…");

  return (
    <>
      <Item
        name="Remote access"
        desc="Use your agents from your phone."
      >
        <div className="set-inline">
          <Switch checked={on} disabled={busy} aria-label="Remote access" onChange={toggle} />
          {state && (
            <span className={failed && !pending ? "set-warn" : "set-note"} role="status">
              {state}
            </span>
          )}
          {failed && !pending && status && (
            <Button size="sm" disabled={busy} onClick={() => void connect(status.port)}>
              Try again
            </Button>
          )}
        </div>
      </Item>

      {on && url && (
        <Item name="Your link" desc="Permanent link.">
          <div className="set-inline" style={{ alignItems: "center", gap: 18 }}>
            {qr && (
              <div
                style={{ width: 128, height: 128, padding: 7, background: "#fff", borderRadius: 10, flex: "none" }}
                dangerouslySetInnerHTML={{ __html: qr }}
              />
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              <Copyable text={url} />
            </div>
          </div>
        </Item>
      )}

      {on && status && (
        <Item name="On this network" desc="Local address, with PIN.">
          {showLan ? (
            <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
              {status.urls?.[0] && <Copyable text={status.urls[0]} />}
              {status.pin && <Copyable text={status.pin} big />}
            </div>
          ) : (
            <Button size="sm" onClick={() => setShowLan(true)}>
              Show address and PIN
            </Button>
          )}
        </Item>
      )}
    </>
  );
}

function SelfHostedRemoteSettings({
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
      <Item
        name="Remote access"
        desc="Phone access behind a PIN. Sign in to Canopy for your own link."
      >
        <div className="set-inline">
          <Switch
            checked={on}
            disabled={busy}
            aria-label="Remote access"
            onChange={() => run(on ? ipc.remoteDisable : ipc.remoteEnable)}
          />
          {on && (
            <span className="set-warn">
              Anyone with the PIN can drive your agents.
            </span>
          )}
        </div>
      </Item>

      {on && (
        <>
          <Item name="Reach">
            <Segmented
              aria-label="Reach"
              options={[
                { id: "local", label: "This network" },
                { id: "internet", label: "Internet" },
              ]}
              value={scope}
              onChange={changeScope}
            />
          </Item>

          {scope === "internet" && (
            <Item name="Public link" desc="One tunnel, shared with internet team sessions.">
              <div style={{ display: "grid", gap: 12, justifyItems: "start", width: "100%" }}>
                <Segmented
                  aria-label="Tunnel provider"
                  options={TUNNELS.map((t) => ({ id: t.id, label: t.name }))}
                  value={provider}
                  onChange={changeProvider}
                />
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {prov.note ? `${prov.blurb} ${prov.note}` : prov.blurb}
                </div>
                {/* Whether the link survives a restart — the thing people trip
                    on when they bookmark a quick-tunnel URL and it 404s next
                    session. */}
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {prov.fixed
                    ? "🔗 Same link every session — safe to bookmark."
                    : "↻ A new link each session. Tailscale keeps one."}
                </div>

                {prov.needsToken && (
                  <TextInput
                    type="password"
                    width="lg"
                    placeholder={prov.tokenHelp ?? "ngrok authtoken"}
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      setTrackerKey("ngrok", e.target.value.trim());
                    }}
                  />
                )}

                {!provInstalled ? (
                  <Button onClick={() => runInTerminal(prov.install[currentPlatform()], `Install ${prov.name}`)}>
                    Install {prov.name}
                  </Button>
                ) : tunnel.running && tunnel.provider === provider ? (
                  <Button disabled={busy} onClick={stopTunnel}>
                    Stop public link
                  </Button>
                ) : (
                  <Button disabled={busy || (prov.needsToken && !token.trim())} onClick={startTunnel}>
                    Start public link
                  </Button>
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
                        <RestartIcon size={16} />
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
  // Armed, it is the top overlay: Escape disarms it and leaves Settings open.
  useEscapeLayer(arming, { onEscape: () => setArming(false) });
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
      <Button onClick={() => onChange(DEFAULT_DICTATION_HOTKEY)}>
        Reset
      </Button>
    </span>
  );
}

/**
 * SpotSearch: what ⌘K looks through, and what the index on disk is allowed to
 * keep.
 *
 * Two different questions, deliberately separated. The first list is *search*
 * — which sources the palette asks; switching one off costs you rows and
 * nothing else. The second is *indexing* — what Canopy reads off disk and keeps
 * in a database; switching one off deletes what it already read, because
 * anything less would mean the setting said one thing and the file said
 * another.
 */
function SpotSearchSettings({
  s,
  patch,
}: {
  s: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const [stats, setStats] = useState<ipc.SpotIndexStats | null>(null);
  const [busy, setBusy] = useState<"" | "reindex" | "clear">("");
  // Unread transcript bytes as of the last update, null before one has run.
  // Without it the message count is the only feedback the screen gives, and a
  // count that rises on every press reads as double-counting rather than as a
  // machine with more history than one press can read.
  const [pending, setPending] = useState<number | null>(null);
  const sources = spotSources();

  const refresh = useCallback(() => {
    void ipc
      .spotIndexStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);
  useEffect(refresh, [refresh]);

  // The screen has no project context of its own; the index is machine-wide
  // and its per-project stores are picked up by whichever palette opens next.
  const roots: string[] = [];
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const byAgent = new Map(stats?.by_agent ?? []);

  return (
    <>
      <Item
        name={`What ${format("spot-search")} searches`}
        desc="Results the omnibox offers."
      >
        <div className="spot-set-list">
          {sources.map((src) => {
            const on = !s.spotDisabledSources.includes(src.id);
            return (
              <label key={src.id} className="spot-set-row" title={src.id}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    patch({
                      spotDisabledSources: toggle(s.spotDisabledSources, src.id),
                    })
                  }
                />
                <span className="spot-set-name">{src.group}</span>
                <span className="spot-set-note">{src.blurb ?? ""}</span>
              </label>
            );
          })}
        </div>
      </Item>

      <Item
        name="Conversations to index"
        desc="Search past conversations by content."
      >
        <div className="spot-set-list" style={{ ["--spot-set-name-w" as string]: "150px" }}>
          {INDEXABLE_AGENTS.map((agent) => {
            const on = !s.spotDisabledAgents.includes(agent.id);
            const n = byAgent.get(agent.id) ?? 0;
            return (
              <label key={agent.id} className="spot-set-row" title={agent.store}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    patch({
                      spotDisabledAgents: toggle(s.spotDisabledAgents, agent.id),
                    })
                  }
                />
                <span className="spot-set-name">
                  <AgentIcon id={agent.id} size={13} className="cli-icon" />{" "}
                  {agent.label}
                </span>
                <span className="spot-set-note">
                  <code>{agent.store}</code>
                  {agent.note ? ` — ${agent.note}` : ""}
                  {n > 0 ? ` · ${n.toLocaleString()} indexed` : ""}
                </span>
              </label>
            );
          })}
          <p className="set-item-desc">
            Amp isn't listed; its threads live on Sourcegraph.
          </p>
        </div>
      </Item>

      <Item
        name="Terminal scrollback"
        desc="Searchable while open; dropped on close."
      >
        <Checkbox
          checked={s.spotIndexTerminals}
          onChange={(v) => patch({ spotIndexTerminals: v })}
          label="Index open terminals' scrollback"
        />
      </Item>

      <Item
        name="Scope"
        desc="This project, or every project on this machine."
      >
        <Checkbox
          checked={s.spotSearchAllProjects}
          onChange={(v) => patch({ spotSearchAllProjects: v })}
          label="Search every project, not just this one"
        />
      </Item>

      <Item
        name="Keep history for"
        desc="0 keeps everything."
      >
        <div className="spot-set-days">
          <TextInput
            type="number"
            width="xs"
            aria-label="Keep history for"
            min={0}
            max={3650}
            step={30}
            value={s.spotRetentionDays}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0)
                patch({ spotRetentionDays: Math.floor(v) });
            }}
          />
          <span className="set-item-desc">
            days{s.spotRetentionDays === 0 ? " — keep everything" : ""}
          </span>
        </div>
      </Item>

      <Item
        name="The index"
        
      >
        <div className="spot-set-index">
          <p className="set-item-desc">
            {stats
              ? `${stats.messages.toLocaleString()} messages from ${stats.sessions.toLocaleString()} conversations, ${stats.terminals} terminal${
                  stats.terminals === 1 ? "" : "s"
                } · ${fmtBytes(stats.bytes)}`
              : "Not built yet."}
          </p>
          {pending !== null && (
            <p className="set-item-desc">
              {pending > 0
                ? `${fmtBytes(pending)} still unread. Reading continues.`
                : "Everything on disk has been read."}
            </p>
          )}
          <div className="tool-bulk">
            <Button
              disabled={busy !== ""}
              onClick={() => {
                setBusy("reindex");
                void runIngest(roots)
                  .then((r) => setPending(r ? r.pending : null))
                  .catch(() => {})
                  .finally(() => {
                    setBusy("");
                    refresh();
                  });
              }}>
              {busy === "reindex"
                ? "Reading…"
                : pending
                  ? "Keep reading"
                  : "Update now"}
            </Button>
            <Button
              disabled={busy !== ""}
              onClick={() => {
                setBusy("clear");
                setPending(null);
                void ipc
                  .spotIndexClear()
                  .catch(() => {})
                  .finally(() => {
                    setBusy("");
                    refresh();
                  });
              }}>
              {busy === "clear" ? "Clearing…" : "Clear index"}
            </Button>
          </div>
        </div>
      </Item>
    </>
  );
}

/** Access states macOS reports for this app's pasteboard, said in plain words.
 *  "default" means no alert has fired yet, so the app isn't in System Settings
 *  at all — which is worth saying, because otherwise someone goes looking for
 *  a switch that isn't there until the first capture. */
const PASTEBOARD_ACCESS: Record<string, string> = {
  default: "macOS asks on the first copy.",
  ask: "macOS asks before each read. Allow it in System Settings.",
  allow: "macOS always allows Canopy the pasteboard.",
  deny: "macOS denies the pasteboard, so nothing is captured.",
};

/**
 * Clipboard history: keep what you copy so ⌘K can hand it back.
 *
 * Off by default, and the screen leads with why rather than with a switch. Two
 * things here are genuinely the user's call and not a default anyone should
 * pick for them: whether an app watches everything they copy at all, and
 * whether that lands on disk.
 */
function ClipboardSettings({
  s,
  patch,
}: {
  s: Settings;
  patch: (p: Partial<Settings>) => void;
}) {
  const [status, setStatus] = useState<ipc.ClipboardStatus | null>(null);
  const refresh = useCallback(() => {
    void ipc
      .clipboardStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useEffect(refresh, [refresh, s.clipboardHistory, s.clipboardPersist]);

  if (status && !status.supported) {
    return (
      <Item
        name="Clipboard history"
        desc="macOS only."
      >
        {null}
      </Item>
    );
  }

  return (
    <>
      <Item
        name="Keep what I copy"
        desc="Copies appear under Clipboard in ⌘K."
      >
        <Checkbox
          checked={s.clipboardHistory}
          onChange={(v) => patch({ clipboardHistory: v })}
          label="Keep a clipboard history"
        />
        {status?.access && (
          <p className="set-item-desc">
            {PASTEBOARD_ACCESS[status.access] ?? ""}
          </p>
        )}
        <p className="set-item-desc">
          Read only when the clipboard changes.
        </p>
      </Item>

      <Item
        name="Passwords and keys"
        desc="Credential-like clips are never saved."
      >
        <Checkbox
          checked={s.clipboardSkipSecrets}
          onChange={(v) => patch({ clipboardSkipSecrets: v })}
          label="Skip clips that look like credentials"
        />
        <p className="set-item-desc">
          Keys, tokens and private keys. Paths and prose are exempt.
        </p>
        <p className="set-item-desc">
          Password-manager clips are always skipped.
        </p>
      </Item>

      <Item
        name="Where it's kept"
        desc="Stored unencrypted."
      >
        <Checkbox
          checked={s.clipboardPersist}
          onChange={(v) => patch({ clipboardPersist: v })}
          label="Keep the history on disk between launches"
        />
        <p className="set-item-desc">
          Off keeps history in memory only.
        </p>
      </Item>

      <Item
        name="How much to keep"
        
      >
        <div className="spot-set-days">
          <TextInput
            type="number"
            width="xs"
            aria-label="Clips to keep"
            min={10}
            max={2000}
            step={50}
            value={s.clipboardKeep}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 1)
                patch({ clipboardKeep: Math.floor(v) });
            }}
          />
          <span className="set-item-desc">clips</span>
        </div>
        <div className="spot-set-days">
          <TextInput
            type="number"
            width="xs"
            aria-label="Days to keep clips"
            min={0}
            max={365}
            step={7}
            value={s.clipboardRetentionDays}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0)
                patch({ clipboardRetentionDays: Math.floor(v) });
            }}
          />
          <span className="set-item-desc">
            days
            {s.clipboardRetentionDays === 0
              ? " — no age limit, just the count above"
              : ""}
          </span>
        </div>
      </Item>

      <Item
        name="The history"
        desc="Clearing is permanent."
      >
        <div className="spot-set-index">
          <p className="set-item-desc">
            {status
              ? `${status.clips.toLocaleString()} clip${
                  status.clips === 1 ? "" : "s"
                } · ${fmtBytes(status.bytes)}${
                  status.persisted ? "" : " · memory only"
                }`
              : "Nothing kept yet."}
          </p>
          {status &&
            status.skipped_secrets +
              status.skipped_concealed +
              status.skipped_large >
              0 && (
              <p className="set-item-desc">
                Skipped since launch:{" "}
                {[
                  status.skipped_secrets > 0
                    ? `${status.skipped_secrets} that looked like credentials`
                    : null,
                  status.skipped_concealed > 0
                    ? `${status.skipped_concealed} marked concealed`
                    : null,
                  status.skipped_large > 0
                    ? `${status.skipped_large} too large to keep`
                    : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
                .
              </p>
            )}
          <div className="tool-bulk">
            <Button
              onClick={() => {
                clipboardStore.clear();
                refresh();
              }}>
              Clear history
            </Button>
          </div>
        </div>
      </Item>
    </>
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
        name="Trigger"
        desc="How to open the mic. Esc cancels. Runs locally."
      >
        <Select
          width="lg"
          value={s.dictationTriggerMode}
          onChange={(e) =>
            patch({ dictationTriggerMode: e.target.value as DictationTriggerMode })
          }
        >
          <option value="combo">Key combo</option>
          <option value="hold">Hold a modifier — push to talk</option>
          <option value="doubleTap">Double-tap a modifier</option>
        </Select>
      </Item>

      {s.dictationTriggerMode === "combo" ? (
        <Item
          name="Shortcut"
          desc="Press to start dictating, again to insert."
        >
          <HotkeyCapture value={s.dictationHotkey} onChange={(h) => patch({ dictationHotkey: h })} />
        </Item>
      ) : (
        <Item
          name="Key"
          desc={
            s.dictationTriggerMode === "hold"
              ? "Hold to talk, release to insert."
              : "Two quick taps start recording, one tap ends it."
          }
        >
          <Select
            width="lg"
            value={s.dictationModKey}
            onChange={(e) => patch({ dictationModKey: e.target.value as DictationModKey })}
          >
            {MOD_KEY_CHOICES.map((k) => (
              <option key={k} value={k}>
                {modKeyLabel(k)}
              </option>
            ))}
          </Select>
        </Item>
      )}

      {s.dictationTriggerMode !== "combo" && (
        <p className="set-note">Fires only when pressed alone.</p>
      )}

      <Item
        name="Recent dictation"
        desc="Hold and tap to step back; release to paste."
      >
        <HotkeyCapture
          value={s.dictationHistoryHotkey}
          onChange={(h) => patch({ dictationHistoryHotkey: h })}
        />
      </Item>

      <Item
        name="Live preview"
        desc="Words appear as you speak."
      >
        <Checkbox
          checked={s.dictationStreaming}
          onChange={(v) => patch({ dictationStreaming: v })}
          label="Stream as I talk"
        />
      </Item>

      <Item
        name="Mute while recording"
        desc="Silences system audio while recording. macOS only."
      >
        <Checkbox
          checked={s.dictationMuteOutput}
          onChange={(v) => patch({ dictationMuteOutput: v })}
          label="Mute other audio"
        />
      </Item>

      <Item name="Indicator" desc="The visualiser drawn in the recording pill.">
        <div className="dictation-waves">
          {DICTATION_WAVE_STYLES.map((w) => (
            <button
              key={w.id}
              type="button"
              title={w.hint}
              className={`btn dictation-wave-opt${
                s.dictationWaveStyle === w.id ? " dictation-wave-on" : ""
              }`}
              onClick={() => patch({ dictationWaveStyle: w.id })}
            >
              <WavePreview style={w.id} />
              <span>{w.label}</span>
            </button>
          ))}
        </div>
      </Item>

      <Item
        name="Model"
        desc="Larger is more accurate."
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
                  <Button className="dictation-model-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      setErr(null);
                      void ipc
                        .dictationDeleteModel(m.id)
                        .then(refresh)
                        .catch((er) => setErr(String(er)));
                    }}>
                    Remove
                  </Button>
                ) : (
                  <Button variant="accent" className="dictation-model-btn"
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
                    }}>
                    Install
                  </Button>
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
              ? "Auto-detect, or pick one."
              : "This model is English-only."
          }
        >
          <Select
            width="lg"
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
          </Select>
        </Item>
      )}

      {err && <div className="set-item-desc set-error">{err}</div>}
    </>
  );
}
