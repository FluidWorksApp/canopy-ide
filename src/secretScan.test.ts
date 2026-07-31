// The pre-commit hook and the CI job both run scripts/secret-scan.mjs. What
// makes that scanner useful is not that it matches — anything matches — but
// where it stays quiet: a scanner that flags fixtures and public keys gets
// bypassed within a week, and a bypassed scanner catches nothing. These tests
// pin both edges.
//
// The real leak that prompted the scanner is the Google-key case: a live
// GEMINI_API_KEY, read out of a local MCP config, reused verbatim as a
// redaction-test fixture and pushed to a public repo.
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, deliberately not part of the TS build
import { scanText, scanDiff } from '../scripts/secret-scan.mjs'

// The one file in the repo that must carry live-looking credential shapes: a
// test for a matcher cannot assert on a value the matcher skips. Every one of
// these is invented — issuer prefix and length only, never a mutation of a
// value seen anywhere — and each is marked, which is the same escape hatch any
// other line would use. Deriving a fixture from a real key by changing its last
// character would publish all but one character of that key.
const GOOGLE = 'AIzaBqTvNmKwRhLdJsPfXcZgYuEoIaQtWnBrVeD' // secret-scan:allow
const GITHUB = 'ghp_QvT8wYzX4nB7mC1dF6gH9jK0pL3sA5uZbRmE7t' // secret-scan:allow
const ANTHROPIC = 'sk-ant-api03-QvT8wYzX4nB7mC1dF6gH9jK0pL3sA5uZbRmE' // secret-scan:allow
const BROWSERBASE = 'bb_live_QvT8wYzX4nB7mC1dF6gH' // secret-scan:allow

type Finding = { path: string; line: number; rule: string; preview: string }
const rules = (text: string): string[] =>
  (scanText(text) as Finding[]).map((f) => f.rule)

describe('secret-scan', () => {
  it('catches the issuer shapes that have actually leaked', () => {
    expect(rules(`key = "${GOOGLE}"`)).toEqual(['Google API key'])
    expect(rules(`GITHUB_TOKEN=${GITHUB}`)).toEqual(['GitHub token'])
    // The header is the whole shape, so it cannot be asserted on without
    // writing it out. secret-scan:allow
    expect(rules('-----BEGIN OPENSSH PRIVATE KEY-----')).toEqual(['Private key block'])
    expect(rules(`BROWSERBASE_API_KEY: ${BROWSERBASE}`)).toEqual(['Browserbase key'])
  })

  it('reports a value once, under the first rule that claims it', () => {
    // An Anthropic key is also OpenAI-shaped; two lines for one value trains
    // people to skim the output.
    expect(rules(ANTHROPIC)).toEqual(['Anthropic API key'])
  })

  it('stays quiet on fixtures that name themselves as fixtures', () => {
    expect(rules('"AIzaFAKE-not-a-real-key"')).toEqual([])
    expect(rules('AIzaSyEXAMPLE00000000000000000000000000')).toEqual([])
  })

  it('honours the allow marker on its own line and the line below', () => {
    expect(rules(`${GITHUB} // secret-scan:allow`)).toEqual([])
    expect(rules(`// secret-scan:allow\n${GITHUB}`)).toEqual([])
  })

  it('leaves the updater public key alone and would flag the secret one', () => {
    const blob = (comment: string) =>
      Buffer.from(`${comment}\nRWRzP1Jhkw${'A'.repeat(40)}`).toString('base64')
    expect(rules(`"pubkey": "${blob('untrusted comment: minisign public key: DA78')}"`)).toEqual(
      [],
    )
    expect(
      rules(`TAURI_SIGNING_PRIVATE_KEY=${blob('untrusted comment: rsign encrypted secret key')}`),
    ).toEqual(['Minisign/Tauri signing key'])
  })

  it('never prints enough of a value to use it', () => {
    const [found] = scanText(GOOGLE) as Finding[]
    expect(found.preview).not.toContain(GOOGLE.slice(6, -4))
    expect(found.preview).toContain(`${GOOGLE.length} chars`)
  })

  describe('staged diffs', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -4,0 +5,2 @@',
      '+const untouched = 1',
      `+const key = "${GOOGLE}"`,
      '@@ -20 +22 @@',
      '-const old = 1',
      `+const gone = "${GITHUB}"`,
    ].join('\n')

    it('reports added lines at the line number the file will have', () => {
      const found = scanDiff(diff) as Finding[]
      expect(found.map((f) => [f.path, f.line, f.rule])).toEqual([
        ['src/a.ts', 6, 'Google API key'],
        ['src/a.ts', 22, 'GitHub token'],
      ])
    })

    it('ignores removed lines — deleting a secret is not leaking one', () => {
      const removal = [
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -5 +4,0 @@',
        `-const key = "${GOOGLE}"`,
      ].join('\n')
      expect(scanDiff(removal)).toEqual([])
    })
  })
})
