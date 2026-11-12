// The searchable list of settings: one entry per <Item> in SettingsDialog.tsx,
// plus a few for panels that are not built from Item (Teams, Vault, Remote
// workspaces...). settingsIndex.test.ts parses SettingsDialog.tsx and fails if a
// setting there is missing here or listed under the wrong tab, so a new setting
// cannot ship unsearchable.
import type { SettingsTab } from "./SettingsDialog";

export interface SettingEntry {
  tab: SettingsTab;
  name: string;
  desc?: string;
  tag?: string;
  /** Words a person might type that the name and description do not contain. */
  keywords?: string[];
  /** A whole panel rather than one row: no anchor to scroll to. */
  panel?: boolean;
}

export const SETTINGS_INDEX: SettingEntry[] = [
  { tab: "account", name: "Accounts", desc: "Your balance and workspace usage.", keywords: ["billing", "balance", "credits", "subscription", "sign in", "login", "usage"] },
  { tab: "rules", name: "Rules", desc: "Team rules and which CLIs enforce them.", keywords: ["instructions", "AGENTS.md", "CLAUDE.md", "guidelines", "prompt"] },
  { tab: "appearance", name: "Skin", desc: "Colours for the whole app.", tag: "Applies immediately", keywords: ["theme", "dark mode", "light mode", "colors", "look"] },
  { tab: "appearance", name: "Accent color", desc: "Overrides the skin's accent; leave unset to keep it.", keywords: ["colour", "theme", "highlight"] },
  { tab: "appearance", name: "Side panel", desc: "How the rail's panels open and close.", keywords: ["sidebar", "panel width", "layout"] },
  { tab: "mascot", name: "Mascot", desc: "Shown in agents and notifications.", tag: "Applies immediately", keywords: ["companion", "buddy", "character"] },
  { tab: "brain", name: "Brain", desc: "The CLI that powers Canopy's smart features.", keywords: ["llm", "model", "ai", "intelligence"] },
  { tab: "brain", name: "Brain spending", desc: "Today's spend and daily caps per feature.", keywords: ["cost", "budget", "money"] },
  { tab: "brain", name: "Features not using your brain", desc: "Per-feature overrides. The rest follow the brain." },
  { tab: "brain", name: "Automatic brain work", desc: "Small background calls the brain makes on its own." },
  { tab: "agents", name: "Fleet readiness", desc: "What can launch now." },
  { tab: "notifications", name: "Ask for attention", desc: "Let agents bring their tab to the front.", keywords: ["notify", "alert", "bell", "badge", "sound"] },
  { tab: "agents", name: "Agent delegation", desc: "Let agents open agent tabs.", keywords: ["subagents", "spawn", "delegate"] },
  { tab: "agents", name: "Plan before an agent starts", desc: "Plan first; risky work waits for approval.", keywords: ["planning", "approval", "review plan"] },
  { tab: "agents", name: "Intent & evidence review", desc: "Open reviews on plan, receipt and risk map first.", keywords: ["verification", "proof", "review"] },
  { tab: "brain", name: "Agent awareness", desc: "Tell other agents on the same code what changed.", keywords: ["context", "who is working", "claims"] },
  { tab: "agents", name: "CLI updates", desc: "Keep local agent CLIs updated.", keywords: ["upgrade", "version", "auto update"] },
  { tab: "sessions", name: "Session budget", desc: "Per-session cap: warns at 80%, pauses at 100%.", keywords: ["cost", "spend", "money", "limit", "tokens", "billing"] },
  { tab: "sessions", name: "Prototype session cap", desc: "Cap for Build projects. Empty for none.", keywords: ["cost", "spend", "limit", "budget"] },
  { tab: "sessions", name: "At the budget", desc: "What happens when a session hits its budget.", keywords: ["cost", "spend", "limit", "stop", "pause"] },
  { tab: "sessions", name: "Spend & outcomes", desc: "Track outcomes locally.", keywords: ["cost", "spending", "money", "report", "usage"] },
  { tab: "brain", name: "Builder lens summaries", desc: "Explain each saved step in plain words." },
  { tab: "agents", name: "Claude Code editor link", desc: "Let Claude Code use Canopy as its IDE." },
  { tab: "agents", name: "Turn rollback", desc: "Snapshot each turn so it can be undone.", keywords: ["undo", "revert", "checkpoint"] },
  { tab: "agents", name: "Session documents", desc: "View a session as a document." },
  { tab: "agents", name: "Proof receipts", desc: "Check the work after each agent finishes.", keywords: ["evidence", "audit", "log"] },
  { tab: "brain", name: "Memory monitoring prompts", desc: "Show memory warnings.", keywords: ["ram", "memory pressure", "warnings"] },
  { tab: "brain", name: "Memory allowance maximums", desc: "Max allowance per agent.", keywords: ["ram", "limit", "memory"] },
  { tab: "notifications", name: "Notification pop-ups", desc: "Interrupt, or wait in the bell.", keywords: ["alerts", "toasts", "banners", "desktop notifications"] },
  { tab: "notifications", name: "Team messages", desc: "Notify on teammate messages.", keywords: ["chat", "notifications", "mentions"] },
  { tab: "agents", name: "Default agent", desc: "What Start launches.", keywords: ["cli", "default", "start"] },
  { tab: "agents", name: "Use ACP", desc: "Run these agents over the Agent Client Protocol. Off uses the agent's built-in runner.", keywords: ["acp", "agent client protocol", "protocol", "runner"] },
  { tab: "agents", name: "Skip permission prompts", desc: "Run every agent in its CLI's bypass mode.", keywords: ["yolo", "dangerously", "auto approve", "permissions"] },
  { tab: "agents", name: "CLI commands", desc: "Leave blank unless renamed or off your PATH.", keywords: ["launch", "flags", "arguments"] },
  { tab: "agents", name: "Accounts", desc: "Several logins per CLI. Pick one from the ＋ menu.", keywords: ["logins","sign in","cli accounts","profiles"] },
  { tab: "agents", name: "ACP providers", desc: "Add any ACP agent, from presets or the registry.", keywords: ["acp", "agent client protocol", "registry", "gemini", "goose", "provider"], panel: true },
  { tab: "agents", name: "Other CLIs", desc: "Add agents Canopy doesn't list.", keywords: ["custom agent", "add cli", "binary"] },
  { tab: "agents", name: "Tools available", desc: "What agents can do through Canopy. Off hides it.", keywords: ["detect", "installed", "path", "binaries"] },
  { tab: "sessions", name: "Ctrl+Tab switching", desc: "Switcher order.", keywords: ["tab switch", "cycle", "mru", "keyboard"] },
  { tab: "sessions", name: "Stack tabs by status", desc: "Group agents: Needs you, Working, Idle.", keywords: ["group tabs", "order", "sort"] },
  { tab: "sessions", name: "Settle into Idle after", desc: "Seconds of quiet before a tab drops into Idle.", keywords: ["idle", "timeout", "status"] },
  { tab: "sessions", name: "Hibernate idle agents", desc: "Free memory from idle agents. They stay resumable.", keywords: ["sleep", "idle", "resources", "pause"] },
  { tab: "sessions", name: "Live agents per project", desc: "Terminals kept before idle ones hibernate.", keywords: ["limit", "concurrent", "parallel", "cap"] },
  { tab: "sessions", name: "Restore sessions I close", desc: "Also keep sessions you closed.", keywords: ["undo", "reopen", "recent"] },
  { tab: "sessions", name: "New agents get a workspace", desc: "Open each new agent in its own worktree.", keywords: ["worktree", "branch", "isolation", "git"] },
  { tab: "sessions", name: "Set up new workspaces", desc: "Copy config and install deps.", keywords: ["install", "dependencies", "bootstrap"] },
  { tab: "sessions", name: "Workspace ports", desc: "Base port. Each workspace takes the next free one.", keywords: ["ports", "dev server", "localhost", "conflict"] },
  { tab: "editor", name: "Keyboard shortcuts", tag: "Cross-platform", keywords: ["hotkeys", "keybindings", "chords", "keys"] },
  { tab: "editor", name: "Font and cursor", desc: "Monospace fonts found on this machine.", tag: "New files only", keywords: ["font size", "typeface", "cursor style", "blink", "line height"] },
  { tab: "editor", name: "File associations", desc: "Which language each file type is highlighted as.", keywords: ["syntax", "language", "highlighting", "extensions", "monaco"] },
  { tab: "terminal", name: "Automatic session names", desc: "Agent callsign words.", tag: "New terminals only", keywords: ["titles", "rename", "tab names"] },
  { tab: "terminal", name: "Font and cursor", desc: "Monospace fonts found on this machine.", tag: "New terminals only", keywords: ["font size", "typeface", "cursor style", "blink", "line height"] },
  { tab: "terminal", name: "Scrollback", desc: "Lines kept per terminal. New terminals only.", keywords: ["history", "buffer", "lines", "memory"] },
  { tab: "terminal", name: "Keep terminals running after quit", desc: "Terminals and agents stay alive for 2 hours after you quit or update, and reconnect on next launch. Applies after restart. Mac and Linux.", keywords: ["persistent", "quit", "update", "background", "reconnect", "survive", "host"] },
  { tab: "privacy", name: "Files outside projects", desc: "Open them from terminal links.", keywords: ["links", "terminal", "outside", "folders", "open file", "privacy"] },
  { tab: "privacy", name: "Crash reporting", desc: "Send crash details anonymously.", keywords: ["telemetry", "diagnostics", "errors", "privacy"] },
  { tab: "remote", name: "Remote access", desc: "Use your agents from your phone.", keywords: ["phone", "mobile", "tunnel", "pairing"] },
  { tab: "remote", name: "Your link", desc: "Permanent link.", keywords: ["url", "bookmark", "phone", "share"] },
  { tab: "remote", name: "On this network", desc: "Local address, with PIN.", keywords: ["lan", "pin", "local address", "wifi"] },
  { tab: "remote", name: "Remote access", desc: "Phone access behind a PIN. Sign in to Canopy for your own link.", keywords: ["phone", "mobile", "tunnel", "pairing"] },
  { tab: "remote", name: "Reach", keywords: ["internet", "tunnel", "access", "exposure"] },
  { tab: "remote", name: "Public link", desc: "One tunnel, shared with internet team sessions.", keywords: ["tunnel", "cloudflare", "ngrok", "tailscale", "share"] },
  { tab: "remote", name: "Scan to connect", keywords: ["qr", "phone", "pair"] },
  { tab: "remote", name: "Tailscale", desc: "Uses the Tailscale app on this machine.", keywords: ["tailnet", "vpn", "machines", "allow", "connect", "terminal"] },
  { tab: "spotsearch", name: "Conversations to index", desc: "Search past conversations by content." },
  { tab: "spotsearch", name: "Terminal scrollback", desc: "Searchable while open; dropped on close." },
  { tab: "spotsearch", name: "Scope", desc: "This project, or every project on this machine." },
  { tab: "spotsearch", name: "Keep history for", desc: "0 keeps everything." },
  { tab: "spotsearch", name: "The index" },
  { tab: "clipboard", name: "Clipboard history", desc: "macOS only.", keywords: ["copy", "paste", "history"] },
  { tab: "clipboard", name: "Keep what I copy", desc: "Copies appear under Clipboard in ⌘K." },
  { tab: "clipboard", name: "Passwords and keys", desc: "Credential-like clips are never saved.", keywords: ["secrets", "sensitive", "ignore", "privacy"] },
  { tab: "clipboard", name: "Where it's kept", desc: "Stored unencrypted." },
  { tab: "clipboard", name: "How much to keep" },
  { tab: "clipboard", name: "The history", desc: "Clearing is permanent." },
  { tab: "dictation", name: "Trigger", desc: "How to open the mic. Esc cancels. Runs locally.", keywords: ["hotkey", "push to talk", "voice"] },
  { tab: "dictation", name: "Shortcut", desc: "Press to start dictating, again to insert." },
  { tab: "dictation", name: "Key" },
  { tab: "dictation", name: "Recent dictation", desc: "Hold and tap to step back; release to paste." },
  { tab: "dictation", name: "Live preview", desc: "Words appear as you speak." },
  { tab: "dictation", name: "Mute while recording", desc: "Silences system audio while recording. macOS only.", keywords: ["audio", "volume"] },
  { tab: "dictation", name: "Indicator", desc: "The visualiser drawn in the recording pill." },
  { tab: "dictation", name: "Model", desc: "Larger is more accurate.", keywords: ["whisper", "voice model", "download"] },
  { tab: "dictation", name: "Language", keywords: ["speech", "locale"] },
  // Panels that are not made of Item rows.
  { tab: "account", name: "Billing and sign-in", keywords: ["billing", "balance", "credits", "subscription", "plan", "sign in", "login", "usage", "payment"], panel: true },
  { tab: "teams", name: "Organizations and members", keywords: ["organization", "org", "members", "invite", "roles", "admin", "people", "team"], panel: true },
  { tab: "integrations", name: "GitHub, Slack and other connections", keywords: ["github", "gh", "git", "slack", "linear", "jira", "connect", "oauth", "login"], panel: true },
  { tab: "browser", name: "Preview browser", keywords: ["chrome", "embedded", "logins", "cookies", "sign out", "profile", "preview"] },
  { tab: "browser", name: "Browser and password vault", keywords: ["vault", "passwords", "logins", "cookies", "playwright", "token", "autofill", "browser"], panel: true },
  { tab: "remote", name: "Remote workspaces", keywords: ["cloud", "vm", "workspace", "tailscale", "ssh", "host", "connect", "server"], panel: true },
];
/** Where a setting's row lives on the page, so a search result can scroll to it.
 *  Tab and name together: names repeat across tabs ("Font and cursor"). */
