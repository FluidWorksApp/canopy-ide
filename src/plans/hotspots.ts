// Where a mistake costs the most, by path.
//
// Two features lean on the same judgement. Plans (#3) scale with blast radius:
// a plan that expects to touch auth, data, money or the repo's shared plumbing
// waits for a person's approval however small the brain thinks it is. Review
// (#4) routes by risk: the same high-stakes layers are always "high — read the
// lines", whatever the brain's ranking says, because that is the one place a
// summary must never stand in for a line read.
//
// Deliberately path-based and dumb. The brain ranks everything else; this is
// the floor it cannot talk its way under.

/** The layers a reviewer must always read line by line. */
const FORCED_HIGH: readonly [string, RegExp][] = [
  [
    "auth",
    /(^|[/._-])(auth|authn|authz|oauth|login|logout|signin|signup|session|sessions|password|passwd|credential|credentials|secret|secrets|token|tokens|permission|permissions|rbac|acl|sso|saml|jwt)([/._-]|s?$)/i,
  ],
  ["migration", /(^|\/)(migrations?|migrate)(\/|$)|\.migration\.|(^|\/)\d{3,}[_-][^/]*\.sql$/i],
  [
    "data",
    /(^|\/)(schema|schemas|db|database|models?|prisma|seeds?)(\/|\.|$)|\.(sql|prisma)$|(^|\/)ledger\.(rs|ts)$/i,
  ],
  [
    "money",
    /(^|[/._-])(billing|payment|payments|stripe|invoice|invoices|pricing|price|prices|checkout|subscription|subscriptions|wallet|refund|refunds|payout|payouts|money|charge|charges)([/._-]|$)/i,
  ],
];

/** Shared plumbing: a change here lands on everyone at once, so a plan that
 *  touches it is a team decision even when the edit is one line. */
const SHARED: readonly [string, RegExp][] = [
  ["CI", /(^|\/)\.github\/|(^|\/)\.gitlab-ci|(^|\/)\.circleci\//i],
  ["build config", /(^|\/)(package\.json|Cargo\.toml|tsconfig[^/]*\.json|vite\.config\.[jt]s|Dockerfile|docker-compose[^/]*)$/i],
  ["lockfile", /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$/i],
  ["infra", /(^|\/)(terraform|infra|k8s|helm|deploy|deployment)(\/|$)/i],
];

/** Why `path` is always high risk ("auth", "migration", "data", "money"), or
 *  null. Accepts areas as well as paths — a plan's `touches` are often words
 *  like "login flow". */
export function forcedHighReason(path: string): string | null {
  const p = path.trim();
  if (!p) return null;
  for (const [why, re] of FORCED_HIGH) if (re.test(p)) return why;
  return null;
}

/** Why a plan touching `path` needs a person's yes before it starts, or null:
 *  every forced-high layer plus the shared plumbing. */
export function hotspotReason(path: string): string | null {
  const forced = forcedHighReason(path);
  if (forced) return forced;
  const p = path.trim();
  for (const [why, re] of SHARED) if (re.test(p)) return why;
  return null;
}
