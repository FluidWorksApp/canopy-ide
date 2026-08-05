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
import type { SubTab } from "./ProjectView/helpers";
import { clonePane, tailLines } from "../tabPreview";
import { tabKind } from "../tabKind";

export const TAB_PREVIEW_W = 236;
export const TAB_PREVIEW_H = 148;
const TERM_ROWS = 26;

export function tabPreviewIcon(tab: SubTab, size = 12) {
  switch (tab.type) {
    case "terminal": {
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

interface TabPreviewShotProps {
  tab: SubTab;
  icon: ReactNode;
  paneRef: RefObject<HTMLDivElement | null>;
  termText: (id: string) => string | null;
  tick: number;
  width?: number;
  height?: number;
}

/** A cheap live picture shared by the keyboard switcher and tab hover preview. */
export function TabPreviewShot({
  tab,
  icon,
  paneRef,
  termText,
  tick,
  width = TAB_PREVIEW_W,
  height = TAB_PREVIEW_H,
}: TabPreviewShotProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<string[] | null>(null);
  const [scale, setScale] = useState(0);
  const [pane, setPane] = useState<{ w: number; h: number } | null>(null);
  const [blank, setBlank] = useState(false);

  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    setPane({ w: r.width, h: r.height });
    setScale(width / r.width);
  }, [paneRef, width]);

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
                height: Math.max(pane.h, height / Math.max(scale, 0.01)),
                transform: `scale(${scale})`,
              }
            : undefined
        }
      />
      {blank && (
        <div className="tsw-blank" aria-hidden>
          {icon}
        </div>
      )}
    </>
  );
}
