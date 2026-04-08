import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { config } from '@/lib/config'
import { logger } from '@/lib/logger'
import { readFile, writeFile } from 'node:fs/promises'
import { getSchedulerStatus, triggerTask } from '@/lib/scheduler'
import path from 'node:path'

interface CronJob {
  name: string
  schedule: string
  command: string
  enabled: boolean
  lastRun?: number
  nextRun?: number
  lastStatus?: 'success' | 'error' | 'running'
  lastError?: string
  // Extended fields from OpenClaw format
  id?: string
  agentId?: string
  timezone?: string
  model?: string
  delivery?: string
}

/**
 * OpenClaw cron jobs live in ~/.openclaw/cron/jobs.json
 * Format: { version: 1, jobs: [ { id, agentId, name, enabled, schedule: { kind, expr, tz }, payload, delivery, state } ] }
 */
interface OpenClawCronJob {
  id: string
  agentId: string
  name: string
  enabled: boolean
  createdAtMs?: number
  updatedAtMs?: number
  schedule: {
    kind: string
    expr: string
    tz?: string
    staggerMs?: number
  }
  sessionTarget?: string
  wakeMode?: string
  payload: {
    kind: string
    message?: string
    model?: string
    thinking?: string
    timeoutSeconds?: number
  }
  delivery?: {
    mode: string
    channel?: string
    to?: string
  }
  state?: {
    nextRunAtMs?: number
    lastRunAtMs?: number
    lastStatus?: string
    lastDurationMs?: number
    lastError?: string
  }
}

interface OpenClawCronFile {
  version: number
  jobs: OpenClawCronJob[]
}

function getCronFilePath(): string {
  const openclawStateDir = config.openclawStateDir
  if (!openclawStateDir) return ''
  return path.join(openclawStateDir, 'cron', 'jobs.json')
}

