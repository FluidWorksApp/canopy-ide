// The wiring between claude_ide.rs and the window: the `claude-ide` event in,
// Monaco's markers and selections out. Policy lives in claudeIde.ts; this is
// the part that touches Monaco and IPC, kept small so it can be read whole.
import * as ipc from "./ipc";
import { postAttention } from "./attention";
import { installClaudeEditorHooks } from "./claudeEditorHooks";
import { monaco } from "./monaco-setup";
import { prime } from "./agentOps";
import { hasEditorModelOwner, leaseEditorModel } from "./editorModelRetention";
import { readBoundedFile } from "./boundedFileRead";
import { sizeLimitFor } from "./fileOpen";
import {
  applyClaudeIdeEvent,
  claudeIdeState,
  debounced,
  hasSessionFor,
  lastActiveTerminal,
  markersToDiagnostics,
  mentionLines,
  pathOfFileUri,
  selectionParams,
  type ClaudeIdeEvent,
  type EditorSelection,
} from "./claudeIde";

/** Window event a project listens for to bring forward the terminal an
 *  "Add to Claude" mention went to. */
export const CLAUDE_MENTIONED_EVENT = "canopy:claude-mentioned";

/** How long a `{uri}` baseline waits for a file Canopy didn't have open to get
 *  its first markers. Inside the CLI's 500 ms, with room for the round trip;
 *  a cold server misses it and the file is answered as unknown (`[]`). */
const BASELINE_WAIT_MS = 300;
/** How long the `{}` fetch after a write waits for re-analysis. Inside the
 *  CLI's 2 s. */
const FETCH_WAIT_MS = 1200;
/** How long a file the baseline opened stays open for the fetches that follow
 *  the write. Then it is released like any agent-only model. */
const WARM_MS = 30_000;
const SELECTION_DEBOUNCE_MS = 150;

const warmed = new Map<string, { release: () => void; timer: ReturnType<typeof setTimeout> }>();

function warm(key: string) {
  const held = warmed.get(key);
  if (held) clearTimeout(held.timer);
  const release = held?.release ?? leaseEditorModel(key);
  warmed.set(key, { release, timer: setTimeout(() => unwarm(key), WARM_MS) });
}

function unwarm(key: string) {
  const held = warmed.get(key);
  if (!held) return;
  clearTimeout(held.timer);
  warmed.delete(key);
  held.release();
}

/** Resolves true once any of `uris` gets new markers, false after `ms`. */
function markersChange(uris: monaco.Uri[], ms: number): Promise<boolean> {
  const keys = new Set(uris.map((u) => u.toString()));
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), ms);
    const sub = monaco.editor.onDidChangeMarkers((changed) => {
      if (changed.some((u) => keys.has(u.toString()))) finish(true);
    });
    function finish(changed: boolean) {
      clearTimeout(timer);
      sub.dispose();
      resolve(changed);
    }
  });
}

const fileDiagnostics = (resource: monaco.Uri, uri = resource.toString()) => ({
  uri,
  diagnostics: markersToDiagnostics(monaco.editor.getModelMarkers({ resource })),
});

/** The `{uri}` baseline the CLI takes just before it writes a file. A file
 *  Canopy has open answers from its markers at once; one it doesn't is opened
 *  for the language server and kept warm for the fetch after the write, and
 *  answered only if the server publishes in time — an empty baseline for a
 *  file with existing errors would report all of them as new. */
async function baseline(uri: string, root: string): Promise<unknown[]> {
  const path = pathOfFileUri(uri);
  if (!path) return [];
  const resource = monaco.Uri.file(path);
  if (monaco.editor.getModel(resource)) return [fileDiagnostics(resource, uri)];
  warm(resource.toString());
  const published = markersChange([resource], BASELINE_WAIT_MS);
  void prime(path, [root]).catch(() => unwarm(resource.toString()));
  return (await published) ? [fileDiagnostics(resource, uri)] : [];
}

/** The `{}` fetch after a write. Files the baseline warmed are re-read from
 *  disk first — Claude just changed them, and nobody else is going to tell an
 *  agent-only model — then every open file answers from its markers. A model
 *  a tab has taken over meanwhile is left to the tab's own disk-change review. */
