// "Prune branches": the one screen that takes the leftovers away in bulk.
//
// The branch list, Loose ends and the Servers panel's per-workspace rows are
// all long for the same reason — agents make a branch and a workspace per
// thought and abandon both when their context runs out. Row-at-a-time deletes
// can't keep up with that, and none of those three lists can be read at a
// glance once there are a hundred rows in them. This is where a hundred rows
// become a decision: everything the repo is holding, grouped by what it would
// cost to lose, with the safe pile pre-ticked and every risky row asking for
// itself by hand.
//
// It deliberately does not follow the branch-switch dialog funnel the rest of
// the Git panel uses. That funnel is right for one question about one branch;
// this is one question about ninety, and the answer to it is the list itself —
// which is why the enumeration is on screen rather than in a `detail` block.
// The arithmetic behind all of it — what may be ticked, what a row will run,
// what it costs — is in `../prune`, tested there rather than clicked here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import {
  PRESETS,
  RISK_HINT,
  RISK_LABEL,
  RISK_ORDER,
  loses,
  outcomeSummary,
  planFor,
  presetSelection,
  pruneCandidates,
  pruneIsLossy,
  pruneLabel,
  pruneSummary,
  runPrune,
  selectable,
  tally,
  type PruneCandidate,
  type PrunePreset,
  type PruneResult,
} from "../prune";
import type { Notify } from "../types";
import { releaseLease } from "../workspaces";
import { Dialog } from "./Dialog";
import { GitBranchIcon } from "./icons";
import { Button, Segmented, TextInput } from "./ui";

interface PruneDialogProps {
  open: boolean;
  repo: string | null;
  /** Working directories with something live in them — agent terminals, server
   *  runs. A workspace holding one is never pre-ticked, whatever git thinks of
   *  its branch: the audit can't see that somebody is mid-sentence in there. */
  busy?: string[];
  onNotice: Notify;
  /** Refs and folders moved — the panel behind this needs to re-read them. */
  onChanged: () => void;
  onClose: () => void;
}

const ago = (days: number) =>
  days === 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;

/** The chips on a row: where the branch lives and what state it is in, in the
 *  same words the other Git surfaces use. Deliberately few — a row carrying
 *  six chips is a row nobody reads. */
function rowChips(c: PruneCandidate) {
  const b = c.branch;
  const chips: { key: string; label: string; title: string; tone?: "warn" | "live" }[] = [];
  if (c.busy)
    chips.push({
      key: "busy",
      label: "in use",
      title: "An agent or a server is running in this workspace right now.",
      tone: "live",
    });
  if (b.worktree)
    chips.push(
      b.prunable
        ? {
            key: "wt",
            label: "folder gone",
            title: `${b.worktree} is already gone from disk — pruning drops what still claims it.`,
            tone: "warn" as const,
          }
        : {
            key: "wt",
            // The same three words the rest of the app uses for these, so a
            // branch that is "in main checkout" in the switch dialog doesn't
            // become "own space" here.
            label: b.is_main ? "main checkout" : "own space",
            title: b.worktree,
          },
    );
  if (b.upstream_gone)
    chips.push({
      key: "gone",
      label: "remote gone",
      title: "Its remote branch was deleted — usually what a squash-merge leaves behind.",
    });
  else if (!b.upstream)
    chips.push({ key: "local", label: "local only", title: "Never pushed anywhere." });
  return chips;
}

