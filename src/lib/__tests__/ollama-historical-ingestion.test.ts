import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanOllamaHistoricalRequestEntries } from '@/app/api/tokens/route'

describe('Ollama historical request ingestion', () => {
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

  it('loads local assistant request rows from OpenClaw session JSONL', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ollama-jsonl-'))
    tempDirs.push(tempRoot)

    const jsonlDir = path.join(tempRoot, 'agents', 'tarah', 'sessions')
    fs.mkdirSync(jsonlDir, { recursive: true })

    const jsonlPath = path.join(jsonlDir, 'session-local.jsonl')

    const lines = [
      JSON.stringify({
        type: 'message',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          model: 'qwen3-coder:30b',
          provider: 'ollama',
          timestamp: '2026-03-27T14:00:00.000Z',
          usage: {
            input: 120,
            output: 30,
          },
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          id: 'assistant-2',
          role: 'assistant',
          model: 'deepseek-r1:14b',
          provider: 'local',
          timestamp: '2026-03-27T14:05:00.000Z',
          usage: {
            input_tokens: 80,
            output_tokens: 20,
          },
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          id: 'assistant-3',
          role: 'assistant',
          model: 'anthropic/claude-sonnet-4-20250514',
          provider: 'anthropic',
          timestamp: '2026-03-27T14:06:00.000Z',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          id: 'user-1',
          role: 'user',
          model: 'qwen3-coder:30b',
          provider: 'ollama',
          timestamp: '2026-03-27T14:07:00.000Z',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ]

    fs.writeFileSync(jsonlPath, lines.join('\n'))

    const entries = scanOllamaHistoricalRequestEntries(tempRoot)

    expect(entries).toHaveLength(2)
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'ollama-historical-tarah-session-local-assistant-1',
        model: 'qwen3-coder:30b',
        sessionId: 'session-local',
        agentName: 'tarah',
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
      }),
      expect.objectContaining({
        id: 'ollama-historical-tarah-session-local-assistant-2',
        model: 'deepseek-r1:14b',
        sessionId: 'session-local',
        agentName: 'tarah',
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
      }),
    ]))
  })
})
