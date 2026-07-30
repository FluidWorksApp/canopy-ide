// Content of one file sub-tab: native viewer (preview), Monaco (source),
// git diff (HEAD vs working tree), or the external-change diff.
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
}

export function FileView(props: FileViewProps) {
  const { file } = props;

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
  if (file.external != null && (file.kind === "code" || file.view === "source")) {
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
      />
    );
  }

  // Git diff: HEAD vs current working copy.
  if (file.view === "diff" && file.diffOriginal != null) {
    const text = file.bytes ? decoder.decode(file.bytes) : "";
    const current = modelFor(file.path, text).getValue();
    return (
      <DiffView
        path={file.path}
        title={`${file.name} — HEAD → working tree`}
        original={file.diffOriginal}
        modified={current}
        actions={[{ label: "Edit file", accent: true, onClick: props.onCloseDiff }]}
        agentBar={props.diffAgentBar}
      />
    );
  }

  if (file.kind === "code" || file.view === "source") {
    const text = file.bytes ? decoder.decode(file.bytes) : "";
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
