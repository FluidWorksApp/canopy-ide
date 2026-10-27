// Team memory, in plain language: what the team decided, the constraints the
// code lives under, its conventions, and facts about the environment — each
// with who recorded it, which session it came from, how old it is and when it
// stops being trusted.
//
// The panel is the approval gate. The brain proposes entries after agent
// turns and agents propose them through canopy_memory_propose, but nothing
// reaches an agent until someone here approves it. Entries from a session that
// read the outside world (a web page, a ticket, PR comments) are quarantined:
// they say what was read, and approving them is a deliberate "Approve anyway".
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as ipc from "../ipc";
import { useMemories, type MemoryRow } from "../useMemories";
import { brainConnection, subscribeBrainConnection } from "../brainStatus";
import {
  approveMemory,
  editMemory,
  expireMemory,
  memoryStatus,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  nearExpiry,
  needsReview,
  reconfirmMemory,
  rejectMemory,
  renderMemorySection,
  spliceMemorySection,
  supersedeWith,
  type MemoryEntry,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
} from "../memoryLedger";
import { agentCliFor } from "../projects";
import { getSettings, subscribeSettings } from "../settings";
import { Button, Segmented, Select, TextInput } from "./ui";
import "./memoryPanel.css";

const TYPE_LABEL: Record<MemoryType, string> = {
  decision: "Decision",
  constraint: "Constraint",
  convention: "Convention",
  fact: "Fact",
};
const TYPE_BLURB: Record<MemoryType, string> = {
  decision: "Choices the team made, and why",
  constraint: "Rules the code has to live within",
  convention: "How the team does things",
  fact: "Things that are true about the setup",
};
const SCOPE_LABEL: Record<MemoryScope, string> = {
  personal: "Just you",
  project: "This project",
  team: "Whole team",
};
const STATUS_LABEL: Record<MemoryStatus, string> = {
  proposed: "Needs review",
  quarantined: "Quarantined",
  approved: "In use",
  rejected: "Rejected",
  expired: "Expired",
  superseded: "Replaced",
};

type View = "review" | "active" | "all";

// ------------------------------------------------------------ helpers

const DAY = 24 * 60 * 60 * 1000;

function age(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < DAY) return `${Math.floor(d / 3_600_000)} h ago`;
  const days = Math.floor(d / DAY);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function expiry(ms: number | undefined, now = Date.now()): string {
  if (ms == null) return "never expires";
  const days = Math.ceil((ms - now) / DAY);
  if (days <= 0) return "expires today";
  return days === 1 ? "expires tomorrow" : `expires in ${days} days`;
}

const shortSession = (id?: string) => (id ? id.slice(0, 8) : "");

function authorLine(e: MemoryEntry): string {
  const cli = agentCliFor(e.data.provenance?.cli ?? e.author.cli)?.name;
  const session = shortSession(e.data.provenance?.sessionId ?? e.author.sessionId);
  switch (e.data.source) {
    case "brain":
      return `Noticed by the brain in ${cli ? `a ${cli} session` : "an agent session"}${session ? ` (${session})` : ""}`;
    case "agent":
      return `Proposed by an agent${session ? ` in session ${session}` : e.author.ptyId != null ? ` in terminal ${e.author.ptyId}` : ""}`;
    default:
      return `Added by ${e.author.name}`;
  }
}

