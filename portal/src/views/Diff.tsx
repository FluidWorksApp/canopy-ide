// A unified diff, rendered.
//
// Not Monaco: the desktop's side-by-side editor is 3MB of JavaScript and needs
// horizontal room neither a phone nor a mobile connection has. A unified diff
// with coloured gutters is what a diff looks like on a small screen anyway, and
// it costs one pass over the text.

import { useMemo } from 'react'

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'

interface DiffLine {
  kind: LineKind
  text: string
}

export function parseDiff(patch: string): DiffLine[] {
  return patch.split('\n').map((text) => ({ kind: kindOf(text), text }))
}

function kindOf(line: string): LineKind {
  if (line.startsWith('@@')) return 'hunk'
  // Order matters: `+++`/`---` are file headers, not content, and colouring
  // them green and red is the classic tell of a diff view written in a hurry.
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file')) {
    return 'meta'
  }
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

export function DiffText({ patch }: { patch: string }) {
  const lines = useMemo(() => parseDiff(patch), [patch])
  const stat = useMemo(
    () => ({
      add: lines.filter((l) => l.kind === 'add').length,
      del: lines.filter((l) => l.kind === 'del').length,
    }),
    [lines],
  )
  if (!patch.trim()) return <div className="panel-empty">No changes in this file.</div>
  return (
    <div className="diff">
      <div className="diff-stat mono">
        <span className="add">+{stat.add}</span>
        <span className="del">−{stat.del}</span>
      </div>
      <pre className="diff-body">
        {lines.map((l, i) => (
          <span className={`dl ${l.kind}`} key={i}>
            {l.text || ' '}
          </span>
        ))}
      </pre>
    </div>
  )
}
