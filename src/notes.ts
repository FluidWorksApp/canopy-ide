// The scratchpad, as the UI sees it: the status model the panel groups by, a
// small cache so the panel and SpotSearch don't each re-read the store, and the
// one event everything refreshes on.
//
// The store itself is Rust (src-tauri/src/notes.rs) and is the only authority —
// nothing here is allowed to become a second source of truth. This module holds
// the last answer it gave, so the palette can offer rows on the first keystroke
// instead of after a round trip, and refreshes it whenever the store changes.
//
// Deliberately the same shape as research.ts. They are different things — a
// note is your sentence, a research entry is an agent's finding — but they are
// the same *kind* of thing to the app, and two stores that behave differently
// would be two things to learn for no gain.
import * as ipc from "./ipc";

export type NoteStatus = ipc.NoteStatus;

/** Order the panel renders in: what you decided to do first, then what is
 *  moving, then the raw pile, then what you put down. Ideation sits below Ready
 *  and Doing on purpose — it is the biggest group by far and the least
 *  actionable, and a list that opens with two hundred untriaged thoughts buries
 *  the five that matter. */
export const STATUS_ORDER: NoteStatus[] = [
  "doing",
  "ready",
  "ideation",
  "parked",
  "done",
  "archived",
];

export const STATUS_LABELS: Record<NoteStatus, string> = {
  ideation: "Ideas",
  ready: "Ready",
  doing: "In progress",
  done: "Done",
  parked: "Parked",
  archived: "Archived",
};

/** One line each, because a status list with no explanation invites two people
 *  — or the same person two months apart — to mean different things by
 *  "parked". */
export const STATUS_BLURBS: Record<NoteStatus, string> = {
  ideation: "Captured, not triaged. Most notes live here, and that's fine.",
  ready: "You decided it's worth doing. Nobody has started.",
  doing: "An agent or you is on it now.",
  done: "It landed. A linked PR says which, when an agent did it.",
  parked: "Deliberately not now — but still real.",
  archived: "Filed away. Hidden from the list, not deleted.",
};

/** Statuses the panel shows by default: the worklist, not the closed record.
 *  Done stays in — "what came out of my scratchpad" is worth seeing — and
 *  archived is exactly what you archive to stop seeing. */
export const ACTIVE_STATUSES: NoteStatus[] = [
  "doing",
  "ready",
  "ideation",
  "parked",
  "done",
];

/** Where each status sits on the way from thought to shipped, for the progress
 *  dots on a row. `parked` keeps the rank of the work it interrupted rather
 *  than getting one of its own, the same way research treats `blocked`. */
export const STATUS_STEP: Record<NoteStatus, number> = {
  ideation: 0,
  ready: 1,
  parked: 1,
  doing: 2,
  done: 3,
  archived: 3,
};

/** Which transitions the store will accept — mirrored from the Rust state
 *  machine so the panel offers only the moves that exist rather than showing
 *  six buttons and letting four of them fail. notes.rs is the authority; the
 *  test in notes.test.ts is what keeps the two honest. */
export const NEXT_STATUSES: Record<NoteStatus, NoteStatus[]> = {
  ideation: ["ready", "doing", "parked", "archived"],
  ready: ["doing", "ideation", "parked", "archived"],
  doing: ["done", "ready", "parked", "archived"],
  done: ["doing", "archived"],
  parked: ["ideation", "ready", "doing", "archived"],
  archived: ["ideation"],
};

/** Fired whenever the store changes, so every surface showing notes refreshes
 *  without polling. Emitted by the mutators below rather than by their callers,
 *  so no write can forget it — the same arrangement research.ts uses. */
export const NOTES_EVENT = "canopy:notes-changed";

const announce = () => window.dispatchEvent(new CustomEvent(NOTES_EVENT));

// ---------- the cache ----------
//
// Per project, last answer only. Never consulted for a decision — the store is
// asked again on every change — but it lets the palette put note rows up on the
// first keystroke, which is the difference between a scratchpad being findable
// and being findable eventually.

const cache = new Map<string, ipc.NoteSummary[]>();

/** The last known notes for a project. Empty until something has loaded them;
 *  callers that need certainty call `refresh`. */
export const cached = (projectId: string): ipc.NoteSummary[] =>
  cache.get(projectId) ?? [];

/** Re-read a project's notes and publish them. */
export async function refresh(projectId: string): Promise<ipc.NoteSummary[]> {
  const rows = await ipc.notesList(projectId, ACTIVE_STATUSES).catch(() => []);
  cache.set(projectId, rows);
  announce();
  return rows;
}

/** Drop a project's cache — it closed, so its notes should stop appearing in a
 *  palette that is now floating over something else. */
export function forget(projectId: string): void {
  cache.delete(projectId);
  announce();
}

// ---------- mutations ----------
//
// Thin wrappers whose only job is to refresh afterwards. Anything that changes
// a note goes through here rather than calling ipc directly, so the panel and
// the palette can never be showing a state the store has moved on from.

export async function create(args: ipc.NoteCreateArgs): Promise<ipc.NoteSummary> {
  const note = await ipc.notesCreate(args);
  await refresh(args.projectId);
  return note;
}

/** `by` defaults to the user because most moves are a button they pressed; the
 *  reconciler passes "Canopy" for the ones the app makes on its own, so the
 *  history never credits a person for something they did not do. */
export async function setStatus(
  projectId: string,
  id: string,
  status: NoteStatus,
  by = "you",
  note?: string,
): Promise<void> {
  await ipc.notesSetStatus(projectId, id, status, by, note);
  await refresh(projectId);
}

export async function update(args: ipc.NoteUpdateArgs): Promise<void> {
  await ipc.notesUpdate(args);
  await refresh(args.projectId);
}

