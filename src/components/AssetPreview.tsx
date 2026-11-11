// The overlay that opens beside the card when a row in its Assets list is
// hovered. It is drawn on top of whatever is behind it and takes no layout
// space; the pointer passes through it, so it can never be in the way.
//
// Portalled to the page and fixed to the viewport: the card behind it is a
// blurred surface, which would otherwise become the containing block of a
// fixed child and clip it.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import * as ipc from "../ipc";
import { hasTextPreview, imageMime, type Asset } from "../agentAssets";

const READ_BYTES = 64 * 1024;
const EXCERPT_CHARS = 1800;
const WIDTH = 360;
const MAX_HEIGHT = 380;

type State =
  | { status: "loading" }
  | { status: "image"; url: string }
  | { status: "text"; text: string; truncated: boolean }
  | { status: "running" }
  | { status: "open-to-view" }
  | { status: "unreadable" };

export function AssetPreview({ asset, anchor }: { asset: Asset; anchor: DOMRect }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let stale = false;
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    if (asset.kind === "preview") {
      setState({ status: "running" });
      return;
    }
    if (asset.kind !== "image" && !hasTextPreview(asset.kind)) {
      // A page, a PDF or a document is looked at in its own tab.
      setState({ status: "open-to-view" });
      return;
    }
    ipc
      .fsReadFile(asset.path, READ_BYTES)
      .then((bytes) => {
        if (stale) return;
        if (asset.kind === "image") {
          objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: imageMime(asset.path) }));
          setState({ status: "image", url: objectUrl });
          return;
        }
        const text = new TextDecoder().decode(bytes);
        setState({ status: "text", text: text.slice(0, EXCERPT_CHARS), truncated: text.length > EXCERPT_CHARS || bytes.length >= READ_BYTES });
      })
      .catch(() => {
        if (!stale) setState({ status: "unreadable" });
      });
    return () => {
      stale = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.path, asset.kind]);

  // To the left of the anchor row, kept inside the window.
  const right = Math.max(8, window.innerWidth - anchor.left + 10);
  const top = Math.min(Math.max(8, anchor.top - 8), Math.max(8, window.innerHeight - MAX_HEIGHT - 8));

  return createPortal(
    <div className="asset-preview" style={{ right, top, width: WIDTH, maxHeight: MAX_HEIGHT }} role="tooltip" aria-label={`Preview of ${asset.name}`}>
      <div className="asset-preview-head" title={asset.path}>{asset.name}</div>
      <div className="asset-preview-body">
        {state.status === "loading" && <span className="asset-preview-dim">Loading…</span>}
        {state.status === "image" && <img src={state.url} alt="" draggable={false} />}
        {state.status === "text" && (
          <pre>
            {state.text}
            {state.truncated ? "\n…" : ""}
          </pre>
        )}
        {state.status === "running" && <span className="asset-preview-dim">Running now. Click to open it in a preview tab.</span>}
        {state.status === "open-to-view" && <span className="asset-preview-dim">Click to open it in a tab.</span>}
        {state.status === "unreadable" && <span className="asset-preview-dim">Outside this project. Click to open.</span>}
      </div>
      <div className="asset-preview-foot" title={asset.path}>{asset.path}</div>
    </div>,
    document.body,
  );
}
