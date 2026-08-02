// The tab switcher — the panel Ctrl+Tab holds open, with a live picture of
// every tab on it.
//
// Ctrl+Tab used to switch on each press, which meant cycling past six tabs was
// six mounts, six focus changes and six repaints to land on the one you wanted.
// This is the switcher every OS trains instead: hold the modifier, the panel
// comes up with every tab on it, Tab walks the selection, and letting go is
// what commits. Nothing switches until you release, so walking the strip costs
// one tab change however far you walked.
//
// The thumbnails are live rather than snapshots (see tabPreview.ts): a terminal
// card is the pty's buffer tail re-read every tick, so an agent working while
// you hold the key is visibly working in the panel. Doc panes are re-cloned on
// the same tick. The tick rate answers to what the last pass cost — the point
// is a stream, and a stream that stutters the keypress feeding it is worse than
// a slower one.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  AgentIcon,
  AgentsIcon,
  ClaimIcon,
  CommitIcon,
  DocumentIcon,
  GitBranchIcon,
  GlobeIcon,
  IssueIcon,
  LiveShareIcon,
  NoteIcon,
  PlugIcon,
  PullRequestIcon,
  ResearchIcon,
  TeamIcon,
  TerminalIcon,
  TrackerIcon,
} from "./icons";
import type { SubTab } from "./ProjectView";
import { tabDisplayLabel } from "./ProjectView";
import {
  clonePane,
  nextTickMs,
  tailLines,
  PREVIEW_TICK_MS,
} from "../tabPreview";
import { tabKind, tabToneColor } from "../tabKind";

/** The card's picture box, in CSS pixels — kept here rather than read back from
 *  the DOM because the scale factor has to be known before the first paint, and
 *  a thumbnail that resizes on its second frame reads as a glitch. Matches
 *  `.tsw-shot` in index.css. */
const SHOT_W = 236;
const SHOT_H = 148;

/** Rows of terminal tail a card shows. More than fits is harmless — the box
 *  clips from the bottom, which is where the prompt is, so the tail is what
 *  survives. */
const TERM_ROWS = 26;

function tabIcon(tab: SubTab, size = 12) {
  switch (tab.type) {
    case "terminal": {
      // A session's mark is its CLI's own, drawn in its own brand colour — the
      // thing that tells six agent cards apart before you have read a word of
      // any of them. A shell with no CLI keeps the terminal glyph.
      const cli = tabKind(tab).agent;
      return cli ? <AgentIcon id={cli} size={size} /> : <TerminalIcon size={size} />;
    }
    case "pr":
    case "review":
      return <PullRequestIcon size={size} />;
    case "ticket":
      return <TrackerIcon id={tab.source} size={size} />;
    case "commit":
      return <CommitIcon size={size} />;
    case "branch":
      return <GitBranchIcon size={size} />;
    case "agent":
      return <AgentIcon id={tab.agent} size={size} />;
    case "agents":
      return <AgentsIcon size={size} />;
    case "chat":
    case "collab":
      return <TeamIcon size={size} />;
    case "shared-project":
      return <LiveShareIcon size={size} />;
    case "preview":
      return <GlobeIcon size={size} />;
    case "mcp":
      return <PlugIcon size={size} />;
    case "claim":
      return <ClaimIcon size={size} />;
    case "note":
      return <NoteIcon size={size} />;
    case "research":
      return <ResearchIcon size={size} />;
    case "task-history":
      return <IssueIcon size={size} />;
    default:
      return <DocumentIcon size={size} />;
  }
}

interface ShotProps {
  tab: SubTab;
  /** Drawn large and faint when there is no picture to take. */
  icon: ReactNode;
  /** The pane area every tab is mounted in — where a host is found, and the
   *  size the clone is laid out at. */
  paneRef: RefObject<HTMLDivElement | null>;
  /** The terminal tail for a terminal tab, live off its xterm buffer. */
  termText: (id: string) => string | null;
  /** Bumped by the parent's adaptive clock; every bump is a re-read. */
  tick: number;
}

/** One tab's picture. Terminals render as text; everything else renders as a
 *  scaled clone of its live pane; a tab with neither (a native webview, a pane
 *  too big to clone) falls back to its icon, which the card header carries
 *  anyway — so the box simply stays empty rather than showing a broken frame. */
