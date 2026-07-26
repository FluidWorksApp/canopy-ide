// Frontend half of crash reporting. The backend (crash.rs) owns the payload,
// the issue body, the POST and the pending-native-crash file; this module is
// the thin bridge the renderer uses — report the React crash the user just hit,
// and on startup flush a native panic parked from a previous run.
//
// Two destinations, deliberately different in character:
//   * a GitHub issue, filed through the user's own `gh` login — no server of
//     ours involved, and they get a URL back. Public and attributed, so it is
//     always previewed and never gated on a stored preference;
//   * the anonymous email collector, gated on the `crashReporting` opt-in
//     (default off) — that toggle governs this path and only this path.
import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "./settings";
import * as ipc from "./ipc";

/** Whether the user has turned the *anonymous* (email collector) path on. */
export function crashReportingEnabled(): boolean {
  return getSettings().crashReporting === true;
}

/** Send a renderer (React) crash. Resolves on success; rejects with the
 *  backend's error string (e.g. no endpoint baked in, or the collector's
 *  status) so the caller can show why it failed. */
export async function reportRendererCrash(
  message: string,
  stack: string | null,
): Promise<void> {
  await invoke("report_crash", { source: "renderer", message, stack });
}

/** On startup, look for a native panic the previous run parked. The backend
 *  clears it on read (offered once, never a nag loop), so we only send when the
 *  user is opted in — otherwise the read simply discards it. Best-effort:
 *  swallows all errors so a failed report never blocks launch. */
export async function flushPendingCrash(): Promise<void> {
  try {
    const report = await invoke<unknown>("take_pending_crash");
    if (!report || !crashReportingEnabled()) return;
    await invoke("send_crash", { report });
  } catch {
    // Reporting is a courtesy, never a launch dependency.
  }
}

// ---------- GitHub issue path ----------

/** The exact issue that would be published — built in the backend so the
 *  version, OS and arch are the ones that shipped, and shown to the user
 *  before anything leaves the machine. */
export interface CrashIssueDraft {
  repo: string;
  title: string;
  body: string;
  /** Dedup token, already embedded in `body`. Round-tripped on file so an
   *  edited body still matches the right existing issue. */
  fingerprint: string;
}

export interface CrashIssueOutcome {
  url: string;
  /** True when a matching report already existed and we commented on it. */
  existing: boolean;
}

/** Who we'd file as, and whether we can file at all. `gh` being installed is
 *  not enough — the token has to actually work, which is what `gh_auth`'s
 *  `gh api user` probe establishes. */
export interface IssueFiler {
  canFile: boolean;
  account: string;
}

export async function issueFiler(): Promise<IssueFiler> {
  try {
    const auth = await ipc.ghAuth();
    return {
      canFile: auth.installed && auth.authenticated,
      account: auth.account,
    };
  } catch {
    return { canFile: false, account: "" };
  }
}

/** Build the issue for the renderer crash in hand. Nothing is sent. */
export async function crashIssueDraft(
  message: string,
  stack: string | null,
): Promise<CrashIssueDraft> {
  return invoke<CrashIssueDraft>("crash_issue_draft", {
    source: "renderer",
    message,
    stack,
  });
}

/** File (or, on a fingerprint match, comment on) the issue via the user's `gh`.
 *  Rejects with gh's own message — it usually says exactly what's wrong. */
export async function fileCrashIssue(
  title: string,
  body: string,
  fingerprint: string,
): Promise<CrashIssueOutcome> {
  return invoke<CrashIssueOutcome>("file_crash_issue", { title, body, fingerprint });
}

/** Practical ceiling for a URL that has to survive GitHub and the browser.
 *  The budget is spent on the *encoded* string, not the raw one: a single `»`
 *  becomes `%C2%BB`, and a stack full of them would blow a character-counted
 *  cap by 6x. */
const MAX_URL_LEN = 7_800;

const TRUNCATED_NOTE =
  "\n\n_…truncated to fit a URL; the full stack is in the app's log._\n";

/** Encoded length, or Infinity when the slice cuts a surrogate pair in half —
 *  `encodeURIComponent` throws on a lone surrogate, and returning Infinity
 *  makes the search below step away from that cut point on its own. */
function encodedLen(s: string): number {
  try {
    return encodeURIComponent(s).length;
  } catch {
    return Infinity;
  }
}

/** Fallback for a machine with no working `gh`: GitHub's own new-issue form,
 *  prefilled. Costs no auth and no server, and still lands a tracked issue the
 *  reporter can follow — they just press the last button themselves. */
export function issueComposeUrl(draft: CrashIssueDraft): string {
  const base = `https://github.com/${draft.repo}/issues/new?`;
  const title = `title=${encodeURIComponent(draft.title)}`;
  const budget = MAX_URL_LEN - base.length - title.length - "&body=".length;

  let body = draft.body;
  if (encodedLen(body) > budget) {
    // Longest prefix whose encoded form still leaves room for the note.
    const room = budget - encodedLen(TRUNCATED_NOTE);
    let lo = 0;
    let hi = body.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (encodedLen(body.slice(0, mid)) <= room) lo = mid;
      else hi = mid - 1;
    }
    body = body.slice(0, lo) + TRUNCATED_NOTE;
  }
  return `${base}${title}&body=${encodeURIComponent(body)}`;
}
