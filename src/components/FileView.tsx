// Content of one file sub-tab: native viewer (preview), Monaco (source),
// git diff (HEAD vs working tree), or the external-change diff.
import { useMemo } from "react";
import type { ReactNode } from "react";
import type { OpenFile } from "../types";
import * as ipc from "../ipc";
import { describeBlock } from "../fileOpen";
import { modelFor } from "../monaco-setup";
import { MonacoEditor } from "./MonacoEditor";
import { DiffView } from "./DiffView";
import {
  DocxView,
  HtmlView,
  ImageView,
  JsonView,
  MarkdownView,
  NotebookView,
  PdfView,
  SheetView,
} from "./viewers";
import { Button } from "./ui";

const decoder = new TextDecoder();

interface FileViewProps {
  /** Only the foreground document owns decoded/viewer/editor surfaces. The
   *  OpenFile bytes and Monaco model remain the rehydration source. */
  active: boolean;
  file: OpenFile;
  onSave: () => void;
  onDirty: (dirty: boolean) => void;
  onAcceptExternal: () => void;
  onKeepMine: () => void;
  onCloseDiff: () => void;
  /** Set while this file is shared live, so the caret goes out as presence. */
  onCursor?: (anchor: number, head: number) => void;
  /** "Ask an agent about this diff" control, shown on the git-diff view only. */
  diffAgentBar?: ReactNode;
  /** Load a file that was refused for its size anyway. */
  onOpenAnyway?: () => void;
  /** Tab-level control (the research CTA) that normally floats top-right over
   *  the content. The diff views have their own toolbar in that corner, so it
   *  goes into the toolbar instead — see `hasDiffToolbar`. */
  toolbarExtra?: ReactNode;
}

/** The two views that render a `DiffView`, and so put a button row across the
 *  top-right of the tab. Exported as predicates rather than duplicated as
 *  conditions, so what the tab believes and what `FileView` renders cannot
 *  drift apart and start stacking controls on each other. */
const isExternalDiff = (f: OpenFile) =>
  !f.blocked && f.external != null && (f.kind === "code" || f.view === "source");

const isGitDiff = (f: OpenFile) =>
  !f.blocked && f.view === "diff" && f.diffOriginal != null;

export const hasDiffToolbar = (f: OpenFile) => isExternalDiff(f) || isGitDiff(f);

export function FileView(props: FileViewProps) {
  const { file } = props;
  // Decoded once per byte array rather than per render. `modelFor` hands back
  // the existing model and discards this when one is already open, so the
  // branches below were re-decoding the whole file — potentially megabytes —
  // on every render of the active pane, to build a string usually thrown away.
  // It has to live above the early returns: a hook cannot be conditional, and
  // the empty-string shortcut is wrong because `modelFor` *creates* the model
  // from it the first time a file is opened.
  const text = useMemo(
    () => (props.active && file.bytes ? decoder.decode(file.bytes) : ""),
    [props.active, file.bytes],
  );

  // Keep the pane mounted so tab identity/state is stable, but unmount every
  // heavyweight child while backgrounded. Code text already lives in its
  // Monaco model; native viewers can be recreated losslessly from file.bytes.
  if (!props.active) return <div className="fill" aria-hidden />;

  // Refused before the bytes were read — say why, and offer the two things
  // that are actually useful for a file Canopy can't show.
  if (file.blocked) {
    const { title, detail } = describeBlock(file.blocked);
    return (
      <div className="viewer-scroll viewer-center">
        <div className="blocked-file">
          <div className="blocked-file-title">{title}</div>
          <div className="blocked-file-path">{file.name}</div>
          <div className="blocked-file-detail">{detail}</div>
          <div className="blocked-file-actions">
            <Button onClick={() => void ipc.fsReveal(file.path)}>
              Reveal in file manager
            </Button>
            {/* Only for size: a binary blob has nothing to show however hard
                you insist, but "too large" is a judgement call the user is
                entitled to overrule on their own machine. */}
            {file.blocked.reason === "too-large" && props.onOpenAnyway && (
              <Button onClick={props.onOpenAnyway}>
                Open anyway
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Pending external change on a text file → review before it clobbers you.
  if (isExternalDiff(file)) {
    const model = modelFor(file.path, "");
    return (
      <DiffView
        path={file.path}
        title={`Changed on disk: ${file.name}`}
        original={model.getValue()}
        modified={file.external!}
        actions={[
          { label: "Accept disk version", accent: true, onClick: props.onAcceptExternal },
          { label: "Keep my version", onClick: props.onKeepMine },
        ]}
        toolbarExtra={props.toolbarExtra}
      />
    );
  }

  // Git diff: HEAD vs current working copy.
  if (isGitDiff(file)) {
    const current = modelFor(file.path, text).getValue();
    return (
      <DiffView
        path={file.path}
        title={`${file.name} — HEAD → working tree`}
        original={file.diffOriginal!}
        modified={current}
        actions={[{ label: "Edit file", accent: true, onClick: props.onCloseDiff }]}
        agentBar={props.diffAgentBar}
        toolbarExtra={props.toolbarExtra}
      />
    );
  }

  if (file.kind === "code" || file.view === "source") {
    const model = modelFor(file.path, text);
    return (
      <MonacoEditor
        model={model}
        onSave={props.onSave}
        onDirty={props.onDirty}
        onCursor={props.onCursor}
      />
    );
  }

  if (!file.bytes) return <div className="viewer-loading">Loading…</div>;
  switch (file.kind) {
    case "markdown":
      return <MarkdownView bytes={file.bytes} />;
    case "html":
      return <HtmlView bytes={file.bytes} />;
    case "pdf":
      return <PdfView bytes={file.bytes} />;
    case "sheet":
      return <SheetView bytes={file.bytes} />;
    case "notebook":
      return <NotebookView bytes={file.bytes} />;
    case "json":
      return <JsonView bytes={file.bytes} path={file.path} />;
    case "docx":
      return <DocxView bytes={file.bytes} />;
    case "image":
      return <ImageView path={file.path} bytes={file.bytes} />;
    default:
      return null;
  }
}
