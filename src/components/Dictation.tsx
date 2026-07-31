// Voice dictation: a configurable trigger opens the mic and the transcription
// is typed at the cursor — active terminal, editor, or any focused field. Local
// ASR only (Parakeet / SenseVoice / Moonshine), no cloud, no formatting pass.
// This component owns the whole runtime surface: the trigger, the state
// machine, and the floating status pill. Trigger, model, language, live
// preview and the pill's visualiser are configured in Settings → Dictation.
// Mounted once in App.
//
// The trigger itself lives in dictationTrigger.ts, because binding a bare
// modifier without breaking typing is fiddly enough to deserve its own tests.
import { useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import {
  formatHotkey,
  getSettings,
  matchesHotkey,
  modKeyLabel,
  type DictationWaveStyle,
} from "../settings";
import { DictationTrigger, describeTrigger } from "../dictationTrigger";
import { useEscapeLayer } from "../useEscape";
import { drawWave, normalizeLevel, smoothLevel } from "../waveStyles";
import {
  applyEdit,
  hasCollapsedCaret,
  liveInsertTarget,
  planFinalEdit,
  planLiveEdit,
} from "../dictationInsert";
import {
  HistoryCycle,
  loadHistory,
  pushTranscript,
  removeTranscript,
  timeAgo,
  type TranscriptEntry,
} from "../dictationHistory";

type Phase =
  "idle" | "downloading" | "loading" | "recording" | "transcribing" | "notice";

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
    (el.tagName === "TEXTAREA" ||
      el.tagName === "INPUT" ||
      el.isContentEditable);
  if (isField) {
    document.execCommand("insertText", false, text);
  } else {
    window.dispatchEvent(
      new CustomEvent("canopy:dictation-text", { detail: text }),
    );
  }
}

/** The animated visualiser. Its rAF loop runs only while the pill is mounted,
 *  which is only while the mic is open — an idle 60fps canvas is exactly the
 *  kind of always-on timer that makes an editor feel heavy for no reason. */
function WaveCanvas({
  style,
  target,
}: {
  style: DictationWaveStyle;
  /** Latest normalised level, read (not subscribed to) each frame so a 30Hz
   *  event stream never triggers a React render. */
  target: React.MutableRefObject<number>;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    let phase = 0;
    let level = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (
        canvas.width !== Math.round(w * dpr) ||
        canvas.height !== Math.round(h * dpr)
      ) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      phase += 0.08;
      level = smoothLevel(level, target.current);
      drawWave(style, { ctx, w, h, level, phase });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [style, target]);
  return <canvas ref={ref} className="dictation-wave" />;
}

/** The recent-dictation list, shown while the cycle hotkey is held. Read-only
 *  and pointer-free by design: the hand is on the keyboard, and a click target
 *  that appears for half a second is a click target nobody hits. */
function HistoryPicker({
  entries,
  index,
}: {
  entries: TranscriptEntry[];
  index: number;
}) {
  const now = Date.now();
  return (
    <div
      className="dictation-history"
      role="listbox"
      aria-label="Recent dictation"
    >
      {entries.map((e, i) => (
        <div
          key={e.id}
          className={`dictation-history-row${i === index ? " dictation-history-on" : ""}`}
          role="option"
          aria-selected={i === index}
        >
          <span className="dictation-history-text">{e.text}</span>
          <span className="dictation-history-age">{timeAgo(e.at, now)}</span>
        </div>
      ))}
      <div className="dictation-history-hint">
        tap to cycle · release to paste · backspace removes · Esc cancels
      </div>
    </div>
  );
}

