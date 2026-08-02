// One advisory file claim, opened as a tab.
//
// The Claimed files list is four words and a Release button: an agent's name,
// the files, and no way to ask anything else about it. The questions it raises
// are all of the "and then what" kind — who is that, why did they take these,
// how long have they had them, did anyone else want them, is it still on — and
// none of them had an answer anywhere, because a release used to delete the row
// it would have been written on.
//
// So this page is mostly a timeline. The header says what the list said, the
// timeline says everything that has happened to the claim since, and the two
// lists under it — the files themselves, and every other claim that has touched
// them — are the way out of the page: a claim is about files and about other
// agents, and both are somewhere you can go.
import { useCallback, useEffect, useMemo, useState } from "react";
import * as ipc from "../ipc";
import {
  CLAIM_STATE_BLURB,
  CLAIM_STATE_LABEL,
  claimOwnerCwd,
  claimOwnerName,
  claimState,
  claimsOnSamePaths,
} from "../claims";
import { BlockedIcon, ClaimIcon, TerminalIcon } from "./icons";
import { Button } from "./ui";

export interface ClaimViewProps {
  /** Which claim this tab is on. Never the owner — an agent that claims,
   *  releases and claims again is two claims with one name. */
  claimId: string;
  /** The row the tab was opened with, drawn until the history arrives and kept
   *  as the answer if the claim is no longer in Canopy's record. */
  fallback: ipc.AgentClaim;
  /** This tab is in front. The history is event-driven, so this only decides
   *  whether we are listening at all. */
  active: boolean;
  /** The terminal the owning agent is working in, when one is running — the
   *  claim names its owner by directory, and this is that directory resolved. */
  ownerPtyId?: number | null;
  onJumpToPty?: (ptyId: number) => void;
  onOpenFile?: (path: string) => void;
  onOpenClaim?: (claim: ipc.AgentClaim) => void;
}

const stamp = (ms: number) => new Date(ms).toLocaleString();

