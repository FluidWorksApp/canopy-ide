// Thin React wrapper around monaco.editor.create — one editor instance,
// models swapped in and out. (The published react wrappers can't pair with the
// @codingame monaco build, and we need direct model control anyway.)
import { useEffect, useRef } from "react";
import { monaco } from "../monaco-setup";
import { getSettings, THEME_CHANGE_EVENT } from "../settings";
import { setCaret, truncateSelection } from "../editorState";

interface MonacoEditorProps {
  model: monaco.editor.ITextModel;
  onSave: () => void;
  onDirty: (dirty: boolean) => void;
  /** Caret and selection in document offsets, for live collaboration to
   *  broadcast as presence. Offsets rather than positions because that is the
   *  coordinate space the operations already use. */
  onCursor?: (anchor: number, head: number) => void;
}

export function MonacoEditor({ model, onSave, onDirty, onCursor }: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const saveRef = useRef(onSave);
  const dirtyRef = useRef(onDirty);
  const cursorRef = useRef(onCursor);
  saveRef.current = onSave;
  dirtyRef.current = onDirty;
  cursorRef.current = onCursor;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const s = getSettings();
    const editor = monaco.editor.create(el, {
      theme: "canopy-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: s.editorFontFamily,
      fontSize: s.editorFontSize,
      cursorStyle: s.editorCursorStyle === "bar" ? "line" : s.editorCursorStyle,
      cursorBlinking: s.editorCursorBlink ? "blink" : "solid",
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;
    // The Editor pane in Settings wrote these four straight to storage and
    // nothing ever read them back, so changing the editor font did nothing at
    // all. Apply on create, and live on change like the terminal does.
    const onSettingsChange = () => {
      const next = getSettings();
      editor.updateOptions({
        fontFamily: next.editorFontFamily,
        fontSize: next.editorFontSize,
        cursorStyle: next.editorCursorStyle === "bar" ? "line" : next.editorCursorStyle,
        cursorBlinking: next.editorCursorBlink ? "blink" : "solid",
      });
    };
    window.addEventListener(THEME_CHANGE_EVENT, onSettingsChange);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current(),
    );
    // Read through the ref, so a tab that isn't collaborating pays for one
    // dead callback rather than the subscription being torn down and rebuilt
    // every time the parent re-renders.
    const cursorSub = editor.onDidChangeCursorSelection((e) => {
      const m = editor.getModel();
      if (!m) return;
      // Same event feeds the agent tools: where the caret is, and what is
      // highlighted, is the context behind every "fix this".
      const head = e.selection.getPosition();
      setCaret({
        path: m.uri.path,
        line: head.lineNumber,
        column: head.column,
        ...(e.selection.isEmpty()
          ? {}
          : {
              selection: truncateSelection(m.getValueInRange(e.selection)),
              selectionStartLine: e.selection.startLineNumber,
              selectionEndLine: e.selection.endLineNumber,
            }),
      });
      const cb = cursorRef.current;
      if (!cb) return;
      cb(
        m.getOffsetAt(e.selection.getStartPosition()),
        m.getOffsetAt(e.selection.getEndPosition()),
      );
    });
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onSettingsChange);
      cursorSub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setModel(model);
    const pos = editor.getPosition();
    setCaret({ path: model.uri.path, line: pos?.lineNumber ?? 1, column: pos?.column ?? 1 });
    const sub = model.onDidChangeContent(() => dirtyRef.current(true));
    // An agent that says "look at line 340" (canopy_open_file) reaches the
    // editor here: the tab may already have been open, so this can't ride on
    // the open path alone.
    const reveal = (e: Event) => {
      const d = (e as CustomEvent).detail as { path?: string; line?: number };
      if (!d?.path || !d.line || model.uri.path !== d.path) return;
      const line = Math.max(1, Math.min(d.line, model.getLineCount()));
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.focus();
    };
    window.addEventListener("canopy:reveal-line", reveal);
    return () => {
      window.removeEventListener("canopy:reveal-line", reveal);
      sub.dispose();
    };
  }, [model]);

  return <div className="fill" ref={containerRef} />;
}