export function PruneDialog({
  open,
  repo,
  busy = [],
  onNotice,
  onChanged,
  onClose,
}: PruneDialogProps) {
  const [audit, setAudit] = useState<ipc.WorkAudit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [preset, setPreset] = useState<PrunePreset>("safe");
  const [remote, setRemote] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [results, setResults] = useState<PruneResult[] | null>(null);

  const busyKey = busy.join("\n");
  // Read by `load`, which must not change identity when an agent starts or a
  // server stops — see the effect below for why that matters.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const load = useCallback(
    async (keepSelection: boolean) => {
      if (!repo) return;
      setError(null);
      try {
        const a = await ipc.gitWorkAudit(repo);
        setAudit(a);
        // A fresh read is a fresh default; a read *after* a prune keeps what is
        // left ticked so the refusals stay actionable rather than reset.
        if (!keepSelection)
          setSelected(presetSelection(pruneCandidates(a, busyRef.current), "safe"));
      } catch (e: unknown) {
        setAudit(null);
        setError(String(e));
      }
    },
    [repo],
  );

  // The audit belongs to the moment the screen opened. Re-reading it because a
  // run started somewhere would throw away a selection someone is halfway
  // through making — and the thing that changed is already live in the rows,
  // since `candidates` recomputes off `busyKey` on its own.
  useEffect(() => {
    if (!open) return;
    setResults(null);
    setProgress(null);
    setFilter("");
    setPreset("safe");
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo]);

  const candidates = useMemo(
    () => (audit ? pruneCandidates(audit, busy) : []),
    // Same reason as above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [audit, busyKey],
  );

  const needle = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle
        ? candidates.filter(
            (c) =>
              c.key.toLowerCase().includes(needle) ||
              c.branch.subject.toLowerCase().includes(needle),
          )
        : candidates,
    [candidates, needle],
  );

  /** Ticked but filtered out of sight. The count on the button includes these,
   *  so the list has to admit they exist. */
  const hidden = useMemo(() => {
    if (!needle) return 0;
    const visible = new Set(shown.map((c) => c.key));
    return candidates.filter((c) => selected.has(c.key) && !visible.has(c.key)).length;
  }, [candidates, shown, selected, needle]);

  const t = tally(candidates, selected, remote);
  const lossy = pruneIsLossy(t);
  const running = progress !== null;
  const refused = results?.filter((r) => !r.ok) ?? [];
  const refusedBy = new Map(refused.map((r) => [r.key, r.why ?? ""]));

  const groups = RISK_ORDER.map((risk) => ({
    risk,
    items: shown.filter((c) => c.risk === risk && !c.blocked),
  })).filter((g) => g.items.length > 0);
  const blocked = shown.filter((c) => c.blocked);

  const applyPreset = (p: PrunePreset) => {
    setPreset(p);
    // Against what is on screen, so a preset can never tick something the
    // filter is hiding — the count on the button would be unaccountable.
    setSelected(presetSelection(shown, p));
  };

  const toggle = (c: PruneCandidate) => {
    if (!selectable(c)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(c.key)) next.add(c.key);
      return next;
    });
  };

  const setGroup = (items: PruneCandidate[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of items) {
        if (!selectable(c)) continue;
        if (on) next.add(c.key);
        else next.delete(c.key);
      }
      return next;
    });

  async function run() {
    if (!repo || t.branches === 0) return;
    const items = candidates.filter((c) => selected.has(c.key) && selectable(c));
    setProgress([0, items.length]);
    setResults(null);
    const out = await runPrune(
      items,
      {
        removeWorktree: async (path, force) => {
          const r = await ipc.gitWorktreeRemove(repo, path, force);
          // The same two records the single-row remove clears: the workspace
          // entry, and the port lease — a repo pruned twice a month otherwise
          // drifts its ports into numbers nobody recognises.
          await ipc.workspaceRemove(path).catch(() => {});
          releaseLease(repo, path);
          return r;
        },
        deleteBranch: (branch) => ipc.gitBranchDelete(repo, branch, true),
        deleteRemote: (branch) => ipc.gitBranchDeleteRemote(repo, branch),
      },
      remote,
      (done, total) => setProgress([done, total]),
    );
    setProgress(null);
    setResults(out);
    const ok = out.filter((r) => r.ok).length;
    if (ok > 0) onNotice(outcomeSummary(out), out.length === ok ? "success" : "info");
    // Everything moved: branches, folders, ports. Whoever opened this is
    // showing at least one list that is now wrong.
    onChanged();
    // Keep the refusals ticked — they are what is left to deal with.
    setSelected(new Set(out.filter((r) => !r.ok).map((r) => r.key)));
    await load(true);
  }

  const body = error ? (
    <span className="prn-error">{error}</span>
  ) : running ? (
    `Pruning ${progress[0]} of ${progress[1]}…`
  ) : results ? (
    outcomeSummary(results)
  ) : audit ? (
    pruneSummary(t, audit.base)
  ) : (
    "Reading every branch and workspace in this repo…"
  );

  return (
    <Dialog
      open={open}
      title="Prune branches and workspaces"
      size="lg"
      icon={<GitBranchIcon size={14} />}
      variant={lossy ? "danger" : "accent"}
      body={body}
      meta={
        audit ? (
          <>
            {candidates.length} branch{candidates.length === 1 ? "" : "es"} ·{" "}
            {t.branches} selected
            {t.worktrees > 0 && ` · ${t.worktrees} folder${t.worktrees === 1 ? "" : "s"}`}
            {t.remotes > 0 && ` · ${t.remotes} on origin`}
            {hidden > 0 && ` · ${hidden} hidden by the filter`}
          </>
        ) : undefined
      }
      dismissLabel={results ? "Done" : "Cancel"}
      onDismiss={onClose}
      actions={
        audit && candidates.length > 0
          ? [
              {
                label: running ? "Pruning…" : pruneLabel(t),
                primary: true,
                disabled: running || t.branches === 0,
                onClick: () => void run(),
              },
            ]
          : []
      }
    >
      <div className="prn-body">
        {audit && (
          <>
            <div className="prn-controls">
              <Segmented
                aria-label="What to select"
                options={PRESETS.map((p) => ({ id: p.id, label: p.label }))}
                value={preset}
                onChange={applyPreset}
                disabled={running}
              />
              <TextInput
                search
                size="sm"
                width="sm"
                placeholder="Filter branches…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                disabled={running}
              />
            </div>

            <div className="prn-note">
              {PRESETS.find((p) => p.id === preset)?.hint} Merge status is measured
              against <code>{audit.base}</code>; a squash-merged branch reads as
              unmerged, so its remote being gone is the better hint.
              {audit.counts_degraded &&
                " This git is too old to count commits against the base, so every unpushed-looking branch is treated as holding work."}
            </div>

            {/* Outward-facing, so it is off every time this opens and never
                part of a preset — the local prune is yours, the remote one is
                everybody's. */}
            <label className="prn-mode" title="git push origin --delete, for each selected branch that still has a remote copy">
              <input
                type="checkbox"
                checked={remote}
                disabled={running}
                onChange={(e) => setRemote(e.target.checked)}
              />
              <span>
                Also delete them on origin
                <em>
                  Everyone loses those branches, not just this clone. Branches
                  whose remote is already gone are unaffected.
                </em>
              </span>
            </label>

            {hidden > 0 && (
              <div className="prn-note prn-note-warn">
                {hidden} selected branch{hidden === 1 ? " is" : "es are"} hidden by the
                filter and would be pruned too.{" "}
                <Button size="sm" onClick={() => setFilter("")}>
                  Show everything
                </Button>
              </div>
            )}
          </>
        )}

        {groups.map((g) => {
          const pickable = g.items.filter(selectable);
          const on = pickable.filter((c) => selected.has(c.key)).length;
          return (
            <div className="prn-group" key={g.risk}>
              <div className={`prn-group-head prn-head-${g.risk}`} title={RISK_HINT[g.risk]}>
                <span className="prn-group-name">{RISK_LABEL[g.risk]}</span>
                <span className="badge">{g.items.length}</span>
                <span className="prn-spacer" />
                {pickable.length > 0 && (
                  <>
                    <Button
                      size="sm"
                      disabled={running || on === pickable.length}
                      title={
                        g.risk === "safe" || g.risk === "open"
                          ? `Select all ${pickable.length}`
                          : `Select all ${pickable.length} — each of these loses work that exists nowhere else`
                      }
                      onClick={() => setGroup(g.items, true)}
                    >
                      All
                    </Button>
                    <Button
                      size="sm"
                      disabled={running || on === 0}
                      onClick={() => setGroup(g.items, false)}
                    >
                      None
                    </Button>
                  </>
                )}
              </div>
              {g.items.map((c) => (
                <Row
                  key={c.key}
                  c={c}
                  checked={selected.has(c.key)}
                  disabled={running}
                  remote={remote}
                  refused={refusedBy.get(c.key)}
                  onToggle={() => toggle(c)}
                />
              ))}
            </div>
          );
        })}

        {blocked.length > 0 && (
          <div className="prn-group">
            <div
              className="prn-group-head prn-head-blocked"
              title="Listed so the count adds up. Nothing here can be pruned from this screen."
            >
              <span className="prn-group-name">Never offered</span>
              <span className="badge">{blocked.length}</span>
            </div>
            {blocked.map((c) => (
              <Row key={c.key} c={c} checked={false} disabled remote={remote} onToggle={() => {}} />
            ))}
          </div>
        )}

        {audit && candidates.length === 0 && (
          <div className="prn-empty">
            Nothing to prune — this repo has one branch and no leftover workspaces.
          </div>
        )}
        {audit && candidates.length > 0 && shown.length === 0 && (
          <div className="prn-empty">No branch matches “{filter.trim()}”.</div>
        )}

        {error && (
          <div className="prn-empty">
            Git wouldn't answer the question this screen asks.{" "}
            <Button size="sm" onClick={() => void load(true)}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Row({
  c,
  checked,
  disabled,
  remote,
  refused,
  onToggle,
}: {
  c: PruneCandidate;
  checked: boolean;
  disabled: boolean;
  remote: boolean;
  refused?: string;
  onToggle: () => void;
}) {
  const plan = planFor(c, remote);
  const chips = rowChips(c);
  return (
    <label
      className={`prn-row ${c.blocked ? "prn-row-off" : ""} ${
        checked && loses(c) ? "prn-row-lossy" : ""
      }`}
      // Every git command this row would run, in order — the whole point of a
      // bulk delete you are allowed to trust.
      title={[c.branch.subject, "", ...plan.map((s) => s.hint)].join("\n")}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled || c.blocked !== null}
        onChange={onToggle}
      />
      <span className="prn-name">{c.key}</span>
      {chips.map((ch) => (
        <span
          key={ch.key}
          className={`prn-chip ${ch.tone ? `prn-chip-${ch.tone}` : ""}`}
          title={ch.title}
        >
          {ch.label}
        </span>
      ))}
      {/* What it is, or why it can't go, or why it didn't — the row's one
          sentence, and never more than one. */}
      <span className={`prn-why ${refused ? "prn-why-refused" : ""}`}>
        {refused ?? (c.blocked ? `${c.blocked} — never pruned` : c.why)}
      </span>
      <span className="prn-spacer" />
      <span className="prn-age">{ago(c.branch.age_days)}</span>
    </label>
  );
}
