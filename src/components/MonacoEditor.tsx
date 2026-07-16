// Thin React wrapper around monaco.editor.create — one editor instance,
// models swapped in and out. (The published react wrappers can't pair with the
// @codingame monaco build, and we need direct model control anyway.)
import { useEffect, useRef } from "react";
import { monaco } from "../monaco-setup";

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
    const editor = monaco.editor.create(el, {
      theme: "canopy-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveRef.current(),
    );
    return () => {
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
