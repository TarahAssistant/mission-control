import { describe, expect, it } from 'vitest'

import { resolveAegisReviewAgentId } from '@/lib/task-dispatch'

describe('resolveAegisReviewAgentId', () => {
  it('prefers an explicit aegis agent when present', () => {
    const result = resolveAegisReviewAgentId([
      { name: 'main', role: 'agent', config: JSON.stringify({ openclawId: 'main' }) },
      { name: 'Aegis', role: 'agent', config: JSON.stringify({ openclawId: 'review-bot' }) },
    ])

    expect(result).toBe('review-bot')
  })

  it('falls back to a reviewer-role agent before default or main', () => {
    const result = resolveAegisReviewAgentId([
      { name: 'main', role: 'agent', config: JSON.stringify({ openclawId: 'main' }) },
      { name: 'qa', role: 'reviewer', config: JSON.stringify({ openclawId: 'qa-reviewer' }) },
    ])

    expect(result).toBe('qa-reviewer')
  })

  it('falls back to the configured default agent when no reviewer exists', () => {
    const result = resolveAegisReviewAgentId([
      { name: 'ops', role: 'agent', config: JSON.stringify({ openclawId: 'ops', isDefault: true }) },
      { name: 'secondary', role: 'agent', config: JSON.stringify({ openclawId: 'secondary' }) },
    ])

    expect(result).toBe('ops')
  })

  it('falls back to main when no reviewer or default agent exists', () => {
    const result = resolveAegisReviewAgentId([
      { name: 'main', role: 'agent', config: JSON.stringify({ openclawId: 'main' }) },
      { name: 'jeff', role: 'agent', config: JSON.stringify({ openclawId: 'jeff' }) },
    ])

    expect(result).toBe('main')
  })

  it('throws instead of inventing a stale fallback id', () => {
    expect(() => resolveAegisReviewAgentId([])).toThrow(/No review agent configured/i)
  })
})