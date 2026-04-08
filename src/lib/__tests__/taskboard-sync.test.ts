import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { mockAll, mockPrepare, mockConfig } = vi.hoisted(() => {
  const mockAll = vi.fn()
  const mockPrepare = vi.fn(() => ({ all: mockAll }))
  const mockConfig = { openclawHome: '' }
  return { mockAll, mockPrepare, mockConfig }
})

vi.mock('@/lib/db', () => ({
  getDatabase: () => ({ prepare: mockPrepare }),
}))

vi.mock('@/lib/config', () => ({
  config: mockConfig,
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { syncTaskboardMd } from '@/lib/taskboard-sync'

describe('syncTaskboardMd', () => {
  let tempRoot = ''

  beforeEach(() => {
    vi.clearAllMocks()
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mc-taskboard-sync-'))
    mockConfig.openclawHome = tempRoot
    mockAll.mockReturnValue([])
  })

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
    mockConfig.openclawHome = ''
  })

  it('renders canonical project ticket refs when project metadata exists', async () => {
    mockAll.mockReturnValue([
      {
        id: 204,
        title: 'Feature: Third-party API integration (Claude, etc.)',
        description: 'Modular API for third-party integrations.',
        status: 'assigned',
        priority: 'medium',
        project_ticket_no: 54,
        project_prefix: 'EL',
        assigned_to: 'rae-anna',
        tags: '["enhancement"]',
      },
    ])

    await syncTaskboardMd()

    const md = readFileSync(path.join(tempRoot, 'workspace', 'mc-tasks.md'), 'utf-8')
    expect(md).toContain('**EL-054**')
    expect(md).not.toContain('**MC-204**')

    const prepareCalls = mockPrepare.mock.calls as unknown as Array<[string]>
    const query = prepareCalls[0]?.[0] ?? ''
    expect(query).toContain('LEFT JOIN projects p')
    expect(query).toContain('p.ticket_prefix as project_prefix')
  })

  it('falls back to legacy MC-row-id refs when historical tasks have no project metadata', async () => {
    mockAll.mockReturnValue([
      {
        id: 259,
        title: '[PARSE] Land orphaned commits MC-256/257/258 → main via PR',
        description: 'Historical task with no project metadata backfill yet.',
        status: 'done',
        priority: 'high',
        assigned_to: 'parse-builder',
        completed_at: Math.floor(Date.now() / 1000),
      },
    ])

    await syncTaskboardMd()

    const md = readFileSync(path.join(tempRoot, 'workspace', 'mc-tasks.md'), 'utf-8')
    expect(md).toContain('**MC-259**')
  })
})
