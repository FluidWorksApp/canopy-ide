// The control that puts a time on a note.
//
// It is a chip that opens a small menu, not a form in the page, because
// setting a reminder is a two-second decision and a form would make it look
// like a field you have to fill in. The menu leads with the four presets — the
// answers people actually mean — and keeps the picker underneath for the one
// case they don't cover.
//
// The line at the bottom of the menu is load-bearing rather than decoration.
// A reminder handed to launchd arrives with Canopy closed; one that fell back
// to the in-app timer does not, and a user who was never told the difference
// would find out the first time it mattered. So the menu says which it will
// be, and the chip says which it was.
import { useEffect, useRef, useState } from "react";
import type { NoteReminder as Reminder } from "../ipc";
import {
  describe,
  describeFull,
  earliest,
  fromLocalInput,
  nowSecs,
  presetsFor,
  toLocalInput,
} from "../reminders";
import { useEscape } from "../useEscape";
import { BellIcon, CloseIcon } from "./icons";
import { Button } from "./ui";

interface NoteReminderProps {
  reminder?: Reminder | null;
  /** `null` clears it. Rejections are the caller's to report. */
  onSet: (at: number | null, note?: string) => void;
  /** Whether the OS can be handed the job at all. False on Windows and Linux,
   *  where the in-app timer is the only alarm — which the menu says outright
   *  rather than letting someone find out by missing one. */
  systemCapable?: boolean;
}

export function NoteReminder({
  reminder,
  onSet,
  systemCapable = true,
}: NoteReminderProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const wrap = useRef<HTMLSpanElement>(null);
  // A minute's granularity: the chip has to stop saying "in 2 minutes" while
  // you look at it, and re-render itself the moment a reminder goes overdue.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!reminder) return;
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [reminder]);

  useEscape(() => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // Not `click`: a mousedown that starts inside the menu and ends outside
    // (dragging across the time input) would otherwise close it mid-gesture.
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (open) {
      setCustom(toLocalInput(reminder?.at ?? nowSecs() + 3600));
      setNote(reminder?.note ?? "");
    }
  }, [open, reminder]);

  const now = nowSecs();
  const overdue = reminder != null && reminder.at <= now;

  const set = (at: number | null) => {
    setOpen(false);
    onSet(at, note.trim() || undefined);
  };

  const commitCustom = () => {
    const at = fromLocalInput(custom);
    if (at == null || at <= now) return;
    set(at);
  };

  return (
    <span className="note-remind" ref={wrap}>
      <button
        type="button"
        className={`note-chip note-remind-chip${reminder ? " on" : ""}${
          overdue ? " overdue" : ""
        }`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          reminder
            ? `${describeFull(reminder.at, now)}${
                reminder.by && reminder.by !== "you" ? ` · set by ${reminder.by}` : ""
              }${
                reminder.system
                  ? ""
                  : " · Canopy has to be running for this one to arrive"
              }`
            : "Be reminded about this note at a time you choose"
        }
      >
        <BellIcon size={12} />
        {reminder ? describe(reminder.at, now) : "Remind me"}
      </button>
      {open && (
        <div className="note-remind-menu" role="menu">
          {presetsFor(now).map((p) => (
            <button
              key={p.id}
              type="button"
              className="note-remind-item"
              role="menuitem"
              onClick={() => set(p.at(now))}
            >
              <span>{p.label}</span>
              <span className="note-remind-when">{describe(p.at(now), now)}</span>
            </button>
          ))}
          <div className="note-remind-custom">
            <input
              type="datetime-local"
              value={custom}
              min={earliest(now)}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitCustom();
                }
              }}
            />
            <Button size="sm" onClick={commitCustom}>
              Set
            </Button>
          </div>
          <input
            className="note-remind-note"
            placeholder="What to say when it arrives (optional)"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitCustom();
              }
            }}
          />
          <p className="note-remind-foot">
            {systemCapable
              ? "Handed to macOS — it arrives even with Canopy closed, and opens this note."
              : "Canopy has to be running on this platform for a reminder to arrive."}
          </p>
          {reminder && (
            <button
              type="button"
              className="note-remind-item note-remind-clear"
              role="menuitem"
              onClick={() => set(null)}
            >
              <CloseIcon size={11} />
              <span>Remove reminder</span>
            </button>
          )}
        </div>
      )}
    </span>
  );
}
