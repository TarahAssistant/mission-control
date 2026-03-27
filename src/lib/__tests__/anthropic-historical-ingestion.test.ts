import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAnthropicHistoricalRequestEntries } from '@/app/api/tokens/route'

describe('Anthropic historical request ingestion', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
    tempDirs.length = 0
  })

  it('loads Anthropic assistant request rows from OpenClaw session JSONL', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-anthropic-jsonl-'))
    tempDirs.push(tempRoot)

    const jsonlDir = path.join(tempRoot, 'agents', 'tarah', 'sessions')
    fs.mkdirSync(jsonlDir, { recursive: true })

    const jsonlPath = path.join(jsonlDir, 'session-abc.jsonl')
    const timestamp = '2026-03-27T14:00:00.000Z'

    const lines = [
      JSON.stringify({
        type: 'message',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          model: 'anthropic/claude-sonnet-4-20250514',
          provider: 'anthropic',
          timestamp,
          usage: {
            input_tokens: 123,
            output_tokens: 45,
            cache_read_input_tokens: 67,
            cache_creation_input_tokens: 11,
          },
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          model: 'xai/grok-4',
          provider: 'xai',
          timestamp,
          usage: { input: 3, output: 2 },
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          model: 'anthropic/claude-sonnet-4-20250514',
          provider: 'anthropic',
          timestamp,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      }),
    ]

    fs.writeFileSync(jsonlPath, lines.join('\n'))

    const entries = scanAnthropicHistoricalRequestEntries(tempRoot)

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 'anthropic-historical-tarah-session-abc-assistant-1',
      model: 'anthropic/claude-sonnet-4-20250514',
      sessionId: 'session-abc',
      agentName: 'tarah',
      inputTokens: 123,
      outputTokens: 45,
      cacheRead: 67,
      cacheWrite: 11,
      totalTokens: 246,
    })
  })
})
