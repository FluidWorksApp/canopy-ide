// "Open pull request": the current branch, a generated title and description
// the user can edit, and one button that pushes and opens it.
//
// The draft comes from `generatePrDraft` (offline, honors the repo's PR
// template). Edits are never overwritten except by an explicit Regenerate or a
// base change before the user has typed anything.
import { useCallback, useEffect, useState } from "react";
import * as ipc from "../ipc";
import { generatePrDraft } from "../prGenerate";
import type { Notify } from "../types";
import { Dialog } from "./Dialog";
import { GitBranchIcon } from "./icons";
import { Button, TextInput } from "./ui";

interface OpenPrDialogProps {
  open: boolean;
  repo: string | null;
  onNotice: Notify;
  onClose: () => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function OpenPrDialog({ open, repo, onNotice, onClose }: OpenPrDialogProps) {
  const [ctx, setCtx] = useState<ipc.PrContext | null>(null);
  const [bases, setBases] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  const fill = useCallback((c: ipc.PrContext) => {
    const d = generatePrDraft({
      branch: c.branch,
      commits: c.commits,
      files: c.files,
      stat: c.stat,
      template: c.template,
    });
    setTitle(d.title);
    setBody(d.body);
    setEdited(false);
  }, []);

  const load = useCallback(
    (forBase: string, keepEdits: boolean) => {
      if (!repo) return;
      ipc
        .gitPrContext(repo, forBase)
        .then((c) => {
          setCtx(c);
          setBase(c.base);
          if (!keepEdits) fill(c);
        })
        .catch((e) => setError(`Couldn't read this branch: ${message(e)}`));
    },
    [repo, fill],
  );

  useEffect(() => {
    if (!open || !repo) return;
    setError(null);
    setUrl(null);
    setCtx(null);
    load("", false);
    ipc
      .gitBranches(repo)
      .then((bs) => setBases(bs.filter((b) => !b.current).map((b) => b.name)))
      .catch(() => setBases([]));
  }, [open, repo, load]);

  const create = async () => {
    if (!repo || !ctx) return;
    setBusy(true);
    setError(null);
    try {
      // Idempotent when already pushed; sets the upstream when it is missing.
      await ipc.gitPush(repo, true);
      const link = await ipc.ghPrCreate(repo, base, ctx.branch, title, body, draft);
      setUrl(link);
      // Loaded on demand: the watcher store pulls in the whole event layer,
      // which the Git panel does not otherwise need to open.
      void import("../prWatchStore").then((w) => w.refresh());
      onNotice(`Opened ${link}`, "success");
    } catch (e) {
      setError(`Couldn't open the pull request: ${message(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const options = bases.includes(base) || !base ? bases : [base, ...bases];

  return (
    <Dialog
      open={open}
      title="Open pull request"
      size="lg"
      icon={<GitBranchIcon size={14} />}
      variant="accent"
      meta={ctx ? `${ctx.branch} → ${base} · ${ctx.commit_count} commits · ${ctx.stat}` : undefined}
      dismissLabel={url ? "Done" : "Cancel"}
      onDismiss={onClose}
      actions={
        url
          ? []
          : [
              {
                label: busy ? "Opening…" : "Open pull request",
                primary: true,
                disabled: busy || !ctx || !title.trim(),
                onClick: () => void create(),
              },
            ]
      }
    >
      <div className="opr-body">
        {url ? (
          <p>
            Opened{" "}
            <a href={url} target="_blank" rel="noreferrer">
              {url}
            </a>
          </p>
        ) : (
          <>
            <label>
              Base branch{" "}
              <select
                aria-label="Base branch"
                value={base}
                disabled={busy}
                onChange={(e) => {
                  setBase(e.target.value);
                  load(e.target.value, edited);
                }}
              >
                {options.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Title
              <TextInput
                aria-label="Title"
                value={title}
                disabled={busy}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setEdited(true);
                }}
              />
            </label>
            <label>
              Description
              <textarea
                aria-label="Description"
                rows={14}
                value={body}
                disabled={busy}
                onChange={(e) => {
                  setBody(e.target.value);
                  setEdited(true);
                }}
              />
            </label>
            <div>
              <label>
                <input
                  type="checkbox"
                  aria-label="Open as draft"
                  checked={draft}
                  disabled={busy}
                  onChange={(e) => setDraft(e.target.checked)}
                />{" "}
                Open as draft
              </label>{" "}
              <Button size="sm" disabled={busy || !ctx} onClick={() => ctx && fill(ctx)}>
                Regenerate
              </Button>
            </div>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
