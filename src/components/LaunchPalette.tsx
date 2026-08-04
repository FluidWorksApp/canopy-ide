// The keyboard route into the ＋ menu (Cmd/Ctrl+N): shell and every agent CLI
// as a type-to-filter list, so opening a new tab
// never has to go through the mouse. Same overlay shape as Quick Open, on
// purpose: two palettes that look alike are one thing to learn.
import { useEffect, useMemo, useRef, useState } from "react";
import { AGENT_CLIS, type AgentCli } from "../projects";
import { AgentIcon, TerminalIcon } from "./icons";
import { fuzzy } from "../fuzzy";
import { useEscapeLayer } from "../useEscape";

type Row =
  | { kind: "shell" }
  | { kind: "cli"; cli: AgentCli };

interface LaunchPaletteProps {
  /** CLI bin → on PATH here. Drives the "install" hint. */
  installed: Record<string, boolean>;
  cliUpdates: Record<
    string,
    { hasUpdate?: boolean; installed?: string; latest?: string }
  >;
  /** Where the launch lands — shown in the footer so it isn't a guess. */
  targetLabel?: string;
  onShell: () => void;
  onLaunchCli: (cli: AgentCli) => void;
  onClose: () => void;
}

const rowKey = (r: Row) => (r.kind === "cli" ? `cli:${r.cli.id}` : r.kind);
const rowLabel = (r: Row) =>
  r.kind === "cli" ? r.cli.name : "Shell";

export function LaunchPalette({
  installed,
  cliUpdates,
  targetLabel,
  onShell,
  onLaunchCli,
  onClose,
}: LaunchPaletteProps) {
  // Escape is the palette's own, all the way down to the panel behind it.
  useEscapeLayer();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const rows: Row[] = useMemo(() => {
    const all: Row[] = [
      { kind: "shell" },
      ...AGENT_CLIS.map((cli) => ({ kind: "cli" as const, cli })),
    ];
    if (!query.trim()) return all;
    // Menu order is kept rather than re-ranked by score: the list is short
    // enough to read, and a list that reshuffles under the cursor is worse
    // than one whose order you can predict.
    return all.filter((r) => fuzzy(query, rowLabel(r)) !== null);
  }, [query]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(".palette-row-active")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const commit = (row: Row | undefined) => {
    if (!row) return;
    onClose();
    if (row.kind === "shell") onShell();
    else onLaunchCli(row.cli);
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="New shell or agent…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((i) => Math.min(i + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit(rows[sel]);
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {rows.length === 0 && <div className="palette-empty">No match</div>}
          {rows.map((r, i) => {
            const up = r.kind === "cli" ? cliUpdates[r.cli.bin] : undefined;
            const missing = r.kind === "cli" && !installed[r.cli.bin];
            return (
              <div
                key={rowKey(r)}
                className={`palette-row launch-row ${i === sel ? "palette-row-active" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => commit(r)}
              >
                <span className="launch-icon">
                  {r.kind === "shell" ? (
                    <TerminalIcon size={15} />
                  ) : (
                    <AgentIcon id={r.cli.id} size={15} />
                  )}
                </span>
                <span className="palette-name">{rowLabel(r)}</span>
                {missing && <span className="cli-install">install</span>}
                {!missing && up?.hasUpdate && (
                  <span className="cli-update" title={`${up.installed} → ${up.latest}`}>
                    ⇡ {up.latest}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>New{targetLabel ? ` · ${targetLabel}` : ""}</span>
          <span>↑↓ navigate · ↵ open · esc close</span>
        </div>
      </div>
    </div>
  );
}
