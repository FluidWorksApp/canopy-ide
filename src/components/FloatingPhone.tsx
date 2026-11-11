// A small live view of the connected phone that floats over the IDE, so the
// screen stays in sight while an agent drives it. Drag the bar to move it (it
// snaps to the nearest corner), the arrows enlarge it, tapping the screen taps
// the phone. "Agent driving" shows for a few seconds after an agent acts.
import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import { listen } from "../host";
import { Button } from "./ui";
import { nearestCorner, type Corner } from "../devices/corner";

const FRAME_GAP_MS = 250;
const MARGIN = 14;
const SIZES = [150, 260] as const;
const POS_KEY = "canopy.floatingPhone.corner";
const DRIVING_MS = 4000;

const readCorner = (): Corner => {
  try {
    const v = localStorage.getItem(POS_KEY);
    if (v === "tl" || v === "tr" || v === "bl" || v === "br") return v;
  } catch {
    /* storage may be unavailable */
  }
  return "br";
};

interface Props {
  serial: string;
  projectDir: string;
  /** Model shown in the bar. */
  label?: string;
  onClose: () => void;
}

export default function FloatingPhone({
  serial,
  projectDir,
  label,
  onClose,
}: Props) {
  const [frame, setFrame] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [big, setBig] = useState(false);
  const [corner, setCorner] = useState<Corner>(readCorner);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [driving, setDriving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frameUrl = useRef<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const grab = useRef<{ dx: number; dy: number } | null>(null);

  // Frames, pulled one at a time so a slow phone throttles itself.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      try {
        const bytes = await ipc.androidScreencap(serial, projectDir);
        if (stopped) return;
        const url = URL.createObjectURL(
          new Blob([bytes], { type: "image/png" }),
        );
        const prev = frameUrl.current;
        frameUrl.current = url;
        setFrame(url);
        if (prev) URL.revokeObjectURL(prev);
        setError(null);
      } catch (e) {
        if (!stopped) setError(String(e));
      }
      if (!stopped) timer = setTimeout(() => void tick(), FRAME_GAP_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
    };
  }, [serial, projectDir]);

  // "Agent driving": an agent tapped, typed, pressed a key, swiped or ran an app.
  useEffect(() => {
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gone = false;
    void listen<{ serial?: string | null }>("device:agent-op", (e) => {
      const s = e.payload?.serial;
      if (s && s !== serial) return;
      setDriving(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setDriving(false), DRIVING_MS);
    }).then((u) => {
      if (gone) void u();
      else off = () => void u();
    });
    return () => {
      gone = true;
      off?.();
      if (timer) clearTimeout(timer);
    };
  }, [serial]);

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    grab.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    setDrag({ x: box.left, y: box.top });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!grab.current) return;
    setDrag({ x: e.clientX - grab.current.dx, y: e.clientY - grab.current.dy });
  };
  const onUp = (e: React.PointerEvent) => {
    if (!grab.current) return;
    grab.current = null;
    const box = boxRef.current?.getBoundingClientRect();
    const next = box
      ? nearestCorner(
          box.left + box.width / 2,
          box.top + box.height / 2,
          window.innerWidth,
          window.innerHeight,
        )
      : corner;
    setCorner(next);
    setDrag(null);
    try {
      localStorage.setItem(POS_KEY, next);
    } catch {
      /* ignore */
    }
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const tap = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      if (!size) return;
      const r = e.currentTarget.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const x = Math.round(((e.clientX - r.left) / r.width) * size.w);
      const y = Math.round(((e.clientY - r.top) / r.height) * size.h);
      void ipc
        .androidTap(serial, x, y, projectDir)
        .catch((err) => setError(String(err)));
    },
    [size, serial, projectDir],
  );

  const place: React.CSSProperties = drag
    ? { left: drag.x, top: drag.y }
    : {
        [corner.startsWith("t") ? "top" : "bottom"]:
          MARGIN + (corner.startsWith("t") ? 40 : 28),
        [corner.endsWith("l") ? "left" : "right"]: MARGIN,
      };

  return (
    <div
      ref={boxRef}
      className="floating-phone"
      style={{ width: SIZES[big ? 1 : 0], ...place }}
      role="group"
      aria-label="Phone preview"
    >
      <div
        className="floating-phone-bar"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <span className="floating-phone-dot" aria-hidden />
        <span className="floating-phone-name" title={serial}>
          {label || serial}
        </span>
        <Button
          icon
          title={big ? "Smaller" : "Bigger"}
          onClick={() => setBig((b) => !b)}
        >
          {big ? "⤡" : "⤢"}
        </Button>
        <Button icon title="Close" onClick={onClose}>
          ✕
        </Button>
      </div>
      {frame ? (
        <img
          ref={imgRef}
          className="floating-phone-screen"
          src={frame}
          alt={`Screen of ${serial}`}
          draggable={false}
          onClick={tap}
          onLoad={(e) =>
            setSize({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
        />
      ) : (
        <p className="floating-phone-wait">Waiting for the screen…</p>
      )}
      <div className="floating-phone-foot">
        {error ? (
          <span className="floating-phone-error" title={error}>
            No signal from the phone
          </span>
        ) : driving ? (
          <span className="floating-phone-pill">Agent driving</span>
        ) : (
          <span>Tap to use</span>
        )}
      </div>
    </div>
  );
}