export function Dictation() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState("");
  const [partial, setPartial] = useState<ipc.DictationPartial | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // Escape cancels the recording, and only the recording — nothing behind the
  // pill may take the same press as a dismissal.
  useEscapeLayer(phase === "recording");
  const noticeTimer = useRef<number | undefined>(undefined);
  const level = useRef(0);
  /** A release that arrived while the mic was still opening. Push-to-talk can
   *  easily be shorter than a cold model load, and without this the key-up
   *  would be dropped and the recording would run on with nothing to end it. */
  const pendingStop = useRef(false);
  /** The field the live preview is being typed into, and the exact text we
   *  have put there. Null target = no eligible field had focus (a terminal, a
   *  code editor, nothing at all), so the preview stays in the pill. */
  const liveField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const liveWritten = useRef("");
  // Dictation needs the bundled ONNX Runtime, which unsupported builds (Intel
  // macOS) lack. Default true so the trigger works the instant the app mounts on
  // every supported platform; go quiet only once we confirm it's unavailable.
  const supported = useRef(true);
  /** The recent-dictation picker, or null when it is closed. Held in state
   *  rather than a ref because it is what gets drawn. */
  const [picker, setPicker] = useState<{
    entries: TranscriptEntry[];
    index: number;
  } | null>(null);

  useEffect(() => {
    const notice = (msg: string) => {
      window.clearTimeout(noticeTimer.current);
      setPhase("notice");
      setDetail(msg);
      noticeTimer.current = window.setTimeout(() => {
        if (phaseRef.current === "notice") setPhase("idle");
      }, 5000);
    };

    void ipc
      .dictationSupported()
      .then((ok) => {
        supported.current = ok;
      })
      .catch(() => {});

    /** Undo everything the live preview typed, leaving the field as it was. */
    const rollbackLive = () => {
      const field = liveField.current;
      const written = liveWritten.current;
      liveField.current = null;
      liveWritten.current = "";
      if (!field || !written || !hasCollapsedCaret(field)) return;
      const edit = planFinalEdit(
        field.value,
        field.selectionStart ?? 0,
        written,
        "",
      );
      if (edit) applyEdit(field, edit);
    };

    const stop = async () => {
      if (phaseRef.current === "loading") {
        pendingStop.current = true;
        return;
      }
      if (phaseRef.current !== "recording") return;
      setPhase("transcribing");
      setDetail("");
      try {
        // Read the language hint fresh, so a Settings change applies to the
        // very next transcription without a reload.
        const text = await ipc.dictationStop(getSettings().dictationLanguage);
        const field = liveField.current;
        const written = liveWritten.current;
        liveField.current = null;
        liveWritten.current = "";
        // Swap the streamed guess for the authoritative decode in one edit, so
        // the field never shows the preview and the final text side by side.
        // If the field drifted under us, planFinalEdit declines and we fall
        // back to a plain insert rather than overwriting text we no longer own.
        const edit =
          field && document.activeElement === field && hasCollapsedCaret(field)
            ? planFinalEdit(
                field.value,
                field.selectionStart ?? 0,
                written,
                text,
              )
            : null;
        if (field && edit) applyEdit(field, edit);
        else insertText(text);
        // One press of the trigger is one entry, however long it ran and
        // however many passes the model needed to get through it.
        pushTranscript(text);
        setPhase("idle");
      } catch (e) {
        rollbackLive();
        notice(String(e));
      }
      setPartial(null);
    };

    const start = async () => {
      const p = phaseRef.current;
      if (p !== "idle" && p !== "notice") return;
      // "loading" covers both the one-time model load and mic warm-up; the
      // backend answers only once the mic is actually capturing.
      setPhase("loading");
      setDetail("");
      setPartial(null);
      pendingStop.current = false;
      level.current = 0;
      liveWritten.current = "";
      try {
        const s = getSettings();
        // Claim the focused field now, before the await: by the time the mic is
        // open the user may have clicked elsewhere, and the field they were in
        // when they pressed the key is the one they meant to dictate into.
        liveField.current = s.dictationStreaming
          ? liveInsertTarget(document.activeElement)
          : null;
        const r = await ipc.dictationStart(
          s.dictationModel,
          s.dictationStreaming,
          s.dictationLanguage,
          s.dictationMuteOutput,
        );
        if (r !== "recording") {
          setPhase("downloading");
          return;
        }
        setPhase("recording");
        phaseRef.current = "recording";
        if (pendingStop.current) {
          pendingStop.current = false;
          void stop();
        }
      } catch (e) {
        notice(String(e));
      }
    };

    const cancel = () => {
      pendingStop.current = false;
      void ipc.dictationCancel();
      rollbackLive();
      setPartial(null);
      setPhase("idle");
    };

    const t = new DictationTrigger(
      {
        mode: getSettings().dictationTriggerMode,
        key: getSettings().dictationModKey,
        hotkey: getSettings().dictationHotkey,
      },
      {
        start: () => void start(),
        stop: () => void stop(),
        cancel,
        // The trigger keeps no copy of this — "opening" counts as recording so
        // a second press during a cold start cannot open a second mic.
        isRecording: () =>
          phaseRef.current === "recording" || phaseRef.current === "loading",
      },
    );

    const history = new HistoryCycle(
      {
        show: (entries, index) => setPicker({ entries, index }),
        commit: (entry) => {
          setPicker(null);
          insertText(entry.text);
        },
        dismiss: () => setPicker(null),
      },
      getSettings().dictationHistoryHotkey,
      loadHistory,
      removeTranscript,
    );

    // Capture phase: the trigger must win over xterm/Monaco key handling, and
    // Esc-while-recording must not fall through to focus-mode exit. Settings
    // are re-read on every press so a rebind takes effect immediately.
    const onKey = (e: KeyboardEvent) => {
      if (!supported.current) return;
      const s = getSettings();
      history.setHotkey(s.dictationHistoryHotkey);
      // The picker owns the keyboard while it is open, and its hotkey has to
      // beat the browser's own paste as well as the terminal's.
      if (history.keydown(e, matchesHotkey)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      t.configure({
        mode: s.dictationTriggerMode,
        key: s.dictationModKey,
        hotkey: s.dictationHotkey,
      });
      if (e.key === "Escape" && phaseRef.current === "recording") {
        e.preventDefault();
        e.stopPropagation();
        t.reset();
        cancel();
        return;
      }
      // Only a chord is ever swallowed. Swallowing a bare modifier's keydown
      // would stop it doing its actual job, which is a far worse bug than a
      // missed trigger.
      if (t.handleKeyDown(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!supported.current) return;
      // Letting go of the modifiers is what pastes — checked here rather than
      // on a timer so it lands the instant the hand lifts.
      history.keyup(e);
      t.handleKeyUp(e);
    };
    const onBlur = () => {
      history.blur();
      t.handleBlur();
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);

    const progress = ipc.onDictationProgress((p) => {
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
      } else if (p.phase === "transcribe") {
        // Only long recordings report here — they are split into chunks, and
        // minutes of CPU inference behind a still pill reads as a hang. Ignore
        // a late event that outlived the call that produced it.
        if (phaseRef.current === "transcribing")
          setDetail(`${Math.floor(p.pct)}%`);
      } else if (p.phase === "ready") {
        const s = getSettings();
        notice(
          `Voice model ready — ${describeTrigger(
            s.dictationTriggerMode,
            modKeyLabel(s.dictationModKey),
            formatHotkey(s.dictationHotkey),
          )} to dictate`,
        );
      } else if (p.phase === "error") {
        notice(p.message ?? "Voice model download failed");
      }
    });
    const levels = ipc.onDictationLevel((rms) => {
      level.current = normalizeLevel(rms);
    });
    const partials = ipc.onDictationPartial((p) => {
      const field = liveField.current;
      if (!field) {
        setPartial(p);
        return;
      }
      // Type it where it is going. The unconfirmed tail is included: holding it
      // back until it settles makes the text lag a word or two behind the
      // voice, and the next pass rewrites it in place anyway.
      const next = [p.confirmed, p.unconfirmed].filter(Boolean).join(" ");
      if (document.activeElement !== field || !hasCollapsedCaret(field)) {
        // Focus or caret moved — stop writing and keep what is already there.
        // Whatever we have written stays owned by us, so the final swap can
        // still replace it if the user comes back to the same spot.
        return;
      }
      const edit = planLiveEdit(
        field.value,
        field.selectionStart ?? 0,
        liveWritten.current,
        next,
      );
      if (edit && applyEdit(field, edit)) liveWritten.current = next;
    });

    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      window.clearTimeout(noticeTimer.current);
      void progress.then((fn) => fn());
      void levels.then((fn) => fn());
      void partials.then((fn) => fn());
    };
  }, []);

  const s = getSettings();
  const how = describeTrigger(
    s.dictationTriggerMode,
    modKeyLabel(s.dictationModKey),
    formatHotkey(s.dictationHotkey),
  );
  const live = partial && (partial.confirmed || partial.unconfirmed);
  const status: Record<Phase, string> = {
    downloading: `Downloading voice model… ${detail || ""}`,
    loading: detail || "Starting dictation…",
    transcribing: detail ? `Transcribing… ${detail}` : "Transcribing…",
    notice: detail,
    recording: "",
    idle: "",
  };

  return (
    <>
      {picker && (
        <HistoryPicker entries={picker.entries} index={picker.index} />
      )}
      {phase !== "idle" && (
        <div
          className={`dictation-pill dictation-${phase}${live ? " dictation-expanded" : ""}`}
          role="status"
        >
          {phase === "recording" ? (
            <>
              <span className="dictation-row">
                <WaveCanvas style={s.dictationWaveStyle} target={level} />
                <span className="dictation-hint">
                  {s.dictationTriggerMode === "hold" ? "release" : how} inserts
                  · Esc cancels
                </span>
              </span>
              {live && (
                <span className="dictation-live">
                  <span className="dictation-live-text">
                    {partial.confirmed}
                    {partial.unconfirmed && (
                      <span className="dictation-live-tentative">
                        {partial.confirmed ? " " : ""}
                        {partial.unconfirmed}
                      </span>
                    )}
                  </span>
                </span>
              )}
            </>
          ) : (
            <span>{status[phase]}</span>
          )}
        </div>
      )}
    </>
  );
}
