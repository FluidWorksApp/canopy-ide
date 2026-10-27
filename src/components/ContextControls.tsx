// How full a session's context is, and the controls that make room: "Compact
// now" here, "Summarize from here" / "Summarize up to here" on each turn of the
// timeline (TurnTimeline's onSummarize). Every one shows what will be sent
// and waits for a press; contextCompaction.ts decides how it is delivered.
import { useEffect, useState } from "react";
import type * as ipc from "../ipc";
import { contextUseText, contextWindowFor } from "../contextWindow";
import { compactInstructions, type CompactScope } from "../contextCompaction";
import type { Compaction } from "../useCompaction";
import { fmtTokens } from "../format";
import { Button } from "./ui";
import "./subagents.css";

const SCOPE_TITLE: Record<CompactScope["kind"], string> = {
  all: "Compact the conversation",
  from: "Summarize from here",
  upto: "Summarize up to here",
};

/** The context meter, Compact now, and the confirmation every compaction
 *  passes through. */
export function ContextControls({
  activity,
  compaction,
}: {
  activity: ipc.SessionActivity | null;
  compaction: Compaction;
}) {
  const [note, setNote] = useState("");
  const { state, plan } = compaction;
  useEffect(() => {
    if (state.phase === "confirming") setNote("");
  }, [state.phase]);
  const ctx = activity?.context ?? null;
  if (!compaction.supported && !ctx) return null;
  const window = contextWindowFor(ctx?.model);
  const share = ctx && window ? ctx.tokens / window : null;
  const last = activity?.compactions[activity.compactions.length - 1];
  return (
    <div className="cx-bar" role="group" aria-label="Context">
      {ctx && (
        <>
          <span>Context</span>
          {share != null && (
            <span
              className={`cx-meter ${share >= 0.9 ? "is-full" : share >= 0.7 ? "is-high" : ""}`}
              role="meter"
              aria-label="Context used"
              aria-valuemin={0}
              aria-valuemax={window!}
              aria-valuenow={ctx.tokens}
            >
              <span style={{ width: `${Math.min(100, share * 100)}%` }} />
            </span>
          )}
          <span
            title={
              window
                ? `Tokens the latest reply was given, of the ${ctx.model ?? "model"} window the CLI reported`
                : "Tokens the latest reply was given. The CLI hasn't reported this model's window size to Canopy yet."
            }
          >
            {contextUseText(ctx.tokens, window)}
          </span>
        </>
      )}
      {last && (
        <span className="cx-note">
          {last.trigger === "manual" ? "Compacted" : "Auto-compacted"}
          {last.pre_tokens != null && last.post_tokens != null
            ? ` ${fmtTokens(last.pre_tokens)} → ${fmtTokens(last.post_tokens)}`
            : ""}
        </span>
      )}
      {compaction.supported && state.phase !== "confirming" && (
        <Button
          size="sm"
          variant="ghost"
          disabled={state.phase === "running" || state.phase === "queued" || state.phase === "sent"}
          title={plan.route === "unavailable" ? plan.why : "Summarize the conversation so far to free up context"}
          onClick={() => compaction.ask({ kind: "all" })}
        >
          Compact now…
        </Button>
      )}
      {state.phase === "queued" && (
        <span className="cx-note" role="status">
          Waiting for the agent to finish this turn… <Button size="sm" variant="ghost" onClick={compaction.cancel}>Cancel</Button>
        </span>
      )}
      {state.phase === "sent" && <span className="cx-note" role="status">Sent — compacting…</span>}
      {state.phase === "running" && <span className="cx-note" role="status">Compacting…</span>}
      {state.phase === "done" && (
        <span className="cx-note" role="status">
          Compacted
          {state.pre != null && state.post != null ? `: ${fmtTokens(state.pre)} → ${fmtTokens(state.post)} tokens` : "."}
        </span>
      )}
      {state.phase === "failed" && (
        <span className="cx-note" role="alert">
          {state.message}
        </span>
      )}
      {state.phase === "confirming" && (
        <div className="cx-compose">
          <strong>{SCOPE_TITLE[state.scope.kind]}</strong>
          <span className="cx-note">
            {plan.route === "terminal"
              ? "Typed at the agent's prompt now — it is idle."
              : plan.route === "wait"
                ? plan.why
                : plan.route === "runner"
                  ? "The session isn't open in a terminal: Canopy resumes it headlessly, compacts it and closes it."
                  : plan.why}{" "}
            The CLI condenses the whole conversation; these instructions steer what it keeps.
          </span>
          <code className="cx-note">{compactInstructions({ ...state.scope, note } as CompactScope) || "(no instructions)"}</code>
          <textarea
            aria-label="Extra instructions"
            rows={2}
            placeholder="Anything else the summary must keep (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="sdoc-actions">
            <Button size="sm" variant="accent" disabled={plan.route === "unavailable"} onClick={() => compaction.confirm(note)}>
              {plan.route === "wait" ? "Compact when this turn ends" : "Compact"}
            </Button>
            <Button size="sm" variant="ghost" onClick={compaction.cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
