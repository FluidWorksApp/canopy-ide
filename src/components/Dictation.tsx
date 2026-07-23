// Voice dictation: a configurable hotkey (⌘D on Mac, Alt+D elsewhere by
// default) toggles the mic; the transcription is typed at the cursor — active
// terminal, editor, or any focused field. Local ASR only (Parakeet /
// SenseVoice / Moonshine), no cloud, no formatting pass. This component owns
// the whole runtime surface: the hotkey, the state machine, and the floating
// status pill. Model, language, and hotkey are configured in Settings →
// Dictation. Mounted once in App.
import { useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import { formatHotkey, getSettings, matchesHotkey } from "../settings";

type Phase =
  | "idle"
  | "downloading"
  | "loading"
  | "recording"
  | "transcribing"
  | "notice";

/** Route the text to wherever the cursor is. Ordinary fields (chat input,
 *  commit message, Monaco's hidden textarea) take execCommand — it fires the
 *  input events React and Monaco already listen for. xterm's helper textarea
 *  ignores DOM insertion, so terminals — also the fallback when nothing
 *  focusable holds focus — get the text over the same event the active Term
 *  uses for file drops, which lands it in xterm's ordered paste path. */
function insertText(text: string) {
  const el = document.activeElement as HTMLElement | null;
  const isField =
    el &&
    !el.classList.contains("xterm-helper-textarea") &&
    (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
  if (isField) {
    document.execCommand("insertText", false, text);
  } else {
    window.dispatchEvent(new CustomEvent("canopy:dictation-text", { detail: text }));
  }
}

export function Dictation() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState("");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const noticeTimer = useRef<number | undefined>(undefined);
  // Dictation needs the bundled ONNX Runtime, which unsupported builds (Intel
  // macOS) lack. Default true so the hotkey works the instant the app mounts on
  // every supported platform; go quiet only once we confirm it's unavailable.
  const supportedRef = useRef(true);

  const notice = (msg: string) => {
    window.clearTimeout(noticeTimer.current);
    setPhase("notice");
    setDetail(msg);
    noticeTimer.current = window.setTimeout(() => {
      if (phaseRef.current === "notice") setPhase("idle");
    }, 5000);
  };

  const toggle = async () => {
    const p = phaseRef.current;
    if (p === "recording") {
      setPhase("transcribing");
      try {
        // Read the language hint fresh, so a Settings change applies to the
        // very next transcription without a reload.
        insertText(await ipc.dictationStop(getSettings().dictationLanguage));
        setPhase("idle");
      } catch (e) {
        notice(String(e));
      }
      return;
    }
    if (p !== "idle" && p !== "notice") return;
    // "loading" covers both the one-time model load and mic warm-up; the
    // backend answers only once the mic is actually capturing. Clear any stale
    // detail so a fast (already-resident) start shows the plain label, not a
    // leftover "loading model" line from a previous first-use start.
    setPhase("loading");
    setDetail("");
    try {
      // Empty model id = the backend's default (first registry entry).
      const r = await ipc.dictationStart(getSettings().dictationModel);
      if (r === "recording") setPhase("recording");
      else setPhase("downloading");
    } catch (e) {
      notice(String(e));
    }
  };

  useEffect(() => {
    // On an unsupported build the hotkey does nothing — don't even intercept it,
    // let ⌘D fall through as usual.
    void ipc
      .dictationSupported()
      .then((ok) => {
        supportedRef.current = ok;
      })
      .catch(() => {});
    // Capture phase: the hotkey must win over xterm/Monaco key handling, and
    // Esc-while-recording must not fall through to focus-mode exit. The hotkey
    // is read fresh from settings on every press so re-binding takes effect
    // immediately, no reload.
    const onKey = (e: KeyboardEvent) => {
      if (supportedRef.current && matchesHotkey(e, getSettings().dictationHotkey)) {
        e.preventDefault();
        e.stopPropagation();
        void toggle();
      } else if (e.key === "Escape" && phaseRef.current === "recording") {
        e.preventDefault();
        e.stopPropagation();
        void ipc.dictationCancel();
        setPhase("idle");
      }
    };
    window.addEventListener("keydown", onKey, true);
    const sub = ipc.onDictationProgress((p) => {
      if (p.phase === "download") {
        setPhase("downloading");
        setDetail(`${Math.floor(p.pct)}%`);
      } else if (p.phase === "extract") {
        setPhase("downloading");
        setDetail("unpacking…");
      } else if (p.phase === "load") {
        // First-use model load: reassure that a multi-second wait isn't a hang.
        setPhase("loading");
        setDetail("loading model — first use is slow…");
      } else if (p.phase === "ready") {
        notice(`Voice model ready — press ${formatHotkey(getSettings().dictationHotkey)} to dictate`);
      } else if (p.phase === "error") {
        notice(p.message ?? "Voice model download failed");
      }
    });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(noticeTimer.current);
      void sub.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "idle") return null;
  const keys = formatHotkey(getSettings().dictationHotkey);
  const label = {
    downloading: `Downloading voice model… ${detail || ""}`,
    loading: detail || "Starting dictation…",
    recording: `Listening — ${keys} inserts, Esc cancels`,
    transcribing: "Transcribing…",
    notice: detail,
  }[phase];
  return (
    <div className={`dictation-pill dictation-${phase}`} role="status">
      {phase === "recording" && <span className="dictation-dot" />}
      <span>{label}</span>
    </div>
  );
}
