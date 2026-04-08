import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { config } from '@/lib/config'

interface ProviderSubscription {
  provider: string
  type: string
  source: 'env' | 'file'
}

interface SubscriptionDetectionResult {
  active: Record<string, ProviderSubscription>
}

const NEGATIVE_TYPES = new Set(['none', 'no', 'false', 'free', 'unknown', 'api_key', 'apikey'])

const OPENAI_CREDENTIAL_PATHS = [
  path.join(os.homedir(), '.config', 'openai', 'auth.json'),
  path.join(os.homedir(), '.openai', 'auth.json'),
  path.join(os.homedir(), '.codex', 'auth.json'),
]

let detectionCache: { ts: number; value: SubscriptionDetectionResult } | null = null
const CACHE_TTL_MS = 30_000

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase()
}

function normalizeType(value: string): string {
  return value.trim().toLowerCase()
}

function isPositiveSubscription(type: string): boolean {
  if (!type) return false
  return !NEGATIVE_TYPES.has(normalizeType(type))
}

function parseJsonFile(filePath: string): unknown | null {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function findNestedString(root: unknown, keys: string[]): string | null {
  const queue: unknown[] = [root]
  const wanted = new Set(keys.map(k => k.toLowerCase()))

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      for (const item of current) queue.push(item)
      continue
    }

    for (const [rawKey, value] of Object.entries(current)) {
      const key = rawKey.toLowerCase()
      if (wanted.has(key) && typeof value === 'string' && value.trim()) {
        return value.trim()
      }
      if (value && typeof value === 'object') queue.push(value)
    }
  }

  return null
}

function detectAnthropicFromFile(): ProviderSubscription | null {
  const credsPath = path.join(config.claudeHome, '.credentials.json')
  const creds = parseJsonFile(credsPath) as Record<string, unknown> | null
  if (!creds || typeof creds !== 'object') return null

  const oauth = creds.claudeAiOauth as Record<string, unknown> | undefined
  const subscriptionType = typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : ''
  if (!isPositiveSubscription(subscriptionType)) return null

  return {
    provider: 'anthropic',
    type: normalizeType(subscriptionType),
    source: 'file',
  }
}

function detectOpenAIFromFile(): ProviderSubscription | null {
  for (const credsPath of OPENAI_CREDENTIAL_PATHS) {
    const creds = parseJsonFile(credsPath)
    if (!creds) continue
    const plan = findNestedString(creds, [
      'subscriptionType',
      'subscription_type',
      'accountPlan',
      'account_plan',
      'plan',
      'tier',
    ])
    if (!plan || !isPositiveSubscription(plan)) continue
    return {
      provider: 'openai',
      type: normalizeType(plan),
      source: 'file',
    }
  }
  return null
}