export async function link(args: ipc.NoteLinkArgs): Promise<ipc.NoteDetail> {
  const detail = await ipc.notesLink(args);
  await refresh(args.projectId);
  return detail;
}

export async function remove(projectId: string, id: string): Promise<void> {
  await ipc.notesDelete(projectId, id);
  await refresh(projectId);
}

/** Give a note a better name than the one it was born with.
 *
 *  A note captured from ⌘K titles itself from whatever was typed, which is the
 *  only thing available at that moment and reliably clumsy once you know what
 *  the thought was actually about. Empty is refused rather than stored: a row
 *  with no name is worse than a clumsy one. */
export async function rename(
  projectId: string,
  id: string,
  title: string,
): Promise<void> {
  const next = title.trim();
  if (!next) return;
  await update({ projectId, id, title: next });
}

// ---------- the loop's closing half ----------

/** Move notes whose linked pull requests have all merged to `done`.
 *
 *  This is the tie-back that makes the status worth trusting: a note becomes
 *  done because the PR carrying it merged, not because anyone remembered to
 *  tick it. Two rules keep it honest, both lifted from research.ts's
 *  reconciler for the same reasons:
 *
 *  - A note with no linked PR is never swept up. `doing` with nothing linked
 *    means nobody said what was carrying the work, not that it is finished.
 *  - The state comes from asking GitHub, not from the PR having disappeared
 *    from the watcher's list. The watcher holds only *open* PRs, so a vanished
 *    one may equally have been closed unmerged — and inferring "shipped" from
 *    that is exactly the quiet wrongness a status is supposed to prevent.
 *
 *  Every linked PR also has its recorded state refreshed on the way past, so
 *  the detail view shows what actually happened to each one. */
export async function reconcileMerged(projectId: string): Promise<number> {
  const rows = cached(projectId).filter(
    (r) => r.status === "doing" && r.pr_count > 0,
  );
  let moved = 0;
  for (const row of rows) {
    const detail = await ipc.notesGet(projectId, row.id).catch(() => null);
    if (!detail || detail.links.prs.length === 0) continue;
    const states = await Promise.all(
      detail.links.prs.map(async (pr) => ({
        pr,
        state: await ipc
          .ghPrState(pr.repo, pr.number)
          .then((s) => s.toLowerCase())
          // Unreachable (no gh, no network, a repo that moved) is not "merged".
          // Leaving the note where it is costs a status that lags; guessing
          // costs a thought marked shipped that never was.
          .catch(() => ""),
      })),
    );
    for (const { pr, state } of states) {
      if (state && state !== pr.state) {
        await ipc
          .notesLink({ projectId, id: row.id, pr: { ...pr, state } })
          .catch(() => {});
      }
    }
    if (states.length > 0 && states.every((s) => s.state === "merged")) {
      await ipc
        .notesSetStatus(
          projectId,
          row.id,
          "done",
          "Canopy",
          "every linked pull request merged",
        )
        .catch(() => {});
      moved += 1;
    }
  }
  if (moved > 0) await refresh(projectId);
  return moved;
}

// ---------- handing a note to an agent ----------

/** How long an attachment list may get before the brief just names the
 *  directory instead. A PTY prompt is one line (see microTasks.oneLine) and a
 *  note with twenty screenshots would spend the whole line on paths. */
const MAX_LISTED_ATTACHMENTS = 6;

/** The brief an agent gets when it picks a note up.
 *
 *  Three things have to survive the handoff, and each is here because losing it
 *  makes the note useless to the agent:
 *
 *  - **The thought itself**, title and body, in the user's words.
 *  - **The attachments, as paths.** The thing receiving this is a CLI reading a
 *    prompt: it has file tools and no way to be handed a picture. Same contract
 *    spotCompose's `briefWithAttachments` uses — the pixels are on disk, the
 *    prompt says where — and the instruction to open them is explicit, because
 *    an agent given a path in prose will often describe it rather than read it.
 *  - **The captured context**, marked as historical. A note carries what was on
 *    screen when it was written, which may be weeks stale; presented as current
 *    it sends the agent to a line number that has moved.
 */
export function noteContext(note: ipc.NoteDetail, dir: string): string {
  const parts: string[] = [
    `Pick up this note from the user's scratchpad — ${note.id}: "${note.title}".`,
  ];
  if (note.body.trim()) parts.push(`In their words: ${note.body.trim()}`);

  if (note.attachments.length > 0) {
    const listed = note.attachments.slice(0, MAX_LISTED_ATTACHMENTS);
    const paths = listed.map((a) => `${dir}/${a.file}`).join(", ");
    const rest = note.attachments.length - listed.length;
    parts.push(
      `It has ${note.attachments.length} attachment${
        note.attachments.length === 1 ? "" : "s"
      } at ${paths}${rest > 0 ? `, and ${rest} more in ${dir}/attachments/` : ""} — ` +
        `open them with your file tools before you answer; they are part of the note, not decoration.`,
    );
  }

  if (note.links.files.length > 0) {
    parts.push(
      `It points at ${note.links.files
        .map((f) => {
          const lines =
            f.start_line != null
              ? `:${f.start_line}${f.end_line != null && f.end_line !== f.start_line ? `-${f.end_line}` : ""}`
              : "";
          // The rev is the honest part: the note was written against that
          // commit and the file has very likely moved since.
          return `${f.path}${lines}${f.rev ? ` (as of ${f.rev})` : ""}`;
        })
        .join(", ")}. Read them as they are now — the line numbers are from when the note was written.`,
    );
  }

  if (note.context.trim()) {
    parts.push(
      `For background, this is what was on screen when the note was written — it may be out of date: ${note.context.trim()}`,
    );
  }
  return parts.join(" ");
}
