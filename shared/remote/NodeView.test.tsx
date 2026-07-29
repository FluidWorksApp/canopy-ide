// Constraint 6, made checkable: a module the renderer has never heard of must
// still produce a usable row. These nodes belong to a fictional module on
// purpose — if this file ever needs to import one, the renderer has stopped
// being generic.

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { NodeDetail, NodeList, UnavailableCard } from './NodeView'
import { actionLabel, flatten } from './nodeText'
import type { Node } from './spine'

const node: Node = {
  ref: 'widgets/widget/7',
  module: 'widgets',
  kind: 'widget',
  title: 'Nightly build',
  subtitle: 'apps/web',
  status: 'live',
  badge: { count: 3 },
  actions: ['widgets.restart'],
  data: { port: 5173, owner: { name: 'web' } },
}

describe('the generic renderer', () => {
  it('renders a node from a module it has never heard of', () => {
    render(<NodeList nodes={[node]} />)
    expect(screen.getByText('Nightly build')).toBeTruthy()
    expect(screen.getByText('apps/web')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('offers only the actions the node says are live on it', async () => {
    const onAct = vi.fn()
    render(<NodeList nodes={[node]} onAct={onAct} />)
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(onAct).toHaveBeenCalledWith(node, 'widgets.restart')
  })

  it('does not swallow the row click when an action is pressed', async () => {
    const onSelect = vi.fn()
    const onAct = vi.fn()
    render(<NodeList nodes={[node]} onSelect={onSelect} onAct={onAct} />)
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(onAct).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('says how many it dropped rather than looking complete', () => {
    render(<NodeList nodes={[node]} more={12} />)
    expect(screen.getByText('12 more not shown')).toBeTruthy()
  })

  it('explains an unavailable module instead of leaving a gap', () => {
    render(
      <UnavailableCard
        title="Browser"
        capability={{ level: 'none', reason: 'It is a native view.' }}
      />,
    )
    expect(screen.getByText(/native view/)).toBeTruthy()
  })

  it("falls back to the node's own fields when a module ships no view", () => {
    render(<NodeDetail node={node} />)
    expect(screen.getByText('port')).toBeTruthy()
    expect(screen.getByText('owner.name')).toBeTruthy()
  })
})

describe('label and field helpers', () => {
  it('reads a verb as a person would', () => {
    expect(actionLabel('widgets.restart')).toBe('Restart')
    expect(actionLabel('hibernation.resume-all')).toBe('Resume all')
  })

  it('summarises arrays rather than dumping them', () => {
    expect(flatten({ tags: ['a', 'b'] })).toEqual([['tags', '2 items']])
    expect(flatten(null)).toEqual([])
  })
})