function detectFromEnv(): Record<string, ProviderSubscription> {
  const active: Record<string, ProviderSubscription> = {}

  const allProvidersRaw = process.env.MC_SUBSCRIBED_PROVIDERS || ''
  if (allProvidersRaw.trim()) {
    for (const raw of allProvidersRaw.split(',')) {
      const provider = normalizeProvider(raw)
      if (!provider) continue
      active[provider] = {
        provider,
        type: 'subscription',
        source: 'env',
      }
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue

    const explicitMatch = key.match(/^MC_([A-Z0-9_]+)_SUBSCRIPTION(?:_TYPE)?$/)
    if (explicitMatch) {
      const provider = normalizeProvider(explicitMatch[1].replace(/_/g, '-'))
      const type = normalizeType(value)
      if (isPositiveSubscription(type)) {
        active[provider] = { provider, type, source: 'env' }
      } else {
        delete active[provider]
      }
      continue
    }

    const providerMatch = key.match(/^([A-Z0-9_]+)_SUBSCRIPTION_TYPE$/)
    if (providerMatch) {
      const provider = normalizeProvider(providerMatch[1].replace(/_/g, '-'))
      const type = normalizeType(value)
      if (isPositiveSubscription(type)) {
        active[provider] = { provider, type, source: 'env' }
      } else {
        delete active[provider]
      }
    }
  }

  return active
}

function detectXAISubscription(): ProviderSubscription | null {
  // xAI subscription detection — IMPORTANT: API key access is PAY-PER-USE,
  // not a free subscription. Only OAuth-based access should be treated as subscribed.
  
  // Check env vars for explicit subscription type override
  const xaiSubType = process.env.XAI_SUBSCRIPTION_TYPE || process.env.MC_XAI_SUBSCRIPTION_TYPE
  if (xaiSubType && isPositiveSubscription(xaiSubType)) {
    return { provider: 'xai', type: normalizeType(xaiSubType), source: 'env' }
  }

  // Check OpenCode auth for OAuth-based xAI access (would be free/subscribed)
  // Note: this is already handled by detectFromOpenCodeAuth(), so we only
  // need to check OpenClaw config here.

  // Check OpenClaw config for xAI provider auth
  try {
    const openclawConfigPath = path.join(config.openclawStateDir, 'openclaw.json')
    const openclawConfig = parseJsonFile(openclawConfigPath) as Record<string, any> | null
    if (openclawConfig) {
      const xaiProfile = openclawConfig?.auth?.profiles?.['xai:default']
      if (xaiProfile?.provider === 'xai') {
        // Only treat OAuth-based access as a subscription.
        // API key mode = pay-per-use, should NOT zero out costs.
        if (xaiProfile.mode === 'oauth') {
          return { provider: 'xai', type: 'oauth', source: 'file' }
        }
        // api_key mode — detected but NOT a subscription (costs apply)
        return null
      }
    }
  } catch {}

  // An API key in env means xAI is available but NOT free — don't return a subscription
  // (We still want the provider to appear in the system, just not as "subscribed")
  return null
}

function detectFromOpenCodeAuth(): Record<string, ProviderSubscription> {
  const authPath = path.join(os.homedir(), '.local/share/opencode', 'auth.json')
  const auth = parseJsonFile(authPath) as Record<string, any> | null
  if (!auth) return {}

  const active: Record<string, ProviderSubscription> = {}
  
  // If the user has authenticated via OAuth in OpenCode, we treat those providers as subscribed/free-access
  if (auth.google && (auth.google.access || auth.google.refresh)) {
    active.google = { provider: 'google', type: 'oauth', source: 'file' }
  }
  if (auth.anthropic && (auth.anthropic.access || auth.anthropic.refresh)) {
    active.anthropic = { provider: 'anthropic', type: 'oauth', source: 'file' }
  }
  if (auth.openai && (auth.openai.access || auth.openai.refresh)) {
    active.openai = { provider: 'openai', type: 'oauth', source: 'file' }
  }
  if (auth.xai && (auth.xai.access || auth.xai.refresh)) {
    // Only treat OAuth-based xAI access as subscribed (free).
    // API key access is pay-per-use and should NOT be treated as a subscription.
    active.xai = { provider: 'xai', type: 'oauth', source: 'file' }
  }
  
  return active
}

export function detectProviderSubscriptions(forceRefresh = false): SubscriptionDetectionResult {
  const now = Date.now()
  if (!forceRefresh && detectionCache && (now - detectionCache.ts) < CACHE_TTL_MS) {
    return detectionCache.value
  }

  const active = detectFromEnv()

  // Merge subscriptions from OpenCode auth
  const opencode = detectFromOpenCodeAuth()
  Object.assign(active, opencode)

  const anthropic = detectAnthropicFromFile()
  if (anthropic) active.anthropic = anthropic

  const openai = detectOpenAIFromFile()
  if (openai) active.openai = openai

  // xAI/Grok: detect from env var, OpenCode auth, or OpenClaw config
  const xai = detectXAISubscription()
  if (xai && !active.xai) active.xai = xai

  const value = { active }
  detectionCache = { ts: now, value }
  return value
}

export function getProviderSubscriptionFlags(forceRefresh = false): Record<string, boolean> {
  const detected = detectProviderSubscriptions(forceRefresh)
  return Object.fromEntries(
    Object.keys(detected.active).map((provider) => [provider, true])
  )
}

export function getPrimarySubscription(forceRefresh = false): ProviderSubscription | null {
  const detected = detectProviderSubscriptions(forceRefresh).active
  return detected.anthropic || detected.openai || Object.values(detected)[0] || null
}

export function getProviderFromModel(modelName: string): string {
  const normalized = modelName.trim().toLowerCase()
  if (!normalized) return 'unknown'

  const [prefix] = normalized.split('/')
  
  if (normalized.includes('claude')) return 'anthropic'
  if (normalized.includes('gpt') || normalized.includes('codex') || normalized.includes('o1') || normalized.includes('o3')) return 'openai'
  if (normalized.includes('gemini')) return 'google'
  if (normalized.includes('grok')) return 'xai'

  if (prefix && !prefix.includes(':')) {
    // Most models are provider-prefixed, e.g., "anthropic/claude-sonnet-4-5".
    return prefix
  }

  return 'unknown'
}