export const settingAnchor = (tab: string, name: string) =>
  `setting-${tab}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;

export interface SettingHit {
  entry: SettingEntry;
  score: number;
  /** null for a whole panel: open the tab, there is no row to scroll to. */
  anchor: string | null;
}

/**
 * Every word typed must match somewhere. A name beats a keyword beats the
 * description beats the tab's own label, so "font" lists the font settings
 * before anything that merely mentions fonts.
 */
export function searchSettings(
  query: string,
  options: { tabLabels?: Partial<Record<SettingsTab, string>>; index?: SettingEntry[]; limit?: number } = {},
): SettingHit[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const hits: SettingHit[] = [];
  for (const entry of options.index ?? SETTINGS_INDEX) {
    const name = entry.name.toLowerCase();
    const nameWords = name.split(/[^a-z0-9]+/).filter(Boolean);
    const words = (entry.keywords ?? []).map((k) => k.toLowerCase());
    const text = `${entry.desc ?? ""} ${entry.tag ?? ""}`.toLowerCase();
    const tab = (options.tabLabels?.[entry.tab] ?? entry.tab).toLowerCase();
    let score = 0;
    let matched = true;
    for (const token of tokens) {
      const s =
        name === token ? 120
        : name.startsWith(token) ? 100
        : nameWords.some((w) => w.startsWith(token)) ? 80
        : name.includes(token) ? 60
        : words.some((w) => w === token || w.startsWith(token)) ? 45
        : words.some((w) => w.includes(token)) ? 35
        : text.includes(token) ? 20
        : tab.includes(token) ? 10
        : 0;
      if (!s) { matched = false; break; }
      score += s;
    }
    if (matched) hits.push({ entry, score, anchor: entry.panel ? null : settingAnchor(entry.tab, entry.name) });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  // One result per row: a setting that exists in two modes is indexed twice.
  const seen = new Set<string>();
  const unique = hits.filter((h) => {
    const key = `${h.entry.tab}:${h.entry.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, options.limit ?? 40);
}
