// Native file renderers. Each viewer receives raw bytes from the Rust core and
// renders fully offline (mermaid and SheetJS are lazy-loaded so they cost
// nothing until a matching file is opened).
import { useEffect, useMemo, useState } from "react";
import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { sanitizeHtml } from "../markdown";
import { Markdown } from "./Markdown";
import "highlight.js/styles/github-dark.css";

const decoder = new TextDecoder();

export type ViewerKind =
  | "markdown"
  | "html"
  | "pdf"
  | "sheet"
  | "notebook"
  | "image"
  | "json"
  | "docx"
  | "code";

export function viewerKindFor(path: string): ViewerKind {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (["html", "htm"].includes(ext)) return "html";
  if (ext === "pdf") return "pdf";
  if (["xlsx", "xls", "csv", "ods"].includes(ext)) return "sheet";
  if (ext === "ipynb") return "notebook";
  if (["json", "jsonc"].includes(ext)) return "json";
  if (["docx", "doc"].includes(ext)) return "docx";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"].includes(ext))
    return "image";
  return "code";
}

/** True when the type has a meaningful text source to toggle to. */
export function hasSourceView(kind: ViewerKind): boolean {
  return ["markdown", "html", "notebook", "sheet", "json"].includes(kind);
}

// ---------- Markdown ----------

/** A .md file from the user's own workspace, so it renders at full strength:
 *  wikilinks resolve and its checkboxes are live. Everything that used to be
 *  implemented here — mermaid, fenced-code highlighting — now lives in
 *  <Markdown>, which is what stopped those features being a property of *which
 *  tab you were in* rather than of markdown. */
export function MarkdownView({
  bytes,
  onWikilink,
  onEdit,
}: {
  bytes: Uint8Array;
  onWikilink?: (target: string) => void;
  /** Persist the file after a checkbox was ticked. Absent for a read-only
   *  surface, which leaves the boxes rendered but inert. */
  onEdit?: (next: string) => void;
}) {
  const text = useMemo(() => decoder.decode(bytes), [bytes]);
  return (
    <div className="viewer-scroll">
      <Markdown
        text={text}
        origin="owned"
        onWikilink={onWikilink}
        onToggleTask={onEdit}
      />
    </div>
  );
}

// ---------- HTML ----------

export function HtmlView({ bytes }: { bytes: Uint8Array }) {
  const src = useMemo(() => decoder.decode(bytes), [bytes]);
  return (
    <iframe
      className="fill viewer-frame"
      sandbox="allow-scripts"
      srcDoc={src}
      title="html preview"
    />
  );
}

// ---------- PDF / images via blob URLs ----------

function useBlobUrl(bytes: Uint8Array, type: string): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const blob = new Blob([copy], { type });
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, type]);
  return url;
}

export function PdfView({ bytes }: { bytes: Uint8Array }) {
  const url = useBlobUrl(bytes, "application/pdf");
  if (!url) return null;
  return <embed className="fill" src={url} type="application/pdf" />;
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
};

export function ImageView({ path, bytes }: { path: string; bytes: Uint8Array }) {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const url = useBlobUrl(bytes, IMAGE_TYPES[ext] ?? "application/octet-stream");
  if (!url) return null;
  return (
    <div className="viewer-scroll viewer-center">
      <img className="viewer-image" src={url} alt={path} />
    </div>
  );
}

// ---------- Spreadsheets (SheetJS, lazy) ----------

