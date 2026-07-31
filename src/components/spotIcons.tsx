// The mark SpotSearch draws for a row, keyed by the `kind` its source
// declared. A registry rather than a switch so a registered source can bring
// its own icon (registerSpotIcon) without editing the palette — the same rule
// the source list follows.
//
// Every row gets a mark, falling back to the row's literal glyph and then to a
// dot: a column some rows opt out of makes the titles look randomly indented.
import type { ReactNode } from "react";
import type { SpotRow } from "../spotSources";
import {
  AgentIcon,
  AgentsIcon,
  CommitIcon,
  DiffIcon,
  DocumentIcon,
  ExchangeIcon,
  GitBranchIcon,
  GlobeIcon,
  IssueIcon,
  NoteIcon,
  PlayIcon,
  PullRequestIcon,
  ResearchIcon,
  SearchIcon,
  ServersIcon,
  SymbolIcon,
  TasksIcon,
  TeamIcon,
  TerminalIcon,
  TrackerIcon,
} from "./icons";

/** kind → mark. Sized by the caller's font, coloured by currentColor. */
export const SPOT_ICONS: Record<string, () => ReactNode> = {
  "run-task": () => <PlayIcon />,
  shell: () => <TerminalIcon />,
  terminal: () => <TerminalIcon />,
  preview: () => <GlobeIcon />,
  file: () => <DocumentIcon />,
  instructions: () => <DocumentIcon />,
  match: () => <SearchIcon />,
  symbol: () => <SymbolIcon />,
  server: () => <ServersIcon size={14} />,
  pr: () => <PullRequestIcon />,
  commit: () => <CommitIcon />,
  branch: () => <GitBranchIcon size={14} />,
  review: () => <DiffIcon size={14} />,
  ticket: () => <IssueIcon size={14} />,
  research: () => <ResearchIcon size={14} />,
  note: () => <NoteIcon size={14} />,
  chat: () => <ExchangeIcon />,
  task: () => <TasksIcon size={14} />,
  "task-history": () => <TasksIcon size={14} />,
  collab: () => <TeamIcon />,
  "shared-project": () => <TeamIcon />,
  agent: () => <AgentsIcon size={14} />,
};

/** Parametric kinds — `cli:claude`, `agent:codex`, `tracker:linear` — resolved
 *  by prefix so a new CLI or tracker needs no entry here. */
const PREFIXED: [string, (id: string) => ReactNode][] = [
  ["cli:", (id) => <AgentIcon id={id} />],
  ["agent:", (id) => <AgentIcon id={id} />],
  ["tracker:", (id) => <TrackerIcon id={id} />],
];

/** Give a kind a mark. Returns the undo, same as registerSpotSource. */
export function registerSpotIcon(kind: string, render: () => ReactNode): () => void {
  const prev = SPOT_ICONS[kind];
  SPOT_ICONS[kind] = render;
  return () => {
    if (prev) SPOT_ICONS[kind] = prev;
    else delete SPOT_ICONS[kind];
  };
}

export function SpotRowIcon({ row }: { row: SpotRow }) {
  const kind = row.kind ?? "";
  const exact = SPOT_ICONS[kind];
  if (exact) return <>{exact()}</>;
  for (const [prefix, render] of PREFIXED) {
    if (kind.startsWith(prefix)) return <>{render(kind.slice(prefix.length))}</>;
  }
  return row.icon ? (
    <span className="spot-glyph">{row.icon}</span>
  ) : (
    <span className="spot-dot" />
  );
}
