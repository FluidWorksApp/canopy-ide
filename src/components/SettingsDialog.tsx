// The one settings surface, VS Code-style: section nav on the left; each
// setting stacks name → description → control (side-by-side rows squeezed
// long labels into slivers and pushed wide control groups out of the modal).
// Skins render as preview cards — a palette is a thing you look at, not a
// word you read.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyTheme,
  THEME_CHANGE_EVENT,
  getSettings,
  updateSettings,
  THEMES,
  formatHotkey,
  modKeyLabel,
  DEFAULT_DICTATION_HOTKEY,
  DICTATION_WAVE_STYLES,
  type CursorStyle,
  type DictationModKey,
  type DictationTriggerMode,
  type DictationWaveStyle,
  type Hotkey,
  type LinkClickMode,
  type Settings,
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
import { forgetAllMemories } from "../companionMemory";
import { MODEL_SWITCH } from "../agentModels";
import { Mascot } from "./Mascot";
import { Button, Checkbox, Field, Radio, Row, Segmented, Select, Stepper, Switch, TextInput } from "./ui";
import { drawWave } from "../waveStyles";
import { LINK_CHORD } from "../terminalLinks";
import { useEscape } from "../useEscape";
import { TRACKERS, setTrackerKey, trackerKey } from "../trackers";
import * as ipc from "../ipc";
import { refreshEngineSupport } from "../browserHost";
import { VaultSettings } from "./VaultSettings";
import { availableMonoFonts, fontLabel, fontStack } from "../fonts";
import {
  AgentIcon,
  CheckIcon,
  CopyIcon,
  RestartIcon,
  TrackerIcon,
} from "./icons";
import {
  AGENT_CLIS,
  binName,
  BUILTIN_AGENT_CLIS,
  checkInstalledClis,
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
import { format, formatChord, modifierOnly, resolve } from "../shortcuts";

export type SettingsTab =
  | "appearance"
  | "agents"
  | "editor"
  | "terminal"
  | "spotsearch"
  | "clipboard"
  | "dictation"
  | "integrations"
  | "browser"
  | "remote"
  | "vault"
  | "privacy";

interface SettingsDialogProps {
  onClose: () => void;
  initialTab?: SettingsTab;
}

/** Ordered, and grouped by what you came here to change: how it looks, what
 *  the agents do, what reaches out of this machine. Eleven flat entries was a
 *  list you had to read end to end; three headings turn it into three short
 *  ones you can skip. */
const TABS: { id: SettingsTab; label: string; group: string }[] = [
  { id: "appearance", label: "Appearance", group: "Look" },
  { id: "editor", label: "Editor", group: "Look" },
  { id: "terminal", label: "Terminal", group: "Look" },
  { id: "agents", label: "Agents", group: "Agents" },
  { id: "dictation", label: "Dictation", group: "Agents" },
  { id: "spotsearch", label: "SpotSearch", group: "Agents" },
  { id: "clipboard", label: "Clipboard", group: "Agents" },
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
 *  aren't skins are spelled out here: Auto previews as a split card — Default
 *  when the OS is dark, Daylight when light — and Custom previews the user's
 *  own accent on the Default base. */
const NON_SKIN_PREVIEWS: Record<
  "auto" | "custom",
  { bg: string; raised: string; text: string; accent?: string; note: string }
> = {
  auto: {
    bg: "linear-gradient(105deg, #1a1b26 50%, #f5f6f8 50%)",
    raised: "#1f2335",
    text: "#f5f6f8",
    accent: "#7aa2f7",
    note: "follows the OS",
  },
  custom: { bg: "#1a1b26", raised: "#1f2335", text: "#c9d1d9", note: "your accent" },
};

function skinPreview(id: Theme) {
  if (id === "auto" || id === "custom") return NON_SKIN_PREVIEWS[id];
  const s = skinDef(id);
  return { ...s.preview, note: s.note };
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
 * Lives under the mascot picker rather than in Agents, because the question it
 * answers is "what is that face doing on my screen" — and the CLI it runs on is
 * a detail of *this* choice, not another entry in the list of agents that write
 * code.
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
  const models = chosen ? MODEL_SWITCH[chosen.id] : undefined;
  const name = s.companionName.trim() || mascotDef(s.mascot).label;
  const authority = COMPANION_AUTHORITIES.find((a) => a.id === s.companionAuthority);

  return (
    <Item
      name={`${name} as a companion`}
      tag="Starts an agent"
      desc={`A floating assistant across every project, with its own chat and session.`}
    >
      <Row>
        <Switch
          checked={s.companionEnabled}
          onChange={(v) => patch({ companionEnabled: v })}
          aria-label={`Enable ${name} as a companion`}
        />
        <span className="set-hint">
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
                <span className="set-hint">{chosen ? "Chosen by the agent" : "—"}</span>
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
                <span className="set-hint">{authority?.note}</span>
              </span>
            </Field>
            <Field label=" ">
              <Button
                onClick={() => {
                  if (!chosen) return;
                  forgetCompanionSession(chosen.id);
                  clearRun(chosen.id);
                  clearCompanionView();
                  // Clearing only the conversation would leave a "new"
                  // companion that still knows you.
                  void forgetAllMemories();
                }}
                disabled={!chosen}
                title={`Forget everything ${name} knows. Not undoable.`}
              >
                Start over
              </Button>
            </Field>
          </Row>
        </>
      )}
    </Item>
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
  return (
    <div className="set-item">
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
 * Account profiles: more than one login per CLI.
 *
 * Canopy never sees a token — signing in happens in a terminal, in the CLI's
 * own browser flow, against the profile's config dir. Hence no "paste your
 * key" field here. Only CLIs with a config-home variable can hold one.
 */
function AgentAccounts({
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
          `Created "${p.label}". Sign it in below — the CLI opens its own login in a terminal.`,
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
        const signedIn = (accounts[p.id] ?? []).filter((a) => a.state === "in");
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
              {signedIn.length
                ? signedIn
                    .map((a) => a.account ?? a.agent)
                    .join(" · ")
                : "no logins yet"}
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
              const signedIn = st?.state === "in";
              return (
                <div key={cli.id} className="cli-account-cli">
                  <AgentIcon id={cli.id} size={13} />
                  <span className="cli-account-cli-name">{cli.name}</span>
                  <span
                    className={`cli-account-who ${signedIn ? "" : "cli-account-who-out"}`}
                    title={
                      signedIn
                        ? `${cli.name} is signed in as ${st?.account ?? "this account"}`
                        : st?.state === "unknown"
                          ? `Canopy can't read ${cli.name}'s sign-in state — it keeps credentials somewhere we haven't verified`
                          : `No ${cli.name} login in this account yet`
                    }
                  >
                    {signedIn
                      ? (st?.account ?? "signed in")
                      : st?.state === "unknown"
                        ? "—"
                        : "not signed in"}
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

      <p className="cli-account-note">
        Claude Code, Codex, OpenCode and Amp can hold a second login. Antigravity,
        oh-my-pi and Aider always use the account they're signed into.
      </p>
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
      <Button
        onClick={() => commit([...rows, { id: "", name: "", bin: "" }])}>
        ＋ Add a CLI
      </Button>
    </div>
  );
}

/** The modifier half of the Settings section jump, resolved once — the nav
 *  badges render it and the key handler matches on it, so a badge can never
 *  advertise a key the handler does not answer. */
const SECTION_MOD = resolve("settings-section")!;

export function SettingsDialog({ onClose, initialTab = "appearance" }: SettingsDialogProps) {
  // "vault" is still a valid deep-link target (agentOps and the status bar
  // both open it by name); it now lands on the tab the vault lives in.
  const [tab, setTab] = useState<SettingsTab>(
    initialTab === "vault" ? "browser" : initialTab,
  );
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
  // Chromium-family browsers found on this machine. Unlike browserOk this is an
  // installation fact, not a platform one — it can change while the dialog is
  // open, which is why the section offers a re-scan.
  const [browsers, setBrowsers] = useState<ipc.DetectedBrowser[]>([]);
  const [clearing, setClearing] = useState<null | "busy" | "done" | string>(null);
  const fonts = availableMonoFonts();

  useEffect(() => {
    void ipc.chromiumDetect().then(setBrowsers).catch(() => {});
  }, []);

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
        <div className="settings-layout">
          <nav className="settings-nav">
            <div className="settings-title">Settings</div>
            {visibleTabs.map((t, i) => (
              <Fragment key={t.id}>
                {/* A heading only where the group actually turns over. */}
                {(i === 0 || visibleTabs[i - 1].group !== t.group) && (
                  <div className="settings-nav-group">{t.group}</div>
                )}
                <button
                  className={`settings-nav-item ${tab === t.id ? "settings-nav-active" : ""}`}
                  onClick={() => setTab(t.id)}
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
            {tab === "appearance" && (
              <>
                <Item
                  name="Skin"
                  tag="Applies immediately"
                  desc="Colours for the whole app."
                >
                  <div className="skin-grid">
                    {THEMES.map((t) => {
                      const p = skinPreview(t.id);
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
                          <span className="skin-note">{p.note}</span>
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
                  name="Mascot"
                  tag="Applies immediately"
                  desc="The face Canopy shows in agents, notifications and empty screens."
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

            {tab === "agents" && (
              <>
                <Item
                  name="Default agent"
                  desc="What the Start button launches; pick another per ticket."
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
                  desc="Leave blank unless yours was renamed or lives off your PATH."
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
                  desc="Agents Canopy ships no entry for. Each one joins the launcher."
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
                  desc="What agents can do through Canopy's MCP server. Off means never offered."
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
                  name="Stack tabs by status"
                  desc="Fold the agent strip into three stacks: Needs you, Working, Idle."
                >
                  <Checkbox
                    checked={s.groupTabsByStatus}
                    onChange={(v) => patch({ groupTabsByStatus: v })}
                    label="Keep agents that need you on the left, quiet ones stacked away"
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
                  desc="Reclaim memory from idle agents past the limit below; they stay resumable."
                >
                  <Checkbox
                    checked={s.autoHibernate}
                    onChange={(v) => patch({ autoHibernate: v })}
                    label="Hibernate the stalest idle agents past the limit"
                  />
                </Item>
                <Item
                  name="Live agents per project"
                  desc="Agent terminals to keep before hibernation reclaims the stalest idle ones."
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
                  name="Set up new workspaces"
                  desc="Copy the gitignored config and install dependencies, so it builds right away."
                >
                  <Checkbox
                    checked={s.workspaceBootstrap}
                    onChange={(v) => patch({ workspaceBootstrap: v })}
                    label="Prepare a workspace when it's created"
                  />
                </Item>
                <Item
                  name="Workspace ports"
                  desc="What your main checkout serves on; each workspace takes the next free port."
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
              </>
            )}

            {tab === "editor" && (
              <>
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
                  name="Link click"
                  desc="How to follow a URL an agent printed."
                >
                  <Select
                    width="lg"
                    value={s.terminalLinkClick}
                    onChange={(e) =>
                      patch({ terminalLinkClick: e.target.value as LinkClickMode })
                    }
                  >
                    <option value="click">Click opens the link</option>
                    <option value="modifier">{`${LINK_CHORD} opens the link`}</option>
                  </Select>
                </Item>
                <Item
                  name="Scrollback"
                  desc="Lines of history each terminal keeps; applies to new terminals."
                >
                  <TextInput
                    type="number"
                    width="sm"
                    aria-label="Scrollback"
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

            {tab === "spotsearch" && <SpotSearchSettings s={s} patch={patch} />}
            {tab === "clipboard" && <ClipboardSettings s={s} patch={patch} />}


            {tab === "dictation" && dictationOk && <DictationSettings />}

            {tab === "remote" && <RemoteSettings runInTerminal={runInTerminal} />}

            {tab === "privacy" && (
              <>
                <Item
                  name="Crash reporting"
                  desc="An anonymous email to the maintainers — the error and stack, app version and OS. Filing a GitHub issue instead is always offered."
                >
                  <Checkbox
                    checked={s.crashReporting}
                    onChange={(v) => patch({ crashReporting: v })}
                    label="Offer to send anonymous crash reports"
                  />
                </Item>
              </>
            )}

            {tab === "browser" && (
              <>
                <Item
                  name="Links"
                  desc="Where a link opens: a preview tab here, or your OS browser."
                >
                  <Checkbox
                    checked={s.openLinksInApp}
                    onChange={(v) => patch({ openLinksInApp: v })}
                    label="Open links in Canopy"
                  />
                </Item>
                <Item
                  name="Engine"
                  desc="How preview tabs show a page. The trade is logins against layering."
                >
                  {browserOk ? (
                    <div className="set-checks">
                      <Radio
                        name="browser-engine"
                        checked={s.browserEngine === "proxy"}
                        onChange={() => patch({ browserEngine: "proxy" })}
                        label="Loopback proxy"
                        hint="Always visible and screenshot-able. One shared session."
                      />
                      <Radio
                        name="browser-engine"
                        checked={s.browserEngine === "webview"}
                        onChange={() => patch({ browserEngine: "webview" })}
                        label="Embedded browser"
                        hint="Real logins, kept across restarts. Hidden while a panel covers it."
                      />
                      <Radio
                        name="browser-engine"
                        disabled={browsers.length === 0 && !s.chromiumPath.trim()}
                        checked={s.browserEngine === "chromium"}
                        onChange={() => patch({ browserEngine: "chromium" })}
                        label="Chrome or Chromium"
                        hint={
                          browsers.length || s.chromiumPath.trim()
                            ? "Drives a browser you already have, on a profile of its own."
                            : "None found. Install one, or point Canopy at a binary below."
                        }
                      />
                      <p className="set-item-desc">
                        Open tabs keep the engine they started on.
                      </p>
                    </div>
                  ) : (
                    <p className="set-item-desc">
                      Loopback proxy only — the embedded browser is macOS-only so far.
                    </p>
                  )}
                </Item>
                <Item
                  name="Chrome binary"
                  desc="Which browser the Chrome engine drives. Canopy never downloads one."
                >
                  <div className="set-inline">
                    <Select
                      width="lg"
                      value={s.chromiumPath}
                      onChange={(e) => patch({ chromiumPath: e.target.value })}
                    >
                      <option value="">
                        {browsers.length
                          ? `Detected — ${browsers[0].name}`
                          : "Detected — nothing found"}
                      </option>
                      {browsers.map((b) => (
                        <option key={b.path} value={b.path}>
                          {b.name}
                        </option>
                      ))}
                    </Select>
                    <Button
                      onClick={() => {
                        void ipc.chromiumDetect().then(setBrowsers);
                        void refreshEngineSupport();
                      }}
                    >
                      Re-scan
                    </Button>
                  </div>
                  <p className="set-item-desc">
                    Launched on a profile of its own, never your everyday one.
                  </p>
                </Item>
                <Item
                  name="Browsing data"
                  desc="Every preview tab shares one profile. Clearing it signs you out of all of them."
                >
                  <div className="set-inline">
                    <Button
                      disabled={!browserOk || clearing === "busy"}
                      onClick={() => {
                        setClearing("busy");
                        void ipc.browserClearData().then(
                          () => setClearing("done"),
                          (err) => setClearing(String(err)),
                        );
                      }}>
                      {clearing === "busy" ? "Clearing…" : "Clear browsing data"}
                    </Button>
                    {clearing === "done" && (
                      <span className="set-item-desc">Cleared. Reload any open page to see it.</span>
                    )}
                    {typeof clearing === "string" && clearing !== "busy" && clearing !== "done" && (
                      <span className="set-item-desc">{clearing}</span>
                    )}
                  </div>
                </Item>
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
                            Connected. The key is stored locally on this machine only.
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
                              ? "The GitHub CLI (gh) isn't installed; Canopy uses it for issues and pull requests."
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
                        <div className="set-item-desc set-note">
                          Sign-in runs in a terminal; gh keeps the token in your
                          keychain, Canopy never sees it.
                        </div>
                      </>
                    )}
                  </div>
                ))}
                <div className="set-item-desc" data-v={keysVersion}>
                  Connected trackers show up in the ◎ Issues panel.
                </div>
              </>
            )}
          </div>
        </div>
        <div className="settings-footer">
          <div className="settings-footer-note">
            Everything here applies immediately and is stored on this machine only.
          </div>
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

/** Modifiers offered as a bare trigger, ordered by how safe each is to bind.
 *  The right-hand keys come first because a touch typist reaches for them
 *  least, so the pollution rule has the least work to do; the "either side"
 *  entries are last because they are the most likely to be pressed by
 *  accident. */
const MOD_KEY_CHOICES: DictationModKey[] = [
  "MetaRight",
  "AltRight",
  "ControlRight",
  "ShiftRight",
  "CapsLock",
  "MetaLeft",
  "AltLeft",
  "ControlLeft",
  "ShiftLeft",
  "Meta",
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
    // A skin whose surfaces are alpha (Vitrine's are — they composite over an
    // ambient field this page paints and the portal's page does not) declares
    // an opaque mirror per surface. Prefer it: sending `rgba(255,255,255,.03)`
    // as the portal's background is a white page with near-white text on it.
    const val = (
      cs.getPropertyValue(`--${v}-opaque`).trim() ||
      cs.getPropertyValue(`--${v}`).trim()
    );
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
      <Item name="Remote access" desc="Drive your agents from your phone, behind a PIN.">
        <div className="set-inline">
          <Switch
            checked={on}
            disabled={busy}
            aria-label="Remote access"
            onChange={() => run(on ? ipc.remoteDisable : ipc.remoteEnable)}
          />
          {on && (
            <span className="set-warn">
              Anyone with the PIN can drive your agents — turn this off when you're done.
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
                    : "↻ A new link each session. For one that stays the same, use Tailscale Funnel."}
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
        desc="Which kinds of result the omnibox offers. Nothing is deleted when you switch one off."
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
        desc={`Full-text search over each CLI's own session files, so ${format(
          "spot-search",
        )} finds a conversation by something said in it. Off deletes what it indexed.`}
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
            Amp isn't listed — its threads live on Sourcegraph's servers.
          </p>
        </div>
      </Item>

      <Item
        name="Terminal scrollback"
        desc="Searchable while a terminal is open; dropped when it closes."
      >
        <Checkbox
          checked={s.spotIndexTerminals}
          onChange={(v) => patch({ spotIndexTerminals: v })}
          label="Index open terminals' scrollback"
        />
      </Item>

      <Item
        name="Scope"
        desc="How far a search reaches: this project, or every one on this machine."
      >
        <Checkbox
          checked={s.spotSearchAllProjects}
          onChange={(v) => patch({ spotSearchAllProjects: v })}
          label="Search every project, not just this one"
        />
      </Item>

      <Item
        name="Keep history for"
        desc={`How far back ${format(
          "spot-search",
        )} can see. Older messages are dropped from the index; zero keeps everything.`}
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
        desc="A SQLite database in ~/.canopy, rebuilt from files that still exist."
      >
        <div className="spot-set-index">
          <p className="set-item-desc">
            {stats
              ? `${stats.messages.toLocaleString()} messages from ${stats.sessions.toLocaleString()} conversations, ${stats.terminals} terminal${
                  stats.terminals === 1 ? "" : "s"
                } · ${fmtBytes(stats.bytes)}`
              : `Not built yet — it fills the first time you open ${format("spot-search")}.`}
          </p>
          {pending !== null && (
            <p className="set-item-desc">
              {pending > 0
                ? `${fmtBytes(pending)} of transcript still unread — Canopy keeps reading in the background.`
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
  default: "macOS will ask once, the first time a copy is captured.",
  ask: "macOS asks before each read. Set Canopy to “Always Allow” in System Settings → Privacy & Security → Pasteboard.",
  allow: "macOS always allows Canopy the pasteboard.",
  deny: "macOS denies Canopy the pasteboard, so nothing is captured. Change it in System Settings → Privacy & Security → Pasteboard.",
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
        desc="Not available on this platform yet — capture is macOS-only so far."
      >
        <span className="set-item-desc">Unavailable here.</span>
      </Item>
    );
  }

  return (
    <>
      <Item
        name="Keep what I copy"
        desc="Every copy is kept and offered back under Clipboard in ⌘K."
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
          Read only when the clipboard changes — never on a timer.
        </p>
      </Item>

      <Item
        name="Passwords and keys"
        desc="A clip that looks like a credential is never written down at all."
      >
        <Checkbox
          checked={s.clipboardSkipSecrets}
          onChange={(v) => patch({ clipboardSkipSecrets: v })}
          label="Skip clips that look like credentials"
        />
        <p className="set-item-desc">
          Key prefixes (<code>sk-</code>, <code>ghp_</code>, <code>AKIA</code>…),
          private keys, <code>TOKEN=</code> lines and long high-entropy tokens.
          Paths, URLs and prose are exempt.
        </p>
        <p className="set-item-desc">
          Clips marked concealed by a password manager are always skipped.
        </p>
      </Item>

      <Item
        name="Where it's kept"
        desc="Kept in ~/.canopy/clipboard.sqlite — your account only, and not encrypted."
      >
        <Checkbox
          checked={s.clipboardPersist}
          onChange={(v) => patch({ clipboardPersist: v })}
          label="Keep the history on disk between launches"
        />
        <p className="set-item-desc">
          Off deletes the file and keeps this session in memory only.
        </p>
      </Item>

      <Item
        name="How much to keep"
        desc="The newest clips, up to this many. Older ones fall off the end."
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
        desc="The only copy — nothing here can be rebuilt, so clearing it is permanent."
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
              ? "Hold to talk, let go to insert. Double-tap for hands-free."
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
        <p className="set-note">
          {modKeyLabel(s.dictationModKey)} still works as a modifier — dictation
          fires only when nothing else is pressed with it.
          {s.dictationModKey === "CapsLock" && " Caps Lock still latches."}
        </p>
      )}

      <Item
        name="Recent dictation"
        desc="Hold and tap to walk back through what you said; let go to paste."
      >
        <HotkeyCapture
          value={s.dictationHistoryHotkey}
          onChange={(h) => patch({ dictationHistoryHotkey: h })}
        />
      </Item>

      <Item
        name="Live preview"
        desc="Words appear as you speak. Costs a CPU core; the final text is the same."
      >
        <Checkbox
          checked={s.dictationStreaming}
          onChange={(v) => patch({ dictationStreaming: v })}
          label="Stream as I talk"
        />
      </Item>

      <Item
        name="Mute while recording"
        desc="Silences system audio while the mic is open. macOS only."
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
              ? "Auto-detect works well; pick one to bias transcription."
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
