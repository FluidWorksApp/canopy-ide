import { describe, expect, it } from "vitest";
import {
  describeSecretFindings,
  entropy,
  scanDiffForSecrets,
} from "./vibeSecretScan";

// Every fixture is assembled at runtime. A credential-shaped literal in this
// file would be found by the real scanner in CI — correctly, since it cannot
// know the string is a fixture, and a scanner that trusted a file's intent
// would be no scanner at all. Building them from parts keeps the patterns
// genuinely exercised without committing anything that looks like a key.
const join = (...parts: string[]) => parts.join("");

const AWS = join("AKIA", "IOSFODNN7", "EXAMPLE");
const HIGH_ENTROPY = join("gQ7xR2mZ", "9pL4vK8w", "T1yB6nH3", "jF5sD0aC");

const diff = (...lines: string[]) =>
  [
    "diff --git a/app.ts b/app.ts",
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,3 +1,4 @@",
    ...lines,
  ].join("\n");

describe("credential formats", () => {
  const cases: [string, string][] = [
    ["private-key", join("-----BEGIN ", "RSA PRIVATE KEY", "-----")],
    ["aws-access-key", `const k = '${AWS}'`],
    ["github-token", join("ghp", "_", "a".repeat(36))],
    ["stripe-secret-key", join("sk", "_live_", "b".repeat(24))],
    ["anthropic-key", join("sk", "-ant-", "c".repeat(40))],
    ["google-api-key", join("AI", "za", "D".repeat(35))],
    ["npm-token", join("npm", "_", "e".repeat(36))],
    [
      "postgres-url-with-password",
      join("postgres", "://user:", "hunter2", "@db:5432/app"),
    ],
  ];

  for (const [rule, sample] of cases) {
    it(`blocks a ${rule}`, () => {
      const result = scanDiffForSecrets(diff(`+${sample}`));
      expect(result.clean, rule).toBe(false);
      expect(result.findings.map((f) => f.rule)).toContain(rule);
    });
  }

  it("never repeats the matched value in a finding", () => {
    const secret = join("sk", "_live_", "z".repeat(24));
    const result = scanDiffForSecrets(diff(`+const key = "${secret}"`));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(describeSecretFindings(result.findings)).not.toContain(secret);
  });
});

describe("what it deliberately does not block", () => {
  it("ignores a secret being removed, since that is the leak being cleaned up", () => {
    const result = scanDiffForSecrets(diff(`-const k = "${AWS}"`));
    expect(result.clean).toBe(true);
  });

  it("ignores placeholders and env indirection", () => {
    for (const value of [
      "API_KEY = 'your-api-key-here'",
      'TOKEN = "changeme"',
      "SECRET = process.env.SECRET",
      "PASSWORD = '<your password>'",
      "API_KEY = 'xxxxxxxxxxxxxxxxxxxx'",
    ]) {
      expect(scanDiffForSecrets(diff(`+${value}`)).clean, value).toBe(true);
    }
  });

  it("ignores low-entropy prose assigned to a secret-ish name", () => {
    const result = scanDiffForSecrets(
      diff(`+const TOKEN_DESCRIPTION = "the token that we use for testing";`),
    );
    expect(result.clean).toBe(true);
  });
});

describe("high-entropy assignments", () => {
  it("blocks a long random literal assigned to a secret-shaped name", () => {
    const result = scanDiffForSecrets(
      diff(`+const DB_PASSWORD = "${HIGH_ENTROPY}";`),
    );
    expect(result.clean).toBe(false);
    expect(result.findings[0].rule).toBe("high-entropy-secret-assignment");
  });

  it("separates random strings from English by entropy", () => {
    expect(entropy(HIGH_ENTROPY)).toBeGreaterThan(4);
    expect(entropy("the token that we use for testing")).toBeLessThan(3.6);
  });
});

describe("locating a finding", () => {
  it("reports the file and the line the secret was added on", () => {
    const result = scanDiffForSecrets(
      [
        "diff --git a/src/env.ts b/src/env.ts",
        "--- a/src/env.ts",
        "+++ b/src/env.ts",
        "@@ -10,2 +10,3 @@",
        " const a = 1;",
        " const b = 2;",
        `+const c = '${AWS}';`,
      ].join("\n"),
    );
    expect(result.findings[0]).toMatchObject({ file: "src/env.ts", line: 12 });
    expect(describeSecretFindings(result.findings)).toContain("src/env.ts:12");
  });

  it("is honest about what it covers", () => {
    expect(scanDiffForSecrets("").scope).toMatch(/gitleaks/);
  });
});