export function SheetView({ bytes }: { bytes: Uint8Array }) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Sanitising a whole spreadsheet's generated <table> is not render-body work:
  // this is the active tab's pane, so it was re-run on every ProjectView render
  // — about twice a second while an agent is working. Every other HTML surface
  // in the app already memoises this; this one was the outlier.
  const sheetHtml = useMemo(
    () => sanitizeHtml(sheets?.[active]?.html ?? ""),
    [sheets, active],
  );

  useEffect(() => {
    let cancelled = false;
    void import("xlsx")
      .then((XLSX) => {
        const wb = XLSX.read(bytes, { type: "array" });
        if (cancelled) return;
        setSheets(
          wb.SheetNames.map((name) => ({
            name,
            html: XLSX.utils.sheet_to_html(wb.Sheets[name]),
          })),
        );
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (error) return <div className="viewer-error">Failed to parse sheet: {error}</div>;
  if (!sheets) return <div className="viewer-loading">Parsing workbook…</div>;
  return (
    <div className="sheet-view">
      {sheets.length > 1 && (
        <div className="tabs sheet-tabs">
          {sheets.map((s, i) => (
            <div
              key={s.name}
              className={`tab ${i === active ? "tab-active" : ""}`}
              onClick={() => setActive(i)}
            >
              {s.name}
            </div>
          ))}
        </div>
      )}
      <div
        className="viewer-scroll sheet-table"
        dangerouslySetInnerHTML={{ __html: sheetHtml }}
      />
    </div>
  );
}

// ---------- JSON (collapsible tree) ----------

// Files that legitimately carry // comments and trailing commas — the same
// set VSCode opens in "jsonc" language mode. Everything else is strict JSON
// so stray comments in package.json or lock files are flagged, not silently swallowed.
// Files that legitimately carry // comments and trailing commas — the same
// set VS Code opens in "jsonc" language mode. Everything else uses strict JSON.
function isJsoncFile(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  if (name.endsWith(".jsonc")) return true;
  if (/^(tsconfig|jsconfig).*\.json$/.test(name)) return true;
  if (/[/\\]\.(vscode|devcontainer)[/\\]/.test(path) || path.includes("devcontainer.json")) return true;
  if (name === "devcontainer.json") return true;
  if (name === ".eslintrc.json" || name === "keybindings.json") return true;
  if (name.endsWith(".code-workspace")) return true;
  return false;
}

export function JsonView({ bytes, path }: { bytes: Uint8Array; path: string }) {
  const parsed = useMemo(() => {
    const text = decoder.decode(bytes);
    if (text.trim() === "") return { empty: true };
    const errors: ParseError[] = [];
    const jsonc = isJsoncFile(path);
    // jsonc-parser (the same tolerant parser VSCode uses) is used for JSONC
    // files; strict JSON.parse for everything else so stray comments in
    // package.json, lock files, or data fixtures are not silently swallowed.
    const value = parseJsonc(text, errors, {
      allowTrailingComma: jsonc,
      disallowComments: !jsonc,
    });
    if (errors.length > 0) {
      const e = errors[0];
      const lines = text.slice(0, e.offset).split("\n");
      const line = lines.length;
      const col = (lines[lines.length - 1]?.length ?? 0) + 1;
      return { error: `${printParseErrorCode(e.error)} at ${line}:${col}` };
    }
    return { value };
  }, [bytes, path]);

  if ("empty" in parsed) {
    return <div className="viewer-error">Empty file</div>;
  }
  if ("error" in parsed) {
    return <div className="viewer-error">Invalid JSON: {parsed.error}</div>;
  }
  return (
    <div className="viewer-scroll json-view">
      <JsonNode value={parsed.value} depth={0} />
    </div>
  );
}

function JsonNode({ value, name, depth }: { value: unknown; name?: string; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const key = name !== undefined && <span className="json-key">"{name}": </span>;

  if (Array.isArray(value) || (value !== null && typeof value === "object")) {
    const isArray = Array.isArray(value);
    const entries = isArray
      ? (value as unknown[]).map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>);
    return (
      <div className="json-node">
        <span className="json-toggle" onClick={() => setOpen((v) => !v)}>
          <span className="tree-chevron">{open ? "▾" : "▸"}</span>
          {key}
          <span className="json-brace">
            {isArray ? "[" : "{"}
            {!open && ` … ${entries.length} ${isArray ? "items" : "keys"} `}
            {!open && (isArray ? "]" : "}")}
          </span>
        </span>
        {open && (
          <>
            <div className="json-children">
              {entries.map(([k, v]) => (
                <JsonNode key={k} name={isArray ? undefined : k} value={v} depth={depth + 1} />
              ))}
            </div>
            <span className="json-brace">{isArray ? "]" : "}"}</span>
          </>
        )}
      </div>
    );
  }

  const cls =
    typeof value === "string"
      ? "json-string"
      : typeof value === "number"
        ? "json-number"
        : typeof value === "boolean"
          ? "json-bool"
          : "json-null";
  return (
    <div className="json-leaf">
      {key}
      <span className={cls}>{JSON.stringify(value)}</span>
    </div>
  );
}

// ---------- DOCX (mammoth, lazy) ----------

/** Copy into a fresh ArrayBuffer — no shared-buffer offset surprises. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

export function DocxView({ bytes }: { bytes: Uint8Array }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    // .docx is a zip (PK..); legacy .doc is an OLE compound file (D0 CF 11 E0).
    if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf) {
      setError(
        "This is a legacy binary .doc file — only .docx is supported. Re-save it as .docx to preview.",
      );
      return;
    }
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      setError(
        `Not a valid .docx (zip) file — starts with bytes ${[...bytes.slice(0, 4)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ")}.`,
      );
      return;
    }
    void import("mammoth")
      .then((mammoth) => mammoth.convertToHtml({ arrayBuffer: toArrayBuffer(bytes) }))
      .then((result) => {
        // mammoth emits HTML from the document's own contents — sanitize it
        // like any other converted source.
        if (!cancelled) setHtml(sanitizeHtml(result.value));
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (error) return <div className="viewer-error">Failed to read document: {error}</div>;
  if (html == null) return <div className="viewer-loading">Converting document…</div>;
  return (
    <div className="viewer-scroll">
      <div className="markdown-body docx-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// ---------- Jupyter notebooks ----------

interface NbCell {
  cell_type: string;
  source: string | string[];
  outputs?: NbOutput[];
}
interface NbOutput {
  output_type: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
}

const joinSource = (s: string | string[] | undefined) =>
  Array.isArray(s) ? s.join("") : (s ?? "");

export function NotebookView({ bytes }: { bytes: Uint8Array }) {
  const cells = useMemo<NbCell[] | null>(() => {
    try {
      return JSON.parse(decoder.decode(bytes)).cells ?? [];
    } catch {
      return null;
    }
  }, [bytes]);

  if (!cells) return <div className="viewer-error">Not a valid notebook file.</div>;
  return (
    <div className="viewer-scroll notebook">
      {cells.map((cell, i) =>
        cell.cell_type === "markdown" ? (
          // A notebook cell is markdown in a file the user owns, so it gets
          // the same treatment as any other .md — including the diagrams and
          // highlighting it silently went without before.
          <Markdown
            key={i}
            className="nb-md"
            text={joinSource(cell.source)}
            origin="owned"
          />
        ) : (
          <div key={i} className="nb-code">
            <pre className="nb-source">{joinSource(cell.source)}</pre>
            {(cell.outputs ?? []).map((out, j) => (
              <NbOutputView key={j} out={out} />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

function NbOutputView({ out }: { out: NbOutput }) {
  if (out.data?.["image/png"]) {
    return (
      <img
        className="nb-output-img"
        src={`data:image/png;base64,${joinSource(out.data["image/png"]).replace(/\n/g, "")}`}
        alt="output"
      />
    );
  }
  if (out.data?.["text/html"]) {
    return (
      <div
        className="nb-output"
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(joinSource(out.data["text/html"])) }}
      />
    );
  }
  const text = out.text ?? out.data?.["text/plain"];
  if (text) return <pre className="nb-output">{joinSource(text)}</pre>;
  return null;
}