async function loadCronFile(): Promise<OpenClawCronFile | null> {
  const filePath = getCronFilePath()
  if (!filePath) return null
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function saveCronFile(data: OpenClawCronFile): Promise<boolean> {
  const filePath = getCronFilePath()
  if (!filePath) return false
  try {
    await writeFile(filePath, JSON.stringify(data, null, 2))
    return true
  } catch (err) {
    logger.error({ err }, 'Failed to write cron file')
    return false
  }
}

function mapLastStatus(status?: string): 'success' | 'error' | 'running' | undefined {
  if (!status) return undefined
  const s = status.toLowerCase()
  if (s === 'success' || s === 'completed' || s === 'updated') return 'success'
  if (s === 'error' || s === 'failed') return 'error'
  if (s === 'running' || s === 'pending') return 'running'
  return 'success' // default for unknown non-error statuses
}

function mapOpenClawJob(job: OpenClawCronJob): CronJob {
  // Build a human-readable command description from the payload
  const payloadSummary = job.payload.message
    ? job.payload.message.slice(0, 200) + (job.payload.message.length > 200 ? '...' : '')
    : `${job.payload.kind} (${job.agentId})`

  const scheduleStr = job.schedule.tz
    ? `${job.schedule.expr} (${job.schedule.tz})`
    : job.schedule.expr

  return {
    id: job.id,
    name: job.name,
    schedule: scheduleStr,
    command: payloadSummary,
    enabled: job.enabled,
    lastRun: job.state?.lastRunAtMs,
    nextRun: job.state?.nextRunAtMs,
    lastStatus: mapLastStatus(job.state?.lastStatus),
    lastError: job.state?.lastError,
    agentId: job.agentId,
    timezone: job.schedule.tz,
    model: job.payload.model,
    delivery: job.delivery?.mode === 'none' ? undefined : job.delivery?.channel,
  }
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')

    if (action === 'list') {
      const cronFile = await loadCronFile()
      if (!cronFile || !cronFile.jobs) {
        return NextResponse.json({ jobs: [] })
      }

      const schedulerTasks = getSchedulerStatus().map(task => ({
        id: task.id,
        name: task.name,
        schedule: "system-managed automation",
        command: `Built-in local automation (${task.id})`,
        enabled: task.enabled,
        lastRun: task.lastRun || undefined,
        nextRun: task.nextRun,
        lastStatus: task.running ? "running" : (task.lastResult?.ok === false ? "error" : (task.lastResult?.ok === true ? "success" : undefined)),
        lastError: task.lastResult?.message,
        agentId: "system-scheduler",
        delivery: "local",
      }));

      const jobs = cronFile.jobs.map(mapOpenClawJob)
      return NextResponse.json({ jobs: [...jobs, ...schedulerTasks] })
    }

    if (action === 'logs') {
      const jobId = searchParams.get('job')
      if (!jobId) {
        return NextResponse.json({ error: 'Job ID required' }, { status: 400 })
      }

      // Check if it's a scheduler task first
      const schedulerTask = getSchedulerStatus().find(t => t.id === jobId || t.name === jobId)
      if (schedulerTask) {
        const logs = []
        if (schedulerTask.lastRun) {
          logs.push({
            timestamp: schedulerTask.lastRun,
            message: schedulerTask.lastResult?.message || `Job executed — status: ${schedulerTask.lastResult?.ok ? 'success' : 'failed'}`,
            level: schedulerTask.lastResult?.ok === false ? 'error' : 'info',
          })
        }
        if (schedulerTask.nextRun) {
          logs.push({
            timestamp: Date.now(),
            message: `Next scheduled run: ${new Date(schedulerTask.nextRun).toLocaleString()}`,
            level: 'info',
          })
        }
        return NextResponse.json({ logs })
      }

      // Find the job to get its state info
      const cronFile = await loadCronFile()
      const job = cronFile?.jobs.find(j => j.id === jobId || j.name === jobId)

      const logs: Array<{ timestamp: number; message: string; level: string }> = []

      if (job?.state) {
        if (job.state.lastRunAtMs) {
          logs.push({
            timestamp: job.state.lastRunAtMs,
            message: `Job executed — status: ${job.state.lastStatus || 'unknown'}${job.state.lastDurationMs ? ` (${job.state.lastDurationMs}ms)` : ''}`,
            level: job.state.lastStatus === 'error' || job.state.lastStatus === 'failed' ? 'error' : 'info',
          })
        }
        if (job.state.lastError) {
          logs.push({
            timestamp: job.state.lastRunAtMs || Date.now(),
            message: `Error: ${job.state.lastError}`,
            level: 'error',
          })
        }
        if (job.state.nextRunAtMs) {
          logs.push({
            timestamp: Date.now(),
            message: `Next scheduled run: ${new Date(job.state.nextRunAtMs).toLocaleString()}`,
            level: 'info',
          })
        }
      }

      return NextResponse.json({ logs })
    }

    if (action === 'history') {
      const jobId = searchParams.get('jobId')
      if (!jobId) {
        return NextResponse.json({ error: 'Job ID required' }, { status: 400 })
      }

      const page = parseInt(searchParams.get('page') || '1', 10)
      const query = searchParams.get('query') || ''

      // Try to load run history from the cron runs log file
      const openclawStateDir = config.openclawStateDir
      if (!openclawStateDir) {
        return NextResponse.json({ entries: [], total: 0, hasMore: false })
      }

      try {
        const runsPath = path.join(openclawStateDir, 'cron', 'runs.json')
        const raw = await readFile(runsPath, 'utf-8')
        const runsData = JSON.parse(raw)
        let entries: any[] = Array.isArray(runsData.runs) ? runsData.runs : Array.isArray(runsData) ? runsData : []

        // Filter to this job
        entries = entries.filter((r: any) => r.jobId === jobId || r.id === jobId)

        // Apply search filter
        if (query) {
          const q = query.toLowerCase()
          entries = entries.filter((r: any) =>
            (r.status || '').toLowerCase().includes(q) ||
            (r.error || '').toLowerCase().includes(q) ||
            (r.deliveryStatus || '').toLowerCase().includes(q)
          )
        }

        // Sort by timestamp descending
        entries.sort((a: any, b: any) => (b.timestamp || b.startedAtMs || 0) - (a.timestamp || a.startedAtMs || 0))

        const pageSize = 20
        const start = (page - 1) * pageSize
        const paged = entries.slice(start, start + pageSize)

        return NextResponse.json({
          entries: paged,
          total: entries.length,
          hasMore: start + pageSize < entries.length,
          page,
        })
      } catch {
        // No runs file — fall back to state-based info
        const cronFile = await loadCronFile()
        const job = cronFile?.jobs.find(j => j.id === jobId || j.name === jobId)
        const entries: any[] = []
        if (job?.state?.lastRunAtMs) {
          entries.push({
            jobId: job.id,
            status: job.state.lastStatus || 'unknown',
            timestamp: job.state.lastRunAtMs,
            durationMs: job.state.lastDurationMs,
            error: job.state.lastError,
          })
        }
        return NextResponse.json({ entries, total: entries.length, hasMore: false, page: 1 })
      }
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    logger.error({ err: error }, 'Cron API error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const body = await request.json()
    const { action, jobName, jobId } = body

    if (action === 'toggle') {
      const id = jobId || jobName
      if (!id) {
        return NextResponse.json({ error: 'Job ID or name required' }, { status: 400 })
      }
      
      const schedulerTask = getSchedulerStatus().find(t => t.id === id || t.name === id)
      if (schedulerTask) {
        return NextResponse.json({ error: 'Cannot toggle built-in scheduler tasks' }, { status: 403 })
      }

      const cronFile = await loadCronFile()
      if (!cronFile) {
        return NextResponse.json({ error: 'Cron file not found' }, { status: 404 })
      }

      const job = cronFile.jobs.find(j => j.id === id || j.name === id)
      if (!job) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 })
      }

      job.enabled = !job.enabled
      job.updatedAtMs = Date.now()

      if (!(await saveCronFile(cronFile))) {
        return NextResponse.json({ error: 'Failed to save cron file' }, { status: 500 })
      }

      return NextResponse.json({ success: true, enabled: job.enabled })
    }

    if (action === 'trigger') {
      const id = jobId || jobName
      if (!id) {
        return NextResponse.json({ error: 'Job ID required' }, { status: 400 })
      }

      if (process.env.MISSION_CONTROL_ALLOW_COMMAND_TRIGGER !== '1') {
        return NextResponse.json(
          { error: 'Manual triggers disabled. Set MISSION_CONTROL_ALLOW_COMMAND_TRIGGER=1 to enable.' },
          { status: 403 }
        )
      }
      
      const schedulerTask = getSchedulerStatus().find(t => t.id === id || t.name === id)
      if (schedulerTask) {
         const result = await triggerTask(schedulerTask.id)
         return NextResponse.json({
           success: result.ok,
           stdout: result.message,
           stderr: result.ok ? '' : result.message
         }, { status: result.ok ? 200 : 500 })
      }

      const cronFile = await loadCronFile()
      const job = cronFile?.jobs.find(j => j.id === id || j.name === id)
      if (!job) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 })
      }

      // For OpenClaw cron jobs, trigger via the openclaw CLI
      const triggerMode = body.mode || 'force'
      const { runCommand } = await import('@/lib/command')
      try {
        const args = ['cron', 'trigger', job.id]
        if (triggerMode === 'due') {
          args.push('--if-due')
        }
        const { stdout, stderr } = await runCommand(config.openclawBin, args, { timeoutMs: 30000 })

        return NextResponse.json({
          success: true,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        })
      } catch (execError: any) {
        return NextResponse.json({
          success: false,
          error: execError.message,
          stdout: execError.stdout?.trim() || '',
          stderr: execError.stderr?.trim() || ''
        }, { status: 500 })
      }
    }

    if (action === 'update') {
      const id = jobId || jobName
      if (!id) {
        return NextResponse.json({ error: 'Job ID or name required' }, { status: 400 })
      }

      const schedulerTask = getSchedulerStatus().find(t => t.id === id || t.name === id)
      if (schedulerTask) {
        return NextResponse.json({ error: 'Cannot edit built-in scheduler tasks' }, { status: 403 })
      }

      const cronFile = await loadCronFile()
      if (!cronFile) {
        return NextResponse.json({ error: 'Cron file not found' }, { status: 404 })
      }

      const job = cronFile.jobs.find(j => j.id === id || j.name === id)
      if (!job) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 })
      }

      const { schedule, command, model, staggerSeconds } = body
      const requestedName = typeof body.jobName === 'string' ? body.jobName.trim() : ''

      if (requestedName && requestedName !== job.name) {
        const duplicate = cronFile.jobs.find(j => j !== job && j.name === requestedName)
        if (duplicate) {
          return NextResponse.json({ error: 'A job with that name already exists' }, { status: 409 })
        }
        job.name = requestedName
      }

      if (typeof schedule === 'string' && schedule.trim()) {
        job.schedule.expr = schedule.trim()
      }

      if (typeof command === 'string' && command.trim()) {
        job.payload.message = command
      }

      if (model !== undefined) {
        const trimmedModel = typeof model === 'string' ? model.trim() : ''
        if (trimmedModel) {
          job.payload.model = trimmedModel
        } else {
          delete job.payload.model
        }
      }

      if (typeof staggerSeconds === 'number' && Number.isFinite(staggerSeconds)) {
        if (staggerSeconds > 0) {
          job.schedule.staggerMs = staggerSeconds * 1000
        } else {
          delete job.schedule.staggerMs
        }
      }

      job.updatedAtMs = Date.now()

      if (!(await saveCronFile(cronFile))) {
        return NextResponse.json({ error: 'Failed to save cron file' }, { status: 500 })
      }

      return NextResponse.json({ success: true, job: mapOpenClawJob(job) })
    }

    if (action === 'remove') {
      const id = jobId || jobName
      if (!id) {
        return NextResponse.json({ error: 'Job ID or name required' }, { status: 400 })
      }

      const schedulerTask = getSchedulerStatus().find(t => t.id === id || t.name === id)
      if (schedulerTask) {
        return NextResponse.json({ error: 'Cannot remove built-in scheduler tasks' }, { status: 403 })
      }

      const cronFile = await loadCronFile()
      if (!cronFile) {
        return NextResponse.json({ error: 'Cron file not found' }, { status: 404 })
      }

      const idx = cronFile.jobs.findIndex(j => j.id === id || j.name === id)
      if (idx === -1) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 })
      }

      cronFile.jobs.splice(idx, 1)

      if (!(await saveCronFile(cronFile))) {
        return NextResponse.json({ error: 'Failed to save cron file' }, { status: 500 })
      }

      return NextResponse.json({ success: true })
    }

    if (action === 'add') {
      const { schedule, command, model, description, staggerSeconds } = body
      const name = jobName || body.name
      if (!schedule || !command || !name) {
        return NextResponse.json(
          { error: 'Schedule, command, and name required' },
          { status: 400 }
        )
      }

      const cronFile = (await loadCronFile()) || { version: 1, jobs: [] }

      // Prevent duplicates: remove existing jobs with the same name
      cronFile.jobs = cronFile.jobs.filter(j => j.name !== name)

      const newJob: OpenClawCronJob = {
        id: `mc-${Date.now().toString(36)}`,
        agentId: String(process.env.MC_CRON_AGENT_ID || process.env.MC_COORDINATOR_AGENT || 'system'),
        name,
        enabled: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: {
          kind: 'cron',
          expr: schedule,
          ...(typeof staggerSeconds === 'number' && staggerSeconds > 0
            ? { staggerMs: staggerSeconds * 1000 }
            : {}),
        },
        payload: {
          kind: 'agentTurn',
          message: command,
          ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
        },
        delivery: {
          mode: 'none',
        },
        state: {},
      }

      cronFile.jobs.push(newJob)

      if (!(await saveCronFile(cronFile))) {
        return NextResponse.json({ error: 'Failed to save cron file' }, { status: 500 })
      }

      return NextResponse.json({ success: true })
    }

    if (action === 'clone') {
      const id = jobId || jobName
      if (!id) {
        return NextResponse.json({ error: 'Job ID required' }, { status: 400 })
      }

      const cronFile = await loadCronFile()
      if (!cronFile) {
        return NextResponse.json({ error: 'Cron file not found' }, { status: 404 })
      }

      const sourceJob = cronFile.jobs.find(j => j.id === id || j.name === id)
      if (!sourceJob) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 })
      }

      // Generate unique clone name
      const existingNames = new Set(cronFile.jobs.map(j => j.name.toLowerCase()))
      let cloneName = `${sourceJob.name} (copy)`
      let counter = 2
      while (existingNames.has(cloneName.toLowerCase())) {
        cloneName = `${sourceJob.name} (copy ${counter})`
        counter++
      }

      const clonedJob: OpenClawCronJob = {
        ...JSON.parse(JSON.stringify(sourceJob)),
        id: `mc-${Date.now().toString(36)}`,
        name: cloneName,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        state: {},
      }

      cronFile.jobs.push(clonedJob)

      if (!(await saveCronFile(cronFile))) {
        return NextResponse.json({ error: 'Failed to save cron file' }, { status: 500 })
      }

      return NextResponse.json({ success: true, clonedName: cloneName })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    logger.error({ err: error }, 'Cron management error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
