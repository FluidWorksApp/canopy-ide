// Turning a node's machine-facing fields into something readable, kept out of
// NodeView.tsx so that file exports components and nothing else.

import type { Node } from './spine'

/** A verb name shown to a person: `terminals.spawn` reads as 'Spawn'. */
export function actionLabel(action: string): string {
  const verb = action.slice(action.indexOf('.') + 1)
  const words = verb.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** One level of nesting is enough for a fallback; deeper structure is exactly
 *  the signal that the module has outgrown the generic view. */
export function flatten(data: Node['data'], prefix = ''): [string, string][] {
  if (data === undefined || data === null) return []
  if (typeof data !== 'object') return [[prefix || 'value', String(data)]]
  if (Array.isArray(data)) {
    return data.length ? [[prefix || 'items', `${data.length} items`]] : []
  }
  const out: [string, string][] = []
  for (const [k, v] of Object.entries(data)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v === null || v === undefined) continue
    if (typeof v === 'object') {
      out.push(...flatten(v as Node['data'], key))
    } else {
      out.push([key, String(v)])
    }
  }
  return out
}
