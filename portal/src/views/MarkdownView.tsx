// Markdown, rendered natively on the portal.
//
// Same pipeline as the desktop — shared/markdown.ts is the one sanctioned
// marked + DOMPurify path in the repo, and this component exists so the portal
// never grows a second one. No wikilinks here: nothing on the portal can mint
// internal navigation, so every document renders at the "external" grade.

import { useMemo } from 'react'
import { renderMarkdown } from '@shared/markdown'

export function MarkdownBody({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div
      className="md-body"
      // Safe: renderMarkdown sanitizes with DOMPurify before returning.
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        // The portal is a SPA on /remote — a plain href would navigate the
        // whole console away. Links leave for a new tab instead.
        const a = (e.target as HTMLElement).closest('a[href]')
        if (!a) return
        e.preventDefault()
        window.open(a.getAttribute('href')!, '_blank', 'noopener,noreferrer')
      }}
    />
  )
}

/** Whether a path should render as markdown rather than code. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}
