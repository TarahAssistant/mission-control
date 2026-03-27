import { describe, expect, it } from 'vitest'
import { buildSessionCostEntries, type TokenUsageRecord } from '@/app/api/tokens/route'

describe('session cost rollups', () => {
  it('groups records by session and model with first/last timestamps', () => {
    const records: TokenUsageRecord[] = [
      {
        id: '1',
        model: 'claude-sonnet-4',
        sessionId: 'alpha:chat',
        agentName: 'alpha',
        timestamp: 1_000,
        inputTokens: 60,
        outputTokens: 40,
        totalTokens: 100,
        cost: 1.0,
        operation: 'chat',
      },
      {
        id: '2',
        model: 'claude-sonnet-4',
        sessionId: 'alpha:chat',
        agentName: 'alpha',
        timestamp: 2_000,
        inputTokens: 30,
        outputTokens: 20,
        totalTokens: 50,
        cost: 0.5,
        operation: 'chat',
      },
      {
        id: '3',
        model: 'gemini-3-pro-preview',
        sessionId: 'alpha:chat',
        agentName: 'alpha',
        timestamp: 1_500,
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
        cost: 0.2,
        operation: 'chat',
      },
      {
        id: '4',
        model: 'claude-sonnet-4',
        sessionId: 'beta:chat',
        agentName: 'beta',
        timestamp: 3_000,
        inputTokens: 6,
        outputTokens: 4,
        totalTokens: 10,
        cost: 0.1,
        operation: 'chat',
      },
    ]

    const entries = buildSessionCostEntries(records)
    expect(entries).toHaveLength(3)

    const alphaSonnet = entries.find((entry) => entry.sessionId === 'alpha:chat' && entry.model === 'claude-sonnet-4')
    expect(alphaSonnet).toBeTruthy()
    expect(alphaSonnet?.totalTokens).toBe(150)
    expect(alphaSonnet?.inputTokens).toBe(90)
    expect(alphaSonnet?.outputTokens).toBe(60)
    expect(alphaSonnet?.totalCost).toBeCloseTo(1.5)
    expect(alphaSonnet?.requestCount).toBe(2)
    expect(alphaSonnet?.firstSeen).toBe(new Date(1_000).toISOString())
    expect(alphaSonnet?.lastSeen).toBe(new Date(2_000).toISOString())

    expect(entries[0]?.sessionId).toBe('alpha:chat')
    expect(entries[0]?.model).toBe('claude-sonnet-4')
    expect(entries[0]?.totalCost).toBeCloseTo(1.5)
  })
})
