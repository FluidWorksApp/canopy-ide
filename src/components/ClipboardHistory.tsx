import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as clipboardStore from "../clipboardStore";
import * as ipc from "../ipc";
import { insertTextAtCursor } from "../insertText";
import { getSettings, subscribeSettings, updateSettings } from "../settings";
import { format, matches, resolve } from "../shortcuts";
import { ClipboardIcon } from "./icons";
import "../clipboardHistory.css";

const MAX_VISIBLE = 10;

function age(ts: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function modifiersHeld(e: KeyboardEvent): boolean {
  const chord = resolve("clipboard-history");
  if (!chord) return false;
  return (
    (!chord.meta || e.metaKey) &&
    (!chord.ctrl || e.ctrlKey) &&
    (!chord.alt || e.altKey) &&
    (!chord.shift || e.shiftKey)
  );
}

/** The status-tray clipboard. A click leaves the list open for browsing; the
 * shortcut is a hold-to-cycle picker whose modifier release pastes the choice.
 * With history off there is nothing to browse, so the tray icon goes away and
 * the shortcut is what's left — the feature stays, only the badge for it is
 * conditional. */
export function ClipboardHistory({ visible }: { visible: boolean }) {
  const [open, setOpen] = useState(false);
  const [clips, setClips] = useState<ipc.Clip[]>([]);
  const [index, setIndex] = useState(0);
  const enabled = useSyncExternalStore(
    subscribeSettings,
    () => getSettings().clipboardHistory,
  );
  const [error, setError] = useState("");
  const [position, setPosition] = useState<{
    right: number;
    bottom: number;
  } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const target = useRef<Element | null>(null);
  const openRef = useRef(false);
  const cycling = useRef(false);
  const clipsRef = useRef<ipc.Clip[]>([]);
  const indexRef = useRef(0);

  const place = () => {
    const rect = anchor.current?.getBoundingClientRect();
    setPosition({
      right: rect ? Math.max(8, window.innerWidth - rect.right) : 8,
      bottom: rect ? window.innerHeight - rect.top + 6 : 38,
    });
  };

  const show = (asCycle: boolean) => {
    const next = clipboardStore.getSnapshot().slice(0, MAX_VISIBLE);
    clipsRef.current = next;
    indexRef.current = 0;
    cycling.current = asCycle && next.length > 0;
    openRef.current = true;
    setClips(next);
    setIndex(0);
    setError("");
    setOpen(true);
    place();
  };

  const close = () => {
    cycling.current = false;
    openRef.current = false;
    setOpen(false);
  };

  const commit = (clip: ipc.Clip) => {
    const insertionTarget = target.current;
    close();
    void ipc
      .clipboardRead(clip.id)
      .then(async (text) => {
        await navigator.clipboard.writeText(text).catch(() => {});
        insertTextAtCursor(text, insertionTarget);
      })
      .catch(() => {
        show(false);
        setError("That clip is no longer available.");
      });
  };

  const step = (delta: number) => {
    const count = clipsRef.current.length;
    if (!count) return;
    indexRef.current = (indexRef.current + delta + count) % count;
    setIndex(indexRef.current);
  };

  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      const next = clipboardStore.getSnapshot().slice(0, MAX_VISIBLE);
      clipsRef.current = next;
      indexRef.current = Math.min(
        indexRef.current,
        Math.max(0, next.length - 1),
      );
      setClips(next);
      setIndex(indexRef.current);
    };
    refresh();
    return clipboardStore.subscribe(refresh);
  }, [open]);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (matches(e, "clipboard-history")) {
        e.preventDefault();
        e.stopPropagation();
        if (!openRef.current) {
          target.current = document.activeElement;
          show(true);
        } else if (!e.repeat && clipsRef.current.length > 0) {
          cycling.current = true;
          step(1);
        }
        return;
      }
      if (!openRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "Enter" && clipsRef.current[indexRef.current]) {
        e.preventDefault();
        commit(clipsRef.current[indexRef.current]);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!cycling.current || modifiersHeld(e)) return;
      const clip = clipsRef.current[indexRef.current];
      if (clip) commit(clip);
      else close();
    };
    const onBlur = () => cycling.current && close();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible && openRef.current) close();
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!anchor.current?.contains(e.target as Node)) close();
    };
    const onResize = () => place();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const shortcut = format("clipboard-history");
  const menu = open && (
    <div
      className="status-menu clipboard-history-menu"
      style={
        position
          ? {
              position: "fixed",
              right: position.right,
              bottom: position.bottom,
            }
          : undefined
      }
    >
      <div className="clipboard-history-head">
        <span>Clipboard</span>
        <kbd>{shortcut}</kbd>
      </div>
      {!enabled ? (
        <div className="clipboard-history-empty">
          <span>History is off. Canopy is not reading your clipboard.</span>
          <button
            className="btn-mini"
            onClick={() => updateSettings({ clipboardHistory: true })}
          >
            Enable history
          </button>
        </div>
      ) : clips.length === 0 ? (
        <div className="clipboard-history-empty">
          Copy something to see it here.
        </div>
      ) : (
        <div
          className="clipboard-history-list"
          role="listbox"
          aria-label="Recent clipboard"
        >
          {clips.map((clip, i) => (
            <button
              key={clip.id}
              className={`clipboard-history-row${i === index ? " is-selected" : ""}`}
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => {
                indexRef.current = i;
                setIndex(i);
              }}
              onClick={() => commit(clip)}
            >
              <span className="clipboard-history-text">
                {clip.preview || `${clip.chars.toLocaleString()} characters`}
              </span>
              <span className="clipboard-history-age">{age(clip.ts)}</span>
            </button>
          ))}
        </div>
      )}
      {error && <div className="clipboard-history-error">{error}</div>}
      <div className="clipboard-history-hint">
        hold {shortcut} · tap V to cycle · release to paste
      </div>
    </div>
  );

  // Off means there is no tray icon at all — not a chip that opens onto "it's
  // off". The panel still has a home: the shortcut opens it in the corner the
  // icon would have occupied, and that is where history gets turned back on.
  if (!enabled) return menu || null;

  return (
    <span className="status-item status-clipboard-anchor" ref={anchor}>
      <button
        className={`status-clipboard-btn${open ? " is-open" : ""}`}
        title={`Clipboard history (${shortcut})`}
        aria-label={`Clipboard history (${shortcut})`}
        aria-expanded={open}
        onMouseDown={() => {
          if (!openRef.current) target.current = document.activeElement;
        }}
        onClick={() => (openRef.current ? close() : show(false))}
      >
        <ClipboardIcon size={13} />
      </button>
      {menu}
    </span>
  );
}
