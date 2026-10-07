// Which CLIs are signed in, per account. One reading for every panel that
// says so — the status-bar switcher, Settings → Accounts, the + launcher
// banner and the remote workspace's account picker — so they cannot disagree.
//
// The rows come from `profile_accounts` (src-tauri/src/profiles.rs on this
// Mac, packages/remote-host/profiles.mjs in a workspace). Both answer from the
// login store the CLI itself reads, never from Claude's `oauthAccount` record,
// which outlives a login that was signed out.

import type { AccountStatus, AgentProfile } from "./ipc";
import { agentCliFor } from "./projects";

/** A CLI's login in one account, as the panels show it. */
export type CliLogin =
  /** A usable login. */
  | "in"
  /** The CLI cleared a login it held (a failed token renewal). */
  | "signed-out"
  /** Never signed in. */
  | "out"
  /** The store could not be read; the CLI's last record says signed in. */
  | "unverified-in"
  /** No verified way to read this CLI's login. */
  | "unknown";

export function cliLogin(status: AccountStatus | undefined): CliLogin {
  if (!status) return "out";
  if (status.state === "unknown") return "unknown";
  if (status.state === "in") return status.reason === "unverified" ? "unverified-in" : "in";
  return status.reason === "signed-out" ? "signed-out" : "out";
}

/** The CLIs an account can launch right now, in the order the store lists
 *  them. An unverified record counts: the CLI itself will use it, and the
 *  per-CLI row says it was not checked. */
export function signedInClis(statuses: AccountStatus[] | undefined): string[] {
  return (statuses ?? [])
    .filter((s) => {
      const login = cliLogin(s);
      return login === "in" || login === "unverified-in";
    })
    .map((s) => s.agent);
}

/** CLIs whose login this account held and lost — worth saying, because the
 *  CLI's record still names the account. */
export function signedOutClis(statuses: AccountStatus[] | undefined): string[] {
  return (statuses ?? []).filter((s) => cliLogin(s) === "signed-out").map((s) => s.agent);
}

/** The one-line answer to "who is in this account". */
export function accountSummary(
  statuses: AccountStatus[] | undefined,
  name: (agent: string) => string = (agent) => agent,
): string {
  const held = signedInClis(statuses);
  if (held.length) return held.map(name).join(", ");
  const lost = signedOutClis(statuses);
  if (lost.length) return `signed out of ${lost.map(name).join(", ")}`;
  return "no logins yet";
}

/** One CLI's row in Settings → Accounts: what to show and the tooltip. */
export function cliLoginText(
  status: AccountStatus | undefined,
  cliName: string,
): { text: string; title: string; signedIn: boolean } {
  const who = status?.account ?? null;
  switch (cliLogin(status)) {
    case "in":
      return {
        text: who ?? "signed in",
        title: `${cliName} is signed in as ${who ?? "this account"}`,
        signedIn: true,
      };
    case "unverified-in":
      return {
        text: `${who ?? "signed in"} (unverified)`,
        title: `Canopy could not read ${cliName}'s login store (locked or access denied). This is the CLI's last record, not a checked login.`,
        signedIn: true,
      };
    case "signed-out":
      return {
        text: who ? `signed out (was ${who})` : "signed out",
        title: `${cliName} cleared this login, usually after a failed token renewal. Sign in again to use it.`,
        signedIn: false,
      };
    case "unknown":
      return {
        text: "—",
        title: `Canopy can't read ${cliName}'s sign-in state — it keeps credentials somewhere we haven't verified`,
        signedIn: false,
      };
    default:
      return { text: "not signed in", title: `No ${cliName} login in this account yet`, signedIn: false };
  }
}

/** What `execution_remote_import_accounts` answers. `sent` and `notUpdated`
 *  come from the Mac; the rest from the workspace host. */
export type ImportResult={imported?:string[];updated?:string[];skipped?:string[];skippedProfiles?:string[];incomplete?:string[];sent?:Record<string,string[]>;notUpdated?:string[]};

/** What a sync did, per account and CLI, from what was actually sent and what
 *  the workspace confirmed.  */
export function syncNotice(result:ImportResult,profiles:AgentProfile[]):string{
 const agentName=(agent:string)=>agentCliFor(agent)?.name??agent;
 const label=(id:string)=>profiles.find(p=>p.id===id)?.label??id;
 const notUpdated=new Set(result.notUpdated??[]);
 const sent=Object.entries(result.sent??{}).filter(([id])=>!notUpdated.has(label(id)));
 const done=sent.map(([id,agents])=>`${label(id)} (${agents.map(agentName).join(', ')})`);
 return [
  done.length?`Synced ${done.join(', ')}.`:'Nothing was synced.',
  notUpdated.size?`Not updated: ${[...notUpdated].join(', ')}. This workspace's host keeps its existing copy; update the workspace, then sync again.`:'',
  result.incomplete?.length?`Not copied, sign in again on this Mac first: ${result.incomplete.join(', ')}.`:'',
 ].filter(Boolean).join(' ');
}
