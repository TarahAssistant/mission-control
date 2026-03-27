import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateStats, filterByTimeframe, resolveTimeframeRange, type TokenUsageRecord } from '@/app/api/tokens/route'

function makeRecord(timestamp: number, operation = 'chat_completion'): TokenUsageRecord {
  return {
    id: `rec-${timestamp}-${operation}`,
    model: 'grok-4',
    sessionId: 'test-session',
    agentName: 'test-agent',
    timestamp,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cost: 0.12,
    operation,
  }
}

describe('token timeframe filtering', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-27T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps month as a rolling 30-day timeframe', () => {
    const insideRollingWindow = Date.parse('2026-02-26T12:00:00.000Z')
    const outsideRollingWindow = Date.parse('2026-02-20T12:00:00.000Z')

    const filtered = filterByTimeframe([
      makeRecord(insideRollingWindow),
      makeRecord(outsideRollingWindow),
    ], 'month')

    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.timestamp).toBe(insideRollingWindow)
  })

  it('supports previous calendar month filtering explicitly', () => {
    const inPreviousMonthA = Date.parse('2026-02-01T00:00:00.000Z')
    const inPreviousMonthB = Date.parse('2026-02-28T23:59:59.999Z')
    const inCurrentMonth = Date.parse('2026-03-01T00:00:00.000Z')

    const filtered = filterByTimeframe([
      makeRecord(inPreviousMonthA),
      makeRecord(inPreviousMonthB),
      makeRecord(inCurrentMonth),
    ], 'previous_month')

    expect(filtered.map((r) => r.timestamp).sort((a, b) => a - b)).toEqual([
      inPreviousMonthA,
      inPreviousMonthB,
    ])

    const range = resolveTimeframeRange('previous_month')
    expect(range).toEqual({
      startMs: Date.parse('2026-02-01T00:00:00.000Z'),
      endMs: Date.parse('2026-03-01T00:00:00.000Z'),
    })
  })
})

describe('request counting with snapshot data', () => {
  it('does not treat session snapshots as requests when request records exist', () => {
    const records: TokenUsageRecord[] = [
      makeRecord(Date.parse('2026-03-20T10:00:00.000Z'), 'session_snapshot'),
      makeRecord(Date.parse('2026-03-20T10:05:00.000Z'), 'xai_historical_request'),
      makeRecord(Date.parse('2026-03-20T10:10:00.000Z'), 'xai_historical_request'),
    ]

    const stats = calculateStats(records)

    expect(stats.requestCount).toBe(2)
    expect(stats.totalTokens).toBe(450)
    expect(stats.avgTokensPerRequest).toBe(225)
  })
})