function Shot({ tab, icon, paneRef, termText, tick }: ShotProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<string[] | null>(null);
  const [scale, setScale] = useState(0);
  const [pane, setPane] = useState<{ w: number; h: number } | null>(null);
  const [blank, setBlank] = useState(false);

  // Measured before paint: the clone needs the pane's real size to lay out at,
  // and the scale that turns it into a thumbnail.
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    setPane({ w: r.width, h: r.height });
    setScale(SHOT_W / r.width);
  }, [paneRef]);

  useEffect(() => {
    if (tab.type === "terminal") {
      setLines(tailLines(termText(tab.id) ?? "", TERM_ROWS));
      return;
    }
    const box = boxRef.current;
    if (!box) return;
    const host =
      paneRef.current?.querySelector<HTMLElement>(
        `[data-tab-id="${CSS.escape(tab.id)}"]`,
      ) ?? null;
    const clone = clonePane(host);
    if (clone) box.replaceChildren(clone);
    else box.replaceChildren();
    setBlank(!clone);
  }, [tab, tick, paneRef, termText]);

  if (tab.type === "terminal") {
    return (
      <pre className="tsw-term" aria-hidden>
        {lines?.join("\n") ?? ""}
      </pre>
    );
  }
  return (
    <>
      <div
        className="tsw-scale"
        ref={boxRef}
        aria-hidden
        style={
          pane
            ? {
                width: pane.w,
                height: pane.h,
                transform: `scale(${scale})`,
              }
            : undefined
        }
      />
      {/* A pane whose page this document can't see — a native webview's, or one
          too large to clone. Its kind is the most the card can honestly say. */}
      {blank && (
        <div className="tsw-blank" aria-hidden>
          {icon}
        </div>
      )}
    </>
  );
}

export interface TabSwitcherProps {
  /** In the order the switcher walks them — the same order Ctrl+Tab cycles. */
  tabs: SubTab[];
  /** The card the release would land on. */
  selectedId: string;
  /** Number the cards 1…9. The ⌘-held layer's cards are reached by their digit,
   *  so the digit is the label; Ctrl+Tab's are reached by walking, so they
   *  aren't numbered. */
  digits?: boolean;
  paneRef: RefObject<HTMLDivElement | null>;
  termText: (id: string) => string | null;
  /** Clicking a card is the mouse's version of releasing on it. */
  onPick: (id: string) => void;
}

export function TabSwitcher({
  tabs,
  selectedId,
  digits,
  paneRef,
  termText,
  onPick,
}: TabSwitcherProps) {
  const [tick, setTick] = useState(0);
  const everyRef = useRef(PREVIEW_TICK_MS);

  // The clock. Each pass measures itself across the frame it caused — the work
  // is the re-clone plus the layout and paint of every card — and the next
  // delay is chosen from that, so a machine with fifteen heavy tabs open slows
  // the stream down instead of dropping the keypresses driving it.
  useEffect(() => {
    const started = performance.now();
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      everyRef.current = nextTickMs(performance.now() - started, everyRef.current);
      timer = window.setTimeout(() => setTick((t) => t + 1), everyRef.current);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [tick]);

  // Follow the selection when the strip is wider than the panel.
  const selRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);

  const at = Math.max(0, tabs.findIndex((t) => t.id === selectedId));
  const selected = tabs[at];

  return (
    <div className="tsw-layer" role="presentation">
      <div className="tsw-frame">
        {/* Chrome, because a bare row of thumbnails says nothing about itself:
            what you are looking at, which one you are on, and how far the
            strip runs. The title is the selected tab's, in full — the cards
            ellipsize at 236px and the one you are about to land on is the one
            worth spelling out. */}
        <div className="tsw-bar">
          <span className="tsw-bar-title" title={selected ? tabDisplayLabel(selected) : ""}>
            {selected ? tabDisplayLabel(selected) : "No tabs"}
          </span>
          <span className="tsw-bar-count">
            <span className="tsw-bar-at">{tabs.length ? at + 1 : 0}</span>
            <span className="tsw-bar-of"> / {tabs.length}</span>
          </span>
        </div>
      <div className="tsw-panel" role="listbox" aria-label="Open tabs">
        {tabs.map((tab, i) => {
          const kind = tabKind(tab);
          const brand = tabToneColor(kind);
          return (
          <div
            key={tab.id}
            ref={tab.id === selectedId ? selRef : undefined}
            className={`tsw-card tsw-tone-${kind.tone} ${tab.id === selectedId ? "tsw-card-sel" : ""}`}
            // The CLI's own colour where there is one; the class's tone
            // otherwise. Inline because the value is data, not a skin token —
            // see tabToneColor.
            style={brand ? ({ "--tsw-tone": brand } as React.CSSProperties) : undefined}
            role="option"
            aria-selected={tab.id === selectedId}
            onClick={() => onPick(tab.id)}
          >
            <div className="tsw-head">
              <span className="tsw-icon">{tabIcon(tab)}</span>
              <span className="tsw-title">{tabDisplayLabel(tab)}</span>
              {digits && i < 9 && <span className="tsw-digit">{i + 1}</span>}
            </div>
            {/* What the title cannot say on its own: a card reading "canopy"
                is a terminal, a project and a repo, and six Claude sessions
                are six identical words. The kind carries the colour. */}
            <div className="tsw-kind">
              <span className="tsw-kind-label">{kind.label}</span>
              {kind.detail && (
                <>
                  <span className="tsw-kind-sep" aria-hidden>
                    ·
                  </span>
                  <span className="tsw-kind-detail">{kind.detail}</span>
                </>
              )}
            </div>
            <div className="tsw-shot" style={{ width: SHOT_W, height: SHOT_H }}>
              <Shot
                tab={tab}
                icon={tabIcon(tab, 34)}
                paneRef={paneRef}
                termText={termText}
                tick={tick}
              />
            </div>
          </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}
