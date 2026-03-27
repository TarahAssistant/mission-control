import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getProviderSubscriptionFlags } from '@/lib/provider-subscriptions'
import { logger } from '@/lib/logger'
import { extractAgentName, loadTokenData } from '@/app/api/tokens/route'

interface ModelBreakdown {
  model: string
  input_tokens: number
  output_tokens: number
  request_count: number
  cost: number
}

interface AgentBreakdown {
  agent: string
  total_input_tokens: number
  total_output_tokens: number
  total_tokens: number
  total_cost: number
  session_count: number
  request_count: number
  last_active: string
  models: ModelBreakdown[]
}

interface AgentAccumulator {
  agent: string
  total_input_tokens: number
  total_output_tokens: number
  total_cost: number
  request_count: number
  last_active_ts: number
  sessions: Set<string>
  models: Map<string, ModelBreakdown>
}

/**
 * GET /api/tokens/by-agent - Per-agent cost breakdown from all token sources
 * Query params:
 *   days=N  - Time window in days (default 30)
 *   ignoreSubscriptions=true - do not zero-out subscribed provider costs
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const days = Math.max(1, Math.min(365, Number(searchParams.get('days') || 30)))
    const ignoreSubscriptions = searchParams.get('ignoreSubscriptions') === 'true'
    const workspaceId = auth.user.workspace_id ?? 1

    const cutoffMs = Date.now() - days * 86_400_000
    const providerSubscriptions = ignoreSubscriptions ? {} : getProviderSubscriptionFlags()
    const allRecords = await loadTokenData(workspaceId, providerSubscriptions)
    const records = allRecords.filter((record) => record.timestamp >= cutoffMs)

    const byAgent = new Map<string, AgentAccumulator>()
    for (const record of records) {
      const agentName = record.agentName || extractAgentName(record.sessionId)
      let agent = byAgent.get(agentName)
      if (!agent) {
        agent = {
          agent: agentName,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost: 0,
          request_count: 0,
          last_active_ts: 0,
          sessions: new Set(),
          models: new Map(),
        }
        byAgent.set(agentName, agent)
      }

      agent.total_input_tokens += record.inputTokens
      agent.total_output_tokens += record.outputTokens
      agent.total_cost += record.cost
      agent.request_count += 1
      agent.sessions.add(record.sessionId)
      if (record.timestamp > agent.last_active_ts) {
        agent.last_active_ts = record.timestamp
      }

      let model = agent.models.get(record.model)
      if (!model) {
        model = {
          model: record.model,
          input_tokens: 0,
          output_tokens: 0,
          request_count: 0,
          cost: 0,
        }
        agent.models.set(record.model, model)
      }
      model.input_tokens += record.inputTokens
      model.output_tokens += record.outputTokens
      model.request_count += 1
      model.cost += record.cost
    }

    const agents: AgentBreakdown[] = [...byAgent.values()]
      .map((agent) => {
        const models = [...agent.models.values()].sort((a, b) => {
          if (b.cost !== a.cost) return b.cost - a.cost
          return (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens)
        })
        return {
          agent: agent.agent,
          total_input_tokens: agent.total_input_tokens,
          total_output_tokens: agent.total_output_tokens,
          total_tokens: agent.total_input_tokens + agent.total_output_tokens,
          total_cost: agent.total_cost,
          session_count: agent.sessions.size,
          request_count: agent.request_count,
          last_active: new Date(agent.last_active_ts || 0).toISOString(),
          models,
        }
      })
      .sort((a, b) => {
        if (b.total_tokens !== a.total_tokens) return b.total_tokens - a.total_tokens
        return b.total_cost - a.total_cost
      })

    const totalCost = agents.reduce((sum, a) => sum + a.total_cost, 0)
    const totalTokens = agents.reduce((sum, a) => sum + a.total_tokens, 0)

    return NextResponse.json({
      agents,
      summary: {
        total_cost: totalCost,
        total_tokens: totalTokens,
        agent_count: agents.length,
        days,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tokens/by-agent error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
