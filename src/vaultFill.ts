// What happens when an agent asks the vault for something.
//
// The secret never comes through here. `fill` sends two ids to the backend —
// which tab, which entry — and the backend puts the password straight into the
// page; what comes back is which fields took a value. That is the whole reason
// the fill path exists: an agent driving a login does not need to know the
// password, and a page that talks it into repeating what it knows gets nothing.
//
// The part this file owns is the gate. An agent's first fill or read on a
// domain has to be approved by the person at the keyboard, and the approval is
// remembered per domain (in the vault, so it is encrypted with everything
// else). The prompt names the domain and the entry, because "an agent wants a
// password" with no subject is a prompt people click through.
import * as ipc from "./ipc";

/** The preview the ops act on: which tab, and what it currently has loaded. */
export interface PreviewTarget {
  tabId: string;
  url: string;
}

export interface VaultOpContext {
  /** The preview tab an agent's browser ops are driving, if any. */
  preview: () => Promise<PreviewTarget | null>;
  /** Put a question to the user and resolve with the option they chose. */
  ask: (question: string, options: string[]) => Promise<string>;
}

/** The approval answers, spelled once so the prompt and the test agree. */
export const ALLOW_ALWAYS = "Allow on this site";
export const ALLOW_ONCE = "Just this once";
export const DENY = "No";

/** The host a URL belongs to, lowercased. Mirrors the backend's `host_of`;
 *  duplicated rather than round-tripped because it decides what the prompt
 *  says, and a prompt that names a different host than the fill uses is worse
 *  than no prompt. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The question the user actually sees. Names the entry, the site, and what is
 *  about to happen — never the value. */
export function approvalPrompt(
  op: "fill" | "read",
  label: string,
  host: string,
): string {
  return op === "read"
    ? `An agent is asking for the password for “${label}” (${host}) in plain text. It will be able to read it, repeat it, and send it wherever it is working.`
    : `An agent wants to fill your “${label}” login into ${host}. Canopy types it into the page; the agent never sees the password itself.`;
}

/** Ask, unless this domain has already been approved for this op. Returns
 *  whether to go ahead, and whether the answer should be remembered. */
export async function gate(
  op: "fill" | "read",
  label: string,
  domain: string,
  host: string,
  ctx: VaultOpContext,
  approvals: ipc.VaultApproval[],
): Promise<{ go: boolean; remember: boolean }> {
  const known = approvals.find((a) => a.domain === domain);
  if (known && (op === "read" ? known.read : known.fill)) {
    return { go: true, remember: false };
  }
  const answer = await ctx.ask(approvalPrompt(op, label, host), [
    ALLOW_ALWAYS,
    ALLOW_ONCE,
    DENY,
  ]);
  // Anything that is not one of the two yeses is a no — including a typed
  // answer and the "skip" the ask dialog offers. A credential prompt is the
  // wrong place to interpret ambiguity generously.
  if (answer === ALLOW_ALWAYS) return { go: true, remember: true };
  if (answer === ALLOW_ONCE) return { go: true, remember: false };
  return { go: false, remember: false };
}

/** An agent's vault op, answered. Throwing is how it reports something the
 *  agent should read and act on. */
export async function runVaultOp(
  op: { vaultOp?: string | null; entryId?: string | null; domain?: string | null },
  ctx: VaultOpContext,
): Promise<unknown> {
  const kind = op.vaultOp ?? "list";
  const status = await ipc.vaultStatus();
  if (!status.exists) {
    throw new Error(
      "there is no credential vault on this machine — the user can create one in Settings → Vault",
    );
  }
  if (!status.unlocked) {
    throw new Error(
      "the vault is locked. Ask the user to unlock it in Settings → Vault, then try again",
    );
  }

  if (kind === "list") {
    // Scoped to the page being driven when there is one: an agent working on a
    // login page has no business enumerating every credential on the machine.
    const preview = await ctx.preview();
    const items = preview?.url
      ? await ipc.vaultMatches(preview.url)
      : await ipc.vaultList();
    return {
      entries: items.map((i) => ({
        id: i.id,
        label: i.label,
        domain: i.domain,
        username: i.username,
        readable: i.readable,
      })),
      note: "Passwords are not listed. Use vault fill to put one into the page.",
    };
  }

  const preview = await ctx.preview();
  if (kind === "fill" && !preview) {
    throw new Error(
      "no preview tab is open — open the login page with canopy_browser_navigate first",
    );
  }

  // Pick the entry: the one named, or the best match for what is loaded.
  const candidates = op.entryId
    ? (await ipc.vaultList()).filter((i) => i.id === op.entryId)
    : preview
      ? await ipc.vaultMatches(preview.url)
      : [];
  const entry = candidates[0];
  if (!entry) {
    throw new Error(
      op.entryId
        ? "no vault entry with that id"
        : `no vault entry for ${hostOf(preview?.url ?? "") || "this page"} — the user can add one in Settings → Vault`,
    );
  }

  const host = hostOf(preview?.url ?? "") || entry.domain;
  const approvals = await ipc.vaultApprovals();
  const { go, remember } = await gate(
    kind === "read" ? "read" : "fill",
    entry.label,
    entry.domain,
    host,
    ctx,
    approvals,
  );
  if (!go) {
    throw new Error(
      `the user declined. Don't ask again this session — carry on without ${entry.label}, or tell them what you needed it for`,
    );
  }
  if (remember) await ipc.vaultApprove(entry.domain, kind === "read" ? "read" : "fill");

  if (kind === "read") {
    // Gated twice over: the entry has to be marked readable (the backend
    // enforces that and errors with why) and the domain has to be approved for
    // reading, which is what just happened.
    const secret = await ipc.vaultRead(entry.id);
    return { label: entry.label, username: secret.username, password: secret.password };
  }

  const report = await ipc.vaultFill(preview!.tabId, entry.id);
  return {
    filled: report.filled,
    label: report.label,
    note: report.filled.includes("password")
      ? "Submit the form the way a person would — click its button."
      : "Only the username field was on this page; call again after the next step for the password.",
  };
}
