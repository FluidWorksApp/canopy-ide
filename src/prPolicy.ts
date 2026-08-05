export interface PathInstruction {
  path: string;
  instructions: string;
}

export interface ReviewCheck {
  name: string;
  instructions: string;
  severity: "warning" | "error";
}

/** Local review policy for one repository. It steers private agent output; it
 * never grants an agent permission to post, push, approve, or merge. */
export interface ReviewPolicy {
  autoReview: boolean;
  reviewDrafts: boolean;
  diagrams: boolean;
  excludedPaths: string[];
  pathInstructions: PathInstruction[];
  checks: ReviewCheck[];
  learnings: string[];
  relatedRepositories: string[];
}

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  autoReview: false,
  reviewDrafts: false,
  diagrams: true,
  excludedPaths: [],
  pathInstructions: [],
  checks: [],
  learnings: [],
  relatedRepositories: [],
};

const POLICY_KEY = "canopy.prReviewPolicies";
const AUTO_HEAD_KEY = "canopy.prAutoReviewHeads";
const MAX_REPOS = 60;
const MAX_AUTO_HEADS = 200;

type PolicyStore = Record<string, { at: number; policy: ReviewPolicy }>;
type HeadStore = Record<string, { at: number; head: string }>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Review policy must be a JSON object.");
  return value as Record<string, unknown>;
}

function strings(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
    throw new Error(`"${field}" must be an array of strings.`);
  return value.map((x) => x.trim()).filter(Boolean);
}

function boolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw new Error(`"${field}" must be true or false.`);
  return value;
}

export function parseReviewPolicy(raw: string): ReviewPolicy {
  const value = object(JSON.parse(raw));
  const paths = value.pathInstructions ?? [];
  if (!Array.isArray(paths))
    throw new Error('"pathInstructions" must be an array.');
  const pathInstructions = paths.map((item, index) => {
    const row = object(item);
    if (typeof row.path !== "string" || typeof row.instructions !== "string")
      throw new Error(
        `"pathInstructions[${index}]" needs string path and instructions fields.`,
      );
    return { path: row.path.trim(), instructions: row.instructions.trim() };
  }).filter((x) => x.path && x.instructions);

  const rawChecks = value.checks ?? [];
  if (!Array.isArray(rawChecks)) throw new Error('"checks" must be an array.');
  const checks = rawChecks.map((item, index) => {
    const row = object(item);
    if (typeof row.name !== "string" || typeof row.instructions !== "string")
      throw new Error(
        `"checks[${index}]" needs string name and instructions fields.`,
      );
    const severity = row.severity ?? "warning";
    if (severity !== "warning" && severity !== "error")
      throw new Error(`"checks[${index}].severity" must be "warning" or "error".`);
    return {
      name: row.name.trim(),
      instructions: row.instructions.trim(),
      severity,
    } as ReviewCheck;
  }).filter((x) => x.name && x.instructions);

  return {
    autoReview: boolean(value.autoReview, false, "autoReview"),
    reviewDrafts: boolean(value.reviewDrafts, false, "reviewDrafts"),
    diagrams: boolean(value.diagrams, true, "diagrams"),
    excludedPaths: strings(value.excludedPaths, "excludedPaths"),
    pathInstructions,
    checks,
    learnings: strings(value.learnings, "learnings"),
    relatedRepositories: strings(
      value.relatedRepositories,
      "relatedRepositories",
    ),
  };
}

export const reviewPolicyJson = (policy: ReviewPolicy): string =>
  JSON.stringify(policy, null, 2);

function readPolicies(): PolicyStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(POLICY_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as PolicyStore) : {};
  } catch {
    return {};
  }
}

export function loadReviewPolicy(repo: string): ReviewPolicy {
  return readPolicies()[repo]?.policy ?? DEFAULT_REVIEW_POLICY;
}

export function saveReviewPolicy(repo: string, policy: ReviewPolicy): ReviewPolicy {
  const store = readPolicies();
  store[repo] = { at: Date.now(), policy };
  const repos = Object.keys(store);
  if (repos.length > MAX_REPOS) {
    repos
      .sort((a, b) => (store[a].at ?? 0) - (store[b].at ?? 0))
      .slice(0, repos.length - MAX_REPOS)
      .forEach((key) => delete store[key]);
  }
  try {
    localStorage.setItem(POLICY_KEY, JSON.stringify(store));
  } catch {
    // Policy is optional steering; a full storage quota must not break review.
  }
  return policy;
}

function readHeads(): HeadStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(AUTO_HEAD_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as HeadStore) : {};
  } catch {
    return {};
  }
}

const prKey = (repo: string, number: number): string => `${repo}#${number}`;

export function autoReviewedHead(repo: string, number: number): string {
  return readHeads()[prKey(repo, number)]?.head ?? "";
}

export function rememberAutoReviewedHead(
  repo: string,
  number: number,
  head: string,
): void {
  const store = readHeads();
  const key = prKey(repo, number);
  if (!head) delete store[key];
  else store[key] = { at: Date.now(), head };
  const keys = Object.keys(store);
  if (keys.length > MAX_AUTO_HEADS) {
    keys
      .sort((a, b) => (store[a].at ?? 0) - (store[b].at ?? 0))
      .slice(0, keys.length - MAX_AUTO_HEADS)
      .forEach((old) => delete store[old]);
  }
  try {
    localStorage.setItem(AUTO_HEAD_KEY, JSON.stringify(store));
  } catch {
    /* optional cache */
  }
}

export function shouldAutoReview(
  policy: ReviewPolicy,
  pr: {
    head: string;
    state: string;
    draft: boolean;
    busy: boolean;
    lastHead: string;
  },
): boolean {
  return (
    policy.autoReview &&
    !!pr.head &&
    pr.state === "OPEN" &&
    (!pr.draft || policy.reviewDrafts) &&
    !pr.busy &&
    pr.lastHead !== pr.head
  );
}
