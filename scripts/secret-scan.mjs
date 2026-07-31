#!/usr/bin/env node
// Credential scanner. Runs in two places for two different reasons:
//
//   .githooks/pre-commit  --staged  — the added lines of a commit, before it
//                                     exists. The only stage where a leak is
//                                     still cheap to undo.
//   .github/workflows/ci  --all     — every tracked file, so a `commit -n` or
//                                     a push from a clone without the hook
//                                     installed still gets caught.
//
// The rules below match issuer-shaped credentials only. Entropy heuristics were
// deliberately left out: a scanner that cries wolf gets bypassed, and a bypassed
// scanner catches nothing.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * Each rule is a distinct issuer shape. `re` must be global — the scanner
 * iterates matches per line.
 */
export const RULES = [
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Google OAuth client secret', re: /\bGOCSPX-[0-9A-Za-z_-]{20,}/g },
  { name: 'Anthropic API key', re: /\bsk-ant-[0-9A-Za-z_-]{24,}/g },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[0-9A-Za-z_-]{32,}/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/g },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[0-9A-Za-z_]{60,}\b/g },
  { name: 'Slack token', re: /\bxox[abpres]-[0-9A-Za-z-]{10,}/g },
  { name: 'Stripe live key', re: /\b[sr]k_live_[0-9A-Za-z]{20,}\b/g },
  { name: 'Browserbase key', re: /\bbb_(?:live|test)_[0-9A-Za-z]{20,}\b/g },
  { name: 'npm token', re: /\bnpm_[0-9A-Za-z]{36}\b/g },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'Private key block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  // Tauri/minisign signing key: the base64 blob always opens with the
  // "untrusted comment" header, which encodes to this prefix. The updater's
  // PUBLIC key is shipped in tauri.conf.json and has the same prefix, so the
  // comment itself decides — only a secret key is a finding.
  {
    name: 'Minisign/Tauri signing key',
    re: /\bdW50cnVzdGVkIGNvbW1lbnQ6[0-9A-Za-z+/=]{10,}/g,
    filter: (m) => /secret key/i.test(Buffer.from(m, 'base64').toString('utf8').split('\n')[0] ?? ''),
  },
  // Apple app-specific password, as used for notarisation.
  { name: 'Apple app-specific password', re: /\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/g },
]

/** An escape hatch for the rare line that must carry a credential shape. */
const ALLOW_MARKER = 'secret-scan:allow'

/**
 * Words a real issuer never puts in a live credential but a fixture almost
 * always does. Checked against the matched value, not the whole line, so a
 * real key on a line mentioning "example" is still reported.
 */
const PLACEHOLDER = /example|placeholder|redacted|fake|dummy|sample|changeme|your[-_]?(key|token|secret)|xxxx|0000|1234567890|not[-_]?a[-_]?real/i

/** Enough of the value to recognise it, not enough to use it. */
export function preview(value) {
  if (value.length <= 12) return value
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`
}

/**
 * Findings in a blob of text. `startLine` lets a diff hunk report the line
 * number the file will actually have.
 */
export function scanText(text, { path = '<stdin>', startLine = 1 } = {}) {
  const findings = []
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    // The marker covers its own line and the one after it, so a value on a line
    // too long to carry a trailing comment can be excused from the line above.
    if (line.includes(ALLOW_MARKER) || lines[i - 1]?.includes(ALLOW_MARKER)) continue
    // One value can match two rules (an Anthropic key is also OpenAI-shaped);
    // the first rule to claim it is the one reported.
    const claimed = new Set()
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      for (const m of line.matchAll(rule.re)) {
        if (PLACEHOLDER.test(m[0]) || claimed.has(m[0])) continue
        if (rule.filter && !rule.filter(m[0])) continue
        claimed.add(m[0])
        findings.push({
          path,
          line: startLine + i,
          rule: rule.name,
          preview: preview(m[0]),
        })
      }
    }
  }
  return findings
}

/**
 * Findings in the added lines of a unified diff produced with `-U0`. Only added
 * lines are scanned: a commit that merely touches a file which already carried
 * a credential is not the commit that leaked it, and blocking it teaches people
 * to pass `-n`.
 */
export function scanDiff(diff) {
  const findings = []
  let path = '<unknown>'
  let lineNo = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4)
      path = p === '/dev/null' ? p : p.replace(/^b\//, '')
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      lineNo = Number(hunk[1])
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      findings.push(...scanText(line.slice(1), { path, startLine: lineNo }))
      lineNo++
    }
  }
  return findings
}

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

/**
 * The added lines of what is staged right now. A `-U0` diff carries no context,
 * so an allow marker that sits on an untouched line above the finding is not in
 * it; the staged file is consulted for that case rather than reporting a line
 * the author has already excused.
 */
function scanStaged() {
  const diff = git(['diff', '--cached', '--no-color', '-U0', '--diff-filter=ACMR'])
  return scanDiff(diff).filter((f) => {
    let lines
    try {
      lines = git(['show', `:${f.path}`]).split('\n')
    } catch {
      return true
    }
    const above = lines[f.line - 2]
    return !above?.includes(ALLOW_MARKER)
  })
}

/** Every tracked text file, as it is on disk right now. */
function scanTree() {
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean)
  const findings = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // Binary — a credential in one is not something a line scanner can report
    // usefully, and the noise would be enormous.
    if (text.includes('\0')) continue
    findings.push(...scanText(text, { path: file }))
  }
  return findings
}

function report(findings, mode) {
  if (findings.length === 0) {
    console.log(`secret-scan: clean (${mode})`)
    return 0
  }
  console.error(`\nsecret-scan: ${findings.length} possible credential(s) found\n`)
  for (const f of findings) {
    console.error(`  ${f.path}:${f.line}  ${f.rule}  ${f.preview}`)
  }
  console.error(
    [
      '',
      'Nothing has been committed. Before anything else: if one of these is real,',
      'revoke it at the issuer — a key that reached a commit is already spent.',
      '',
      'Then replace it with a fixture that cannot be used (fake/example/xxxx in the',
      'value is recognised and ignored), or, if the line genuinely must carry this',
      `shape, mark it with a trailing \`${ALLOW_MARKER}\` comment.`,
      '',
    ].join('\n'),
  )
  return 1
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const staged = process.argv.includes('--staged')
  process.exit(report(staged ? scanStaged() : scanTree(), staged ? 'staged' : 'tracked files'))
}
