// Desktop-parity diff rendering: the same @git-diff-view/react renderer the
// desktop's PrView and DiffView use, loaded lazily so a phone only downloads
// it once a diff is actually opened. The plain <pre> renderer in Diff.tsx
// stays as the Suspense fallback and the huge-patch escape hatch.
import { useMemo, useRef } from 'react'
import { DiffView, DiffModeEnum } from '@git-diff-view/react'
import '@git-diff-view/react/styles/diff-view.css'
import { useWide } from '../useMedia'

// Same rule as desktop PrView's HIGHLIGHT_MAX: syntax-highlight only files
// at/under this many changed lines — highlighting is the expensive part.
const HIGHLIGHT_MAX = 800

interface FilePatch {
  path: string
  patch: string
  additions: number
  deletions: number
  changed: number
  binary: boolean
}

/** Mirror of desktop PrView's splitPatch: one section per `diff --git` header,
 *  taking the b/ side of the header so renames show their new name. */
function splitPatch(patch: string): { path: string; patch: string }[] {
  const out: { path: string; patch: string }[] = []
  let current: { path: string; lines: string[] } | null = null
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) out.push({ path: current.path, patch: current.lines.join('\n') })
      const m = /diff --git a\/(.+?) b\/(.+)$/.exec(line)
      current = { path: m?.[2] ?? line.slice(11), lines: [line] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) out.push({ path: current.path, patch: current.lines.join('\n') })
  return out
}

function fileStats(patch: string): Omit<FilePatch, 'path' | 'patch'> {
  let additions = 0
  let deletions = 0
  let binary = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
    else if (line.startsWith('Binary files ')) binary = true
  }
  return { additions, deletions, changed: additions + deletions, binary }
}

/** The exact shape DiffView's `data` prop wants. */
interface DiffData {
  hunks: string[]
  oldFile: { fileName: string }
  newFile: { fileName: string }
}

/** Same cache as the desktop's src/diffData.ts: the library keys its internal
 *  useMemo on the identity of `data`, so a fresh object literal per render
 *  makes it reparse and re-highlight the patch every time. Hand back the same
 *  object for the same (path, patch) pair. */
function useDiffData(): (f: { path: string; patch: string }) => DiffData {
  const cache = useRef(new Map<string, DiffData>())
  return (f) => {
    const hit = cache.current.get(f.path)
    if (hit && hit.hunks[0] === f.patch) return hit
    const data: DiffData = {
      hunks: [f.patch],
      oldFile: { fileName: f.path },
      newFile: { fileName: f.path },
    }
    cache.current.set(f.path, data)
    return data
  }
}

export default function GitDiff({ patch }: { patch: string }) {
  // Split when the screen has room for two columns, unified on a phone — the
  // same wide/narrow line the two shells are chosen by.
  const wide = useWide()
  // The desktop pushes its theme onto the portal via applyTheme, which stamps
  // data-portal-theme on the root. No stamp yet means the default dark chrome.
  const theme =
    document.documentElement.dataset.portalTheme === 'light' ? ('light' as const) : ('dark' as const)
  const files = useMemo<FilePatch[]>(() => {
    const sections = splitPatch(patch)
    // A patch without `diff --git` headers (e.g. a bare hunk) is one file.
    const list = sections.length > 0 ? sections : patch.trim() ? [{ path: '', patch }] : []
    return list.map((f) => ({ ...f, ...fileStats(f.patch) }))
  }, [patch])
  const dataFor = useDiffData()

  return (
    <div className="gdiff">
      {files.map((f, i) => (
        <section className="gdiff-file" key={`${f.path}#${i}`}>
          {f.path && (
            <header className="gdiff-head mono">
              <span className="gdiff-path">{f.path}</span>
              <span className="gdiff-stat">
                <span className="add">+{f.additions}</span>
                <span className="del">−{f.deletions}</span>
              </span>
            </header>
          )}
          {f.binary || !f.patch.includes('@@') ? (
            <div className="panel-note">
              {f.binary ? 'Binary file — nothing to render.' : 'No textual changes.'}
            </div>
          ) : (
            <div className="gdiff-body">
              <DiffView
                data={dataFor(f)}
                diffViewMode={wide ? DiffModeEnum.Split : DiffModeEnum.Unified}
                diffViewHighlight={f.changed <= HIGHLIGHT_MAX}
                diffViewTheme={theme}
                diffViewWrap={false}
                diffViewAddWidget={false}
                diffViewFontSize={12}
              />
            </div>
          )}
        </section>
      ))}
    </div>
  )
}
