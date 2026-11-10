// A read-only view of a file that lives on another machine. Opened by
// environments/remoteFiles.ts; mounted once in the app. It never writes, and it
// says where the file is: the machine's name is always on screen.
import { useEffect, useState } from "react";
import {
  OPEN_REMOTE_FILE_EVENT,
  RemoteFileRefused,
  readRemoteFile,
  type RemoteFileRequest,
} from "../environments/remoteFiles";

type State =
  | { kind: "loading" }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; url: string }
  | { kind: "error"; message: string };

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const MIME = (path: string) =>
  path.toLowerCase().endsWith(".svg") ? "image/svg+xml"
  : /\.jpe?g$/i.test(path) ? "image/jpeg"
  : `image/${(/\.(\w+)$/.exec(path)?.[1] ?? "png").toLowerCase()}`;

export function RemoteFileViewer() {
  const [request, setRequest] = useState<RemoteFileRequest | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const on = (e: Event) => setRequest((e as CustomEvent<RemoteFileRequest>).detail);
    window.addEventListener(OPEN_REMOTE_FILE_EVENT, on);
    return () => window.removeEventListener(OPEN_REMOTE_FILE_EVENT, on);
  }, []);

  useEffect(() => {
    if (!request) return;
    let live = true;
    let objectUrl: string | null = null;
    setState({ kind: "loading" });
    readRemoteFile(request.env, request.path)
      .then(({ bytes, truncated }) => {
        if (!live) return;
        if (IMAGE.test(request.path)) {
          // A copy into a fresh buffer: Blob wants a plain ArrayBuffer view.
          objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: MIME(request.path) }));
          setState({ kind: "image", url: objectUrl });
          return;
        }
        // A NUL byte in the first block means it is not text.
        if (bytes.subarray(0, 4096).includes(0)) {
          setState({ kind: "error", message: "This file is not text, so it cannot be shown here." });
          return;
        }
        setState({ kind: "text", text: new TextDecoder().decode(bytes), truncated });
      })
      .catch((error) => {
        if (!live) return;
        setState({
          kind: "error",
          message: error instanceof RemoteFileRefused ? error.message : `Could not read it on ${request.machine}: ${String((error as Error)?.message ?? error)}`,
        });
      });
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setRequest(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request]);

  if (!request) return null;
  const name = request.path.split(/[\\/]/).pop() || request.path;
  return (
    <div className="confirm-backdrop" onClick={() => setRequest(null)}>
      <div className="remote-file" role="dialog" aria-label={`${name} on ${request.machine}`} onClick={(e) => e.stopPropagation()}>
        <div className="remote-file-head">
          <span className="remote-file-machine">{request.machine}</span>
          <strong className="remote-file-name" title={request.path}>{name}</strong>
          <span className="remote-file-ro">read-only</span>
          <button type="button" className="remote-file-close" aria-label="Close" onClick={() => setRequest(null)}>×</button>
        </div>
        <div className="remote-file-body">
          {state.kind === "loading" && <p className="remote-file-dim">Reading from {request.machine}…</p>}
          {state.kind === "error" && <p className="remote-file-dim" role="alert">{state.message}</p>}
          {state.kind === "image" && <img src={state.url} alt={name} />}
          {state.kind === "text" && (
            <>
              <pre>{state.text}</pre>
              {state.truncated && <p className="remote-file-dim">Only the first megabyte is shown.</p>}
            </>
          )}
        </div>
        <div className="remote-file-foot" title={request.path}>{request.path}</div>
      </div>
    </div>
  );
}
