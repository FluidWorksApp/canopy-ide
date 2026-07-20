// Thin React wrapper around monaco.editor.create — one editor instance,
// models swapped in and out. (The published react wrappers can't pair with the
// @codingame monaco build, and we need direct model control anyway.)
import { useEffect, useRef } from "react";
import { monaco } from "../monaco-setup";
import { getSettings, THEME_CHANGE_EVENT } from "../settings";

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
      const cb = cursorRef.current;
      if (!cb) return;
      const m = editor.getModel();
      if (!m) return;
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
    const sub = model.onDidChangeContent(() => dirtyRef.current(true));
    return () => sub.dispose();
  }, [model]);

  return <div className="fill" ref={containerRef} />;
}
