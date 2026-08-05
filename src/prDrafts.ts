/** Durable, private review composition state. Nothing here has been posted. */
export interface StoredDraftComment {
  id: string;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  blocking: boolean;
  fromAgent?: boolean;
  /** Stable identity from the generated artifact, even after the human edits it. */
  sourceKey?: string;
}

export interface StoredPrDraft {
  body: string;
  comments: StoredDraftComment[];
}

const KEY = "canopy.prDraftReviews";
const MAX_PRS = 60;
const MAX_COMMENTS = 200;

interface Entry extends StoredPrDraft {
  at: number;
  ignored: string[];
}

type Store = Record<string, Entry>;

const keyFor = (repo: string, number: number): string => `${repo}#${number}`;

function read(): Store {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return value && typeof value === "object" ? (value as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  const keys = Object.keys(store);
  if (keys.length > MAX_PRS) {
    keys
      .sort((a, b) => (store[a].at ?? 0) - (store[b].at ?? 0))
      .slice(0, keys.length - MAX_PRS)
      .forEach((key) => delete store[key]);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Losing a local draft is preferable to making the PR tab unusable at quota.
  }
}

export function loadPrDraft(repo: string, number: number): StoredPrDraft {
  const entry = read()[keyFor(repo, number)];
  return {
    body: typeof entry?.body === "string" ? entry.body : "",
    comments: Array.isArray(entry?.comments) ? entry.comments : [],
  };
}

export function savePrDraft(
  repo: string,
  number: number,
  draft: StoredPrDraft,
): void {
  const store = read();
  const key = keyFor(repo, number);
  const ignored = store[key]?.ignored ?? [];
  if (!draft.body.trim() && draft.comments.length === 0 && ignored.length === 0) {
    delete store[key];
  } else {
    store[key] = {
      at: Date.now(),
      body: draft.body,
      comments: draft.comments.slice(-MAX_COMMENTS),
      ignored,
    };
  }
  write(store);
}

/** Agent findings the human dropped are decisions, not drafts to resurrect. */
export function ignorePrFindings(
  repo: string,
  number: number,
  findingKeys: readonly string[],
): void {
  if (!findingKeys.length) return;
  const store = read();
  const key = keyFor(repo, number);
  const previous = store[key];
  store[key] = {
    at: Date.now(),
    body: previous?.body ?? "",
    comments: previous?.comments ?? [],
    ignored: [...new Set([...(previous?.ignored ?? []), ...findingKeys])].slice(
      -MAX_COMMENTS,
    ),
  };
  write(store);
}

export function ignoredPrFindings(repo: string, number: number): Set<string> {
  return new Set(read()[keyFor(repo, number)]?.ignored ?? []);
}