async function everything(): Promise<unknown[]> {
  const refreshed: monaco.Uri[] = [];
  await Promise.all(
    [...warmed.keys()].map(async (key) => {
      const resource = monaco.Uri.parse(key);
      const model = monaco.editor.getModel(resource);
      if (!model || hasEditorModelOwner(key)) return;
      warm(key);
      try {
        const bytes = await readBoundedFile(resource.path, {
          scope: "claude-ide",
          maxBytes: sizeLimitFor("code"),
        });
        const text = new TextDecoder().decode(bytes);
        if (text !== model.getValue()) {
          model.setValue(text);
          refreshed.push(resource);
        }
      } catch {
        // Gone or too big: answer from what the server last said.
      }
    }),
  );
  if (refreshed.length) await markersChange(refreshed, FETCH_WAIT_MS);
  return monaco.editor
    .getModels()
    .filter((m) => m.uri.scheme === "file")
    .map((m) => fileDiagnostics(m.uri));
}

async function answerDiagnostics(event: Extract<ClaudeIdeEvent, { kind: "diagnostics" }>) {
  try {
    const data = event.uri ? await baseline(event.uri, event.root) : await everything();
    void ipc.claudeIdeReply(event.requestId, data);
  } catch {
    void ipc.claudeIdeReply(event.requestId, []);
  }
}

/** Listen for the protocol's UI side and give the editor its hooks. Once,
 *  from App. */
export function startClaudeIdeBridge(): () => void {
  let unlisten: (() => void) | undefined;
  let disposed = false;
  const uninstall = installClaudeEditorHooks({
    selection: noteEditorSelection,
    addToClaude: async (model, selection) => {
      const problem = await addToClaude(model, selection);
      if (problem)
        postAttention({ kind: "fyi", tone: "info", title: problem, source: "app" });
      return problem;
    },
  });
  void ipc
    .onClaudeIde((event) => {
      if (event.kind === "diagnostics") void answerDiagnostics(event);
      else applyClaudeIdeEvent(event);
    })
    .then((off) => {
      if (disposed) off();
      else unlisten = off;
    })
    .catch(() => {});
  // A reloaded window starts with an empty store while the CLIs it lost
  // track of are still attached; ask once, after the listener is up.
  void ipc
    .claudeIdeConnections()
    .then((live) => {
      if (disposed) return;
      for (const { ptyId, root } of live)
        applyClaudeIdeEvent({ kind: "connection", ptyId, root, connected: true });
    })
    .catch(() => {});
  return () => {
    disposed = true;
    uninstall();
    unlisten?.();
  };
}

const sendSelection = debounced((path: string, params: unknown) => {
  void ipc.claudeIdeSelection(path, params).catch(() => {});
}, SELECTION_DEBOUNCE_MS);

/** The editor's selection moved (or a file came to the front, with an empty
 *  one). Only real files, and only when a Claude session works on them. */
export function noteEditorSelection(
  model: monaco.editor.ITextModel,
  selection: EditorSelection,
) {
  if (model.uri.scheme !== "file") return;
  const path = model.uri.path;
  if (!hasSessionFor(claudeIdeState(), path)) return;
  const range = new monaco.Range(
    selection.startLineNumber,
    selection.startColumn,
    selection.endLineNumber,
    selection.endColumn,
  );
  sendSelection(path, selectionParams(path, selection, model.getValueInRange(range)));
}

/** "Add to Claude": the file, and the selected lines if any, into the prompt
 *  of the Claude session on it — the one the user last had in front of them
 *  if that qualifies. Resolves with a sentence for the user when nothing
 *  could take it. */
export async function addToClaude(
  model: monaco.editor.ITextModel,
  selection: EditorSelection | null,
): Promise<string | null> {
  if (model.uri.scheme !== "file") return "Only a file on disk can be sent to Claude.";
  const path = model.uri.path;
  if (!hasSessionFor(claudeIdeState(), path))
    return "No Claude Code session in this component is connected to Canopy.";
  try {
    const ptyId = await ipc.claudeIdeAtMention({
      path,
      ...(mentionLines(selection) ?? {}),
      prefer: lastActiveTerminal(),
    });
    window.dispatchEvent(new CustomEvent(CLAUDE_MENTIONED_EVENT, { detail: { ptyId } }));
    return null;
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}