function matchesSearch(e: MemoryEntry, q: string): boolean {
  if (!q) return true;
  const hay = `${e.data.text} ${e.data.why} ${(e.data.provenance?.files ?? []).join(" ")}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

// ------------------------------------------------------------ panel

export interface MemoryPanelProps {
  roots: readonly string[];
  /** Jump to the terminal a memory came from, when it is still open. */
  onOpenSession?: (where: { sessionId?: string; ptyId?: number }) => void;
  /** Tests inject the list; the app reads the ledger. */
  load?: (root: string) => Promise<MemoryEntry[]>;
}

export function MemoryPanel({ roots, onOpenSession, load }: MemoryPanelProps) {
  const { rows, loaded, error, reload } = useMemories(roots, load);
  const [view, setView] = useState<View>("review");
  const [type, setType] = useState<MemoryType | "all">("all");
  const [scope, setScope] = useState<MemoryScope | "all">("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const brain = useSyncExternalStore(subscribeBrainConnection, brainConnection);
  const autoExtract = useSyncExternalStore(subscribeSettings, () => getSettings().memoryAutoExtract);

  const reviewCount = rows.filter((r) => needsReview(r.entry)).length;
  // Start where the work is: with nothing to review, show what is in use.
  const viewTouched = useRef(false);
  useEffect(() => {
    if (!viewTouched.current && loaded && reviewCount === 0) setView("active");
  }, [loaded, reviewCount]);

  const live = useMemo(
    () => rows.filter((r) => ["approved", "proposed", "quarantined"].includes(memoryStatus(r.entry))),
    [rows],
  );
  const byId = useMemo(() => new Map(rows.map((r) => [r.entry.data.memoryId, r])), [rows]);

  const shown = rows.filter((r) => {
    const s = memoryStatus(r.entry);
    if (view === "review" && !needsReview(r.entry)) return false;
    if (view === "active" && s !== "approved") return false;
    if (type !== "all" && r.entry.data.type !== type) return false;
    if (scope !== "all" && r.entry.scope !== scope) return false;
    return matchesSearch(r.entry, query.trim());
  });

  const act = async (row: MemoryRow, what: string, fn: () => Promise<unknown>) => {
    setBusy(`${row.entry.data.memoryId}:${what}`);
    setNotice(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  };

  const status = !autoExtract
    ? "Automatic memory is off — turn it on in Settings → Agents."
    : brain.state === "connected" || brain.state === "unknown" || brain.state === "checking"
      ? null
      : "The brain isn't connected, so nothing new is being noticed. Existing memory still works.";

  return (
    <div className="side-panel memory-panel">
      <div className="side-panel-head">
        <span>Team memory</span>
        {reviewCount > 0 && (
          <span className="badge memory-review-badge" aria-label={`${reviewCount} to review`}>
            {reviewCount}
          </span>
        )}
        <span className="status-spacer" />
      </div>
      <p className="memory-intro">
        What your agents are told before they decide something. Nothing here reaches an agent until
        someone approves it.
      </p>
      {status && <p className="memory-state">{status}</p>}
      <div className="memory-filters">
        <Segmented<View>
          aria-label="Which memories"
          value={view}
          onChange={(v) => {
            viewTouched.current = true;
            setView(v);
          }}
          options={[
            { id: "review", label: reviewCount ? `To review (${reviewCount})` : "To review" },
            { id: "active", label: "In use" },
            { id: "all", label: "All" },
          ]}
        />
        <TextInput
          search
          size="sm"
          width="full"
          aria-label="Search memory"
          placeholder="Search memory…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="memory-filter-row">
          <Select size="sm" width="full" aria-label="Kind" value={type} onChange={(e) => setType(e.target.value as MemoryType | "all")}>
            <option value="all">Every kind</option>
            {MEMORY_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}s
              </option>
            ))}
          </Select>
          <Select size="sm" width="full" aria-label="Who it applies to" value={scope} onChange={(e) => setScope(e.target.value as MemoryScope | "all")}>
            <option value="all">Anyone</option>
            {MEMORY_SCOPES.map((s) => (
              <option key={s} value={s}>
                {SCOPE_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {notice && (
        <p className="memory-error" role="alert">
          {notice}
        </p>
      )}
      {error && <p className="memory-error">Couldn't read memory: {error}</p>}
      {loaded && shown.length === 0 && (
        <p className="tree-empty">
          {view === "review"
            ? "Nothing waiting for review. After agents work, the brain suggests the decisions worth keeping here."
            : rows.length === 0
              ? "No team memory yet. When an agent's work settles a decision, it shows up here for you to approve."
              : "Nothing matches."}
        </p>
      )}
      {MEMORY_TYPES.map((t) => {
        const group = shown.filter((r) => r.entry.data.type === t);
        if (!group.length) return null;
        return (
          <section key={t} className="memory-group" aria-label={`${TYPE_LABEL[t]}s`}>
            <h4 className="research-state-head" title={TYPE_BLURB[t]}>
              {TYPE_LABEL[t]}s<span className="badge">{group.length}</span>
            </h4>
            <ul className="memory-rows">
              {group.map((row) => (
                <MemoryItem
                  key={row.entry.data.memoryId}
                  row={row}
                  live={live}
                  byId={byId}
                  busy={busy}
                  onAct={act}
                  onOpenSession={onOpenSession}
                />
              ))}
            </ul>
          </section>
        );
      })}
      <InstructionSync roots={roots} rows={rows} />
    </div>
  );
}

// ------------------------------------------------------------ one row

function MemoryItem({
  row,
  live,
  byId,
  busy,
  onAct,
  onOpenSession,
}: {
  row: MemoryRow;
  live: readonly MemoryRow[];
  byId: Map<string, MemoryRow>;
  busy: string | null;
  onAct: (row: MemoryRow, what: string, fn: () => Promise<unknown>) => Promise<void>;
  onOpenSession?: MemoryPanelProps["onOpenSession"];
}) {
  const { root, entry } = row;
  const d = entry.data;
  const s = memoryStatus(entry);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ text: d.text, why: d.why, type: d.type, scope: entry.scope });
  const isBusy = (what: string) => busy === `${d.memoryId}:${what}`;
  const anyBusy = busy?.startsWith(`${d.memoryId}:`) ?? false;

  // This entry disagrees with / replaces older ones…
  const conflicts = [...new Set([...(d.contradicts ?? []), ...(d.supersedes ?? [])])]
    .map((id) => byId.get(id))
    .filter((r): r is MemoryRow => !!r && memoryStatus(r.entry) === "approved");
  // …or a newer one disagrees with this.
  const contradictedBy = live.filter(
    (r) => r.entry.data.memoryId !== d.memoryId && (r.entry.data.contradicts ?? []).includes(d.memoryId),
  );
  const session = d.provenance?.sessionId ?? entry.author.sessionId;
  const ptyId = entry.author.ptyId;
  const all = [...byId.values()].map((r) => r.entry);

  return (
    <li className={`memory-row memory-${s}`} data-testid="memory-row">
      <div className="memory-row-head">
        <span className={`memory-status memory-status-${s}`}>{STATUS_LABEL[s]}</span>
        <span className="memory-scope">{SCOPE_LABEL[entry.scope]}</span>
        {nearExpiry(entry) && <span className="memory-reconfirm">Reconfirm?</span>}
      </div>
      {editing ? (
        <form
          className="memory-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void onAct(row, "edit", () => editMemory(root, entry, draft)).then(() => setEditing(false));
          }}
        >
          <label>
            <span>What to remember</span>
            <textarea value={draft.text} rows={3} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          </label>
          <label>
            <span>Why</span>
            <textarea value={draft.why} rows={2} onChange={(e) => setDraft({ ...draft, why: e.target.value })} />
          </label>
          <div className="memory-filter-row">
            <Select size="sm" width="full" aria-label="Kind" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as MemoryType })}>
              {MEMORY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
            <Select size="sm" width="full" aria-label="Who it applies to" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as MemoryScope })}>
              {MEMORY_SCOPES.map((sc) => (
                <option key={sc} value={sc}>
                  {SCOPE_LABEL[sc]}
                </option>
              ))}
            </Select>
          </div>
          <div className="memory-actions">
            <Button size="sm" variant="accent" type="submit" disabled={draft.text.trim().length < 8 || anyBusy}>
              Save
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="memory-text">{d.text}</p>
          {d.why && <p className="memory-why">Because {d.why.replace(/^because\s+/i, "")}</p>}
        </>
      )}
      {s === "quarantined" && (
        <p className="memory-warn">
          This came from a session that {(d.untrusted ?? ["read content from outside the team"]).join(", ")}. Text from
          outside the team can try to plant instructions — check it before approving.
        </p>
      )}
      {conflicts.map((c) => (
        <p key={c.entry.data.memoryId} className="memory-warn">
          {(d.supersedes ?? []).includes(c.entry.data.memoryId) ? "Would replace" : "Contradicts"}: “{c.entry.data.text}”
        </p>
      ))}
      {contradictedBy.map((c) => (
        <p key={c.entry.data.memoryId} className="memory-warn">
          Contradicted by session {shortSession(c.entry.data.provenance?.sessionId) || "an agent"}: “{c.entry.data.text}”
        </p>
      ))}
      <p className="memory-meta">
        <span>{authorLine(entry)}</span>
        {/* Terminal ids are per app run, so the link is offered only when the
            source terminal is known; the session id stays in the line above. */}
        {ptyId != null && onOpenSession && (
          <button type="button" className="memory-link" onClick={() => onOpenSession({ sessionId: session, ptyId })}>
            Open session
          </button>
        )}
        <span>{age(d.createdAt)}</span>
        <span>{expiry(entry.expiresAt)}</span>
        {d.provenance?.files?.length ? (
          <span title={d.provenance.files.join("\n")}>
            {d.provenance.files.length} file{d.provenance.files.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </p>
      {!editing && (
        <div className="memory-actions">
          {needsReview(entry) && (
            <>
              <Button
                size="sm"
                variant="accent"
                disabled={anyBusy}
                onClick={() => void onAct(row, "approve", () => approveMemory(root, entry))}
              >
                {isBusy("approve") ? "Approving…" : s === "quarantined" ? "Approve anyway" : "Approve"}
              </Button>
              {conflicts.length > 0 && (
                <Button
                  size="sm"
                  disabled={anyBusy}
                  title="Approve this and retire the entries it contradicts"
                  onClick={() => void onAct(row, "supersede", () => supersedeWith(root, entry, all))}
                >
                  Approve and replace
                </Button>
              )}
            </>
          )}
          {s === "approved" && (
            <Button
              size="sm"
              variant={nearExpiry(entry) ? "accent" : "default"}
              disabled={anyBusy}
              title="Still true — keep serving it for another full period"
              onClick={() => void onAct(row, "reconfirm", () => reconfirmMemory(root, entry))}
            >
              Reconfirm
            </Button>
          )}
          {contradictedBy.length > 0 && s === "approved" && (
            <Button
              size="sm"
              disabled={anyBusy}
              onClick={() => void onAct(row, "supersede", () => supersedeWith(root, contradictedBy[0].entry, all))}
            >
              Use the newer one
            </Button>
          )}
          {(needsReview(entry) || s === "approved") && (
            <Button size="sm" variant="ghost" disabled={anyBusy} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {needsReview(entry) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={anyBusy}
              onClick={() => void onAct(row, "reject", () => rejectMemory(root, entry))}
            >
              Reject
            </Button>
          )}
          {s === "approved" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={anyBusy}
              title="Stop telling agents this now"
              onClick={() => void onAct(row, "expire", () => expireMemory(root, entry))}
            >
              Expire now
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------ instruction file

/** "Update CLAUDE.md / AGENTS.md from approved memory": a short generated
 *  section between markers, written through the same instructions_write the
 *  Instructions view uses. Optional — agents can always ask canopy_memory. */
function InstructionSync({ roots, rows }: { roots: readonly string[]; rows: readonly MemoryRow[] }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<ipc.InstructionFile[]>([]);
  const [path, setPath] = useState("");
  const [state, setState] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void ipc
      .instructionsScan([...roots])
      .then((list) => {
        if (cancelled) return;
        // Top-level project instruction files only: the generated section is
        // for the file every session preloads, not a nested rule.
        const top = list.filter(
          (f) => f.kind === "instructions" && f.scope === "project" && !/[\\/]/.test(f.label),
        );
        setFiles(top);
        setPath((p) => p || top.find((f) => f.exists)?.path || top[0]?.path || "");
      })
      .catch((e) => !cancelled && setState(String(e)));
    return () => {
      cancelled = true;
    };
  }, [open, roots]);

  const approved = rows.filter((r) => memoryStatus(r.entry) === "approved" && r.entry.scope !== "personal");

  const write = async () => {
    const file = files.find((f) => f.path === path);
    if (!file) return;
    setState("Writing…");
    try {
      const current = file.exists ? await ipc.instructionsRead(file.path, [...roots]) : "";
      const next = spliceMemorySection(current, renderMemorySection(rows.map((r) => r.entry)));
      await ipc.instructionsWrite(file.path, [...roots], next);
      setState(`Updated ${file.label}.`);
    } catch (e) {
      setState(`Couldn't write it: ${String(e)}`);
    }
  };

  if (!open) {
    return (
      <button type="button" className="research-more" onClick={() => setOpen(true)}>
        Update the instruction file from approved memory…
      </button>
    );
  }
  return (
    <div className="memory-sync">
      <p>
        Writes a short “Team memory” section ({Math.min(approved.length, 12)} of {approved.length} approved entries)
        between markers. Nothing outside the markers changes, and personal entries are left out.
      </p>
      <div className="memory-actions">
        <Select size="sm" width="full" aria-label="Instruction file" value={path} onChange={(e) => setPath(e.target.value)}>
          {files.map((f) => (
            <option key={f.path} value={f.path}>
              {f.label}
              {f.exists ? "" : " (new)"}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="accent" disabled={!path} onClick={() => void write()}>
          Write
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      {state && <p className="memory-state">{state}</p>}
    </div>
  );
}
