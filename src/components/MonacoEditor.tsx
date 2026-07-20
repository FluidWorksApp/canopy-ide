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
}

export function MonacoEditor({ model, onSave, onDirty }: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const saveRef = useRef(onSave);
  const dirtyRef = useRef(onDirty);
  saveRef.current = onSave;
  dirtyRef.current = onDirty;

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
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onSettingsChange);
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