/** Relative age in the units a claim lives in: minutes and hours, mostly. */
function since(ms: number, now: number): string {
  const d = Math.max(0, Math.floor((now - ms) / 1000));
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/** How long it was held, for a claim that has ended. */
function heldFor(from: number, to: number): string {
  const s = Math.max(0, Math.floor((to - from) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** One moment in the claim's life. */
function Event({
  when,
  title,
  children,
  tone,
}: {
  when: number;
  title: string;
  children?: React.ReactNode;
  tone?: "refused" | "end";
}) {
  return (
    <li className={`claim-event ${tone ? `claim-event-${tone}` : ""}`}>
      <span className="claim-event-dot" aria-hidden />
      <div className="claim-event-body">
        <div className="claim-event-head">
          <span className="claim-event-title">{title}</span>
          <span className="claim-event-when" title={stamp(when)}>
            {stamp(when)}
          </span>
        </div>
        {children}
      </div>
    </li>
  );
}

export function ClaimView({
  claimId,
  fallback,
  active,
  ownerPtyId,
  onJumpToPty,
  onOpenFile,
  onOpenClaim,
}: ClaimViewProps) {
  const [history, setHistory] = useState<ipc.AgentClaim[] | null>(null);

  const load = useCallback(
    () => void ipc.contextClaimHistory().then(setHistory).catch(() => {}),
    [],
  );
  useEffect(() => {
    if (!active) return;
    load();
    let un: (() => void) | undefined;
    void ipc.onAgentClaims(load).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [active, load]);

  const live = history?.find((c) => c.id === claimId) ?? null;
  const claim = live ?? fallback;
  // Loaded, and this claim is not in it: the store is per app run (see
  // MAX_ENDED_CLAIMS in context.rs), so a tab restored into a later run is
  // reading the copy it was hibernated with. Say so rather than presenting a
  // stale row as the current state of anything.
  const forgotten = history !== null && live === null;

  const state = claimState(claim);
  const now = Date.now();
  const related = useMemo(
    () => (history ? claimsOnSamePaths(history, claim) : []),
    [history, claim],
  );
  const cwd = claimOwnerCwd(claim.owner);

  return (
    <div className="claim-view">
      <div className="claim-view-head">
        <div className="claim-view-title">
          <ClaimIcon size={15} className="claim-view-mark" />
          <span className="claim-view-owner">{claimOwnerName(claim.owner)}</span>
          <span className={`claim-state claim-state-${state}`} title={CLAIM_STATE_BLURB[state]}>
            {CLAIM_STATE_LABEL[state]}
          </span>
          <span className="status-spacer" />
          {ownerPtyId != null && (
            <Button
              size="sm"
              title="Go to the terminal this agent is running in"
              onClick={() => onJumpToPty?.(ownerPtyId)}
            >
              <TerminalIcon size={12} /> Terminal
            </Button>
          )}
          {state === "held" && !forgotten && (
            <Button
              size="sm"
              title="Drop this claim — for an agent that died holding it"
              onClick={() => void ipc.contextReleaseClaim(claim.owner).catch(() => {})}
            >
              Release
            </Button>
          )}
        </div>

        <div className="claim-view-meta">
          {cwd && (
            <code className="claim-view-cwd" title={claim.owner}>
              {cwd}
            </code>
          )}
          <span className="claim-view-age" title={stamp(claim.at_ms)}>
            claimed {since(claim.at_ms, now)}
          </span>
          {claim.released_at_ms != null && (
            <span className="claim-view-age">
              held for {heldFor(claim.at_ms, claim.released_at_ms)}
            </span>
          )}
        </div>

        {/* Why, in the agent's own words. The one thing a claim carries that
            nothing else in Canopy knows, and the list only ever showed it
            truncated into the same line as the filenames. */}
        <p className={`claim-why ${claim.note ? "" : "claim-why-none"}`}>
          {claim.note ?? "No reason given — the agent claimed these without a note."}
        </p>

        {forgotten && (
          <div className="claim-gone">
            Canopy no longer has a record of this claim. Claims live for as long
            as the app run that made them — the agents holding them do not
            outlive it either — so this is the copy the tab was opened with.
          </div>
        )}
      </div>

      <div className="claim-view-body">
        <section className="claim-section">
          <h2>
            {claim.paths.length} file{claim.paths.length === 1 ? "" : "s"}
          </h2>
          <div className="claim-paths-list">
            {claim.paths.map((p) => (
              <button
                key={p}
                className="claim-path-row"
                title={`Open ${p}`}
                onClick={() => onOpenFile?.(p)}
              >
                <span className="claim-path-name">
                  {p.split("/").filter(Boolean).pop()}
                </span>
                <span className="claim-path-dir">{p}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="claim-section">
          <h2>What happened</h2>
          <ul className="claim-timeline">
            <Event when={claim.at_ms} title={`${claimOwnerName(claim.owner)} claimed these files`}>
              {claim.note && <p className="claim-event-note">{claim.note}</p>}
            </Event>
            {/* Every agent that wanted these files while this claim held them.
                This used to exist only in the 409 the other agent got back, so
                the collision was visible to nobody but the agent that lost. */}
            {claim.refusals.map((r, i) => (
              <Event
                key={`${r.owner}-${r.at_ms}-${i}`}
                when={r.at_ms}
                tone="refused"
                title={`${claimOwnerName(r.owner)} was turned away`}
              >
                <p className="claim-event-note">
                  <BlockedIcon size={12} /> wanted {r.paths.join(", ")}
                  {r.note ? ` — ${r.note}` : ""}
                </p>
              </Event>
            ))}
            {claim.released_at_ms != null && (
              <Event
                when={claim.released_at_ms}
                tone="end"
                title={
                  {
                    released: "The agent released it",
                    dropped: "Dropped from Canopy",
                    superseded: "Replaced by a later claim from this agent",
                    held: "",
                  }[state]
                }
              >
                <p className="claim-event-note">{CLAIM_STATE_BLURB[state]}</p>
              </Event>
            )}
          </ul>
        </section>

        {related.length > 0 && (
          <section className="claim-section">
            <h2>Also on these files</h2>
            <div className="claim-related">
              {related.map((c) => (
                <button
                  key={c.id}
                  className="claim-related-row"
                  title={`${c.owner}\n${c.paths.join("\n")}`}
                  onClick={() => onOpenClaim?.(c)}
                >
                  <span className="claim-related-owner">{claimOwnerName(c.owner)}</span>
                  <span className={`claim-state claim-state-${claimState(c)}`}>
                    {CLAIM_STATE_LABEL[claimState(c)]}
                  </span>
                  <span className="claim-related-note">{c.note ?? "no note"}</span>
                  <span className="status-spacer" />
                  <span className="claim-related-when" title={stamp(c.at_ms)}>
                    {since(c.at_ms, now)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
