// The "Icon" row of the Edit project dialog: auto (the project's own favicon
// or app icon), one of the other icons found in its folders, a built-in glyph,
// any image file, or none.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BUILTIN_ICONS,
  detectProjectIcons,
  iconFromPickedFile,
  loadIconFile,
  type IconFs,
  type ProjectIcon,
} from "../projectIcon";
import { ipcIconFs } from "../useProjectIcons";

interface Found {
  path: string;
  rel: string;
  src: string;
}

interface Props {
  /** Component folders, in project order. */
  roots: readonly string[];
  value: ProjectIcon | undefined;
  onChange: (icon: ProjectIcon | undefined) => void;
  fs?: IconFs;
}

export function ProjectIconPicker({ roots, value, onChange, fs = ipcIconFs }: Props) {
  const [found, setFound] = useState<Found[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const rootsKey = JSON.stringify(roots);

  useEffect(() => {
    let live = true;
    setFound(null);
    void (async () => {
      const list: Found[] = [];
      try {
        const candidates = await detectProjectIcons(JSON.parse(rootsKey) as string[], fs);
        for (const c of candidates.slice(0, 6)) {
          const src = await loadIconFile(c.path, fs);
          if (src) list.push({ path: c.path, rel: c.rel, src });
        }
      } catch {
        // Folders not reachable right now: offer the other choices only.
      }
      if (live) setFound(list);
    })();
    return () => {
      live = false;
    };
  }, [rootsKey, fs]);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      onChange(await iconFromPickedFile(file));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const opt = (selected: boolean, title: string, onClick: () => void, body: ReactNode, wide = false) => (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={title}
      title={title}
      className={`pd-icon-opt${wide ? " pd-icon-opt-wide" : ""}${selected ? " selected" : ""}`}
      onClick={onClick}
    >
      {body}
    </button>
  );

  const auto = found?.[0];
  return (
    <div className="pd-section">
      <div className="pd-section-head">
        <span>Icon</span>
        <small>
          {found === null
            ? "Looking for the project's icon…"
            : auto
              ? `Shown on the project tab. Auto uses ${auto.rel}.`
              : "Shown on the project tab. No icon found in the project."}
        </small>
      </div>
      <div className="pd-icon-grid" role="radiogroup" aria-label="Project icon">
        {opt(value === undefined, "Auto", () => onChange(undefined), "Auto", true)}
        {(found ?? []).map((f) =>
          opt(
            value?.kind === "path" && value.path === f.path,
            f.rel,
            () => onChange({ kind: "path", path: f.path }),
            <img src={f.src} alt="" draggable={false} />,
          ),
        )}
        {value?.kind === "path" && !(found ?? []).some((f) => f.path === value.path) &&
          opt(true, value.path, () => {}, "File", true)}
        {BUILTIN_ICONS.map((emoji) =>
          opt(
            value?.kind === "emoji" && value.emoji === emoji,
            emoji,
            () => onChange({ kind: "emoji", emoji }),
            <span aria-hidden>{emoji}</span>,
          ),
        )}
        {value?.kind === "image" &&
          opt(true, "Chosen image", () => {}, <img src={value.dataUrl} alt="" draggable={false} />)}
        {opt(false, "Choose image…", () => fileInput.current?.click(), "Image…", true)}
        {opt(value?.kind === "none", "None", () => onChange({ kind: "none" }), "None", true)}
        <input
          ref={fileInput}
          type="file"
          hidden
          aria-label="Image file"
          accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,image/webp,image/jpeg,image/gif,.ico"
          onChange={(e) => {
            void pickFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {error && <div className="pd-clone-error">{error}</div>}
    </div>
  );
}
