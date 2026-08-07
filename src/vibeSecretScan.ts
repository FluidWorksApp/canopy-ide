// The secret gate on an automatic checkpoint.
//
// `secretScanClean` was hardcoded false, which made auto-checkpoint dead code:
// no turn could ever save itself, however well verified. This is the missing
// scanner — but it is deliberately NOT a reimplementation of gitleaks, which
// already gates this repo in CI with the upstream ruleset. A second, weaker
// copy of those rules would drift from the real one and give a false sense of
// having been checked.
//
// So the layering is explicit and each layer claims only what it can prove:
//
//   this scan   — the unambiguous formats, on the diff about to be committed,
//                 catching the mistake at the moment it would be made.
//   gitleaks    — the full ruleset over full history, before anything is
//                 pushed or opened as a PR.
//
// A checkpoint is a LOCAL commit, so being the first of two gates is a coherent
// job. Claiming to be the only one would not be.
//
// Two rules shape the code. Any match blocks: a false positive costs someone a
// click, a false negative commits a credential. And a finding NEVER carries the
// matched text — a secret-scan finding that quoted the secret would leak it
// into the very transcript the scan exists to keep clean.

export interface SecretFinding {
  /** Which rule fired. Never the matched text. */
  rule: string;
  /** Where to look, so a human can check without the value being repeated. */
  file: string | null;
  line: number;
}

export interface SecretScanResult {
  clean: boolean;
  findings: SecretFinding[];
  /** What this scan does and does not cover, for the audit trail. */
  scope: string;
}

interface Rule {
  id: string;
  test: RegExp;
}

/** Formats that are unambiguous enough that a match is a finding on its own.
 *  Anything needing context to judge belongs to gitleaks, not here. */
const RULES: Rule[] = [
  { id: "private-key", test: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
  { id: "aws-access-key", test: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "github-token", test: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "gitlab-token", test: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: "slack-token", test: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "stripe-secret-key", test: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { id: "stripe-restricted-key", test: /\brk_live_[A-Za-z0-9]{16,}\b/ },
  { id: "openai-key", test: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: "anthropic-key", test: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
  { id: "google-api-key", test: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "npm-token", test: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "sendgrid-key", test: /\bSG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{16,}\b/ },
  { id: "jwt", test: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "postgres-url-with-password", test: /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/ },
  { id: "mongodb-url-with-password", test: /\bmongodb(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]+@/ },
];

/** A secret-looking name assigned a long, high-entropy literal. Kept separate
 *  because it is the only rule that needs judgement, and the entropy floor is
 *  what keeps `API_KEY = "changeme"` and `TOKEN = process.env.TOKEN` out. */
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*)\b\s*[:=]\s*["'`]([^"'`\n]{16,})["'`]/i;

/** Shannon entropy in bits per character. Random credentials sit well above
 *  4; English prose and placeholders sit well below 3.5. */
export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const ENTROPY_FLOOR = 3.6;
/** Values that are obviously not credentials however long they are. */
const PLACEHOLDER =
  /^(?:x{4,}|\.{3,}|<[^>]+>|\$\{[^}]+\}|process\.env\.|import\.meta\.env\.|your[-_ ]|change[-_ ]?me|example|placeholder|redacted|dummy|sample)/i;

const SCOPE =
  "unambiguous credential formats in the changed lines; full-history scanning stays with gitleaks in CI";

/** Scan a unified diff. Only added lines are examined: a removed secret is a
 *  secret being taken OUT, and blocking that would keep the leak in place. */
export function scanDiffForSecrets(diff: string): SecretScanResult {
  const findings: SecretFinding[] = [];
  let file: string | null = null;
  let line = 0;

  for (const raw of diff.split("\n")) {
    const renamed = /^\+\+\+ b\/(.+)$/.exec(raw);
    if (renamed) {
      file = renamed[1];
      line = 0;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]) - 1;
      continue;
    }
    if (raw.startsWith("-")) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    const added = raw.startsWith("+");
    if (added || raw.startsWith(" ")) line += 1;
    if (!added) continue;

    const text = raw.slice(1);
    for (const rule of RULES) {
      if (rule.test.test(text)) findings.push({ rule: rule.id, file, line });
    }
    const assigned = ASSIGNMENT.exec(text);
    if (
      assigned &&
      !PLACEHOLDER.test(assigned[2]) &&
      entropy(assigned[2]) >= ENTROPY_FLOOR
    ) {
      findings.push({ rule: "high-entropy-secret-assignment", file, line });
    }
  }

  return { clean: findings.length === 0, findings, scope: SCOPE };
}

/** Visible, and it names the rule.
 *
 *  Visible because a silent deletion would make the stored diff lie about what
 *  the turn changed — the record is the truth and neither writer nor reader may
 *  improve on it, so a redaction has to say "something was here".
 *
 *  Named because findings already carry the rule on the principle that the rule
 *  is safe to state and only the value is not; carrying it here makes the
 *  artifact self-explanatory to someone reading it later without the finding
 *  beside it, and leaks nothing the finding record does not already say. */
export const redactionMarker = (rule: string) => `[redacted by Canopy: ${rule}]`;

/** Replace credential-shaped spans with a marker, keeping the surrounding diff
 *  readable.
 *
 *  A refused turn persists its diff as an artifact so the user can see what
 *  was refused — which would otherwise write the credential to disk under
 *  `~/.canopy`, the same leak the finding rules exist to prevent, through a
 *  door nobody was watching. The scanner already knows the matching spans, so
 *  redacting is available rather than aspirational.
 *
 *  Deliberately redacts on every line, added or not: an artifact is stored
 *  text, not a change proposal, and a secret sitting in a context line is
 *  still a secret sitting on disk. */
export function redactSecrets(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let out = line;
      for (const rule of RULES) {
        out = out.replace(
          new RegExp(rule.test.source, "g"),
          redactionMarker(rule.id),
        );
      }
      const assigned = ASSIGNMENT.exec(out);
      if (
        assigned &&
        !PLACEHOLDER.test(assigned[2]) &&
        entropy(assigned[2]) >= ENTROPY_FLOOR
      ) {
        out = out.replace(
          assigned[2],
          redactionMarker("high-entropy-secret-assignment"),
        );
      }
      return out;
    })
    .join("\n");
}
