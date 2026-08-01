// "Raised by" — the PR tab's answer to "who made this, and can I reach them?"
//
// Before this the PR tab had no notion of a session at all: a PR an agent
// opened twenty minutes ago was indistinguishable from one a stranger pushed,
// and the only way to ask for a change was to start a brand-new agent in a
// fresh worktree that had to rediscover everything the first one already knew.
//
// The rung comes from agentForPr.ts, which the companion uses too — the two
// must not disagree about who owns a PR.

import { useEffect, useMemo, useState } from "react";
import type { PrAgent } from "../agentForPr";
import { resolveAgentForPr } from "../agentForPr";
import * as ipc from "../ipc";
import { PROVENANCE_EVENT, cached, load } from "../provenance";

/** Unix seconds → "3h ago". Local because PrView's own is local too, and one
 *  more shared time formatter is not worth a refactor of that file. */
function ago(secs: number): string {
  const d = Math.max(0, Math.floor(Date.now() / 1000 - secs));
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

interface RaisedByProps {
  repo: string;
  number: number;
  /** Every session running now: id → its terminal, null for another window. */
  live: Map<string, number | null>;
  /** Send a change request to the resolved session, resuming it if it has
   *  ended. ProjectView owns this — it is the same delivery the workspace
   *  review uses, so a PR and a workspace reach an agent identically. */
  onSend: (to: PrAgent, text: string) => void;
}

/** How the rung reads in one word, next to the agent's name. */
const RUNG_LABEL: Record<PrAgent["kind"], string> = {
  live: "running",
  elsewhere: "another window",
  resumable: "resumable",
  cold: "closed",
};

/** What the row says about how much to trust the attribution. `declared` is the
 *  agent's own word and needs no caveat; the other two are worth marking. */
const CONFIDENCE_NOTE: Record<string, string> = {
  declared: "",
  observed: "matched when the PR appeared",
  inferred: "matched after the fact, from the session's branch",
};

export function RaisedBy({ repo, number, live, onSend }: RaisedByProps) {
  const [edges, setEdges] = useState(() => cached(repo, number));
  const [exists, setExists] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  useEffect(() => {
    let alive = true;
    setEdges(cached(repo, number));
    void load(repo, number).then((r) => alive && setEdges(r));
    const reread = () => alive && setEdges(cached(repo, number));
    window.addEventListener(PROVENANCE_EVENT, reread);
    return () => {
      alive = false;
      window.removeEventListener(PROVENANCE_EVENT, reread);
    };
  }, [repo, number]);

  // Whether each recorded directory is still there. Statted rather than
  // remembered: a worktree is removed by the task that made it, so a flag
  // frozen at write time would be wrong for exactly the runs that changed most.
  useEffect(() => {
    let alive = true;
    const dirs = [...new Set((edges ?? []).map((e) => e.cwd).filter(Boolean))];
    if (!dirs.length) return;
    void Promise.all(
      dirs.map(async (d) => [d, await ipc.fsStat(d).then(Boolean, () => false)] as const),
    ).then((pairs) => alive && setExists(Object.fromEntries(pairs)));
    return () => {
      alive = false;
    };
  }, [edges]);

  const to = useMemo(
    () =>
      edges?.length
        ? resolveAgentForPr(edges, { live, dirExists: (d) => exists[d] === true })
        : null,
    [edges, live, exists],
  );

  // Nothing recorded is the common case for a PR a human pushed, and a row
  // saying "we don't know" on every one of those is noise.
  if (!to || !to.edge) return null;

  const note = CONFIDENCE_NOTE[to.edge.confidence] ?? "";
  return (
    <span className="pr-raised" title={`${to.why}${note ? ` — ${note}` : ""}`}>
      raised by <strong>{to.agent ?? "an agent"}</strong>
      <span className="pr-raised-rung">{RUNG_LABEL[to.kind]}</span>
      {to.edge.at > 0 && <span className="pr-when">{ago(to.edge.at)}</span>}
      {to.kind !== "elsewhere" &&
        (open ? (
          <input
            className="pr-raised-input"
            autoFocus
            value={text}
            placeholder={
              to.kind === "cold"
                ? "What to change — a fresh agent picks it up…"
                : `What to change — goes to ${to.agent ?? "the agent"}…`
            }
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                return;
              }
              if (e.key !== "Enter" || !text.trim()) return;
              onSend(to, text.trim());
              setText("");
              setOpen(false);
            }}
            onBlur={() => !text.trim() && setOpen(false)}
          />
        ) : (
          <button
            type="button"
            className="pr-raised-send"
            title={
              to.kind === "live"
                ? "Send a change request to the agent that raised this"
                : to.kind === "resumable"
                  ? "Reopen that conversation and send it a change request"
                  : "That conversation is gone — start a fresh agent with this PR's history"
            }
            onClick={() => setOpen(true)}
          >
            {to.kind === "cold" ? "Pick up" : "Send a change"}
          </button>
        ))}
    </span>
  );
}
