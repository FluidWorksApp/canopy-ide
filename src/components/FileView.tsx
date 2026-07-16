// Content of one file sub-tab: native viewer (preview), Monaco (source),
// git diff (HEAD vs working tree), or the external-change diff.
import type { OpenFile } from "../types";
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

const decoder = new TextDecoder();

interface FileViewProps {
  file: OpenFile;
  onSave: () => void;
  onDirty: (dirty: boolean) => void;
  onAcceptExternal: () => void;
  onKeepMine: () => void;
  onCloseDiff: () => void;
}

export function FileView(props: FileViewProps) {
  const { file } = props;

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
      />
    );
  }

  if (file.kind === "code" || file.view === "source") {
    const text = file.bytes ? decoder.decode(file.bytes) : "";
    const model = modelFor(file.path, text);
    return <MonacoEditor model={model} onSave={props.onSave} onDirty={props.onDirty} />;
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
      return <JsonView bytes={file.bytes} />;
    case "docx":
      return <DocxView bytes={file.bytes} />;
    case "image":
      return <ImageView path={file.path} bytes={file.bytes} />;
    default:
      return null;
  }
}
