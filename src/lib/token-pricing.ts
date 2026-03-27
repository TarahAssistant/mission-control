import { getProviderFromModel } from '@/lib/provider-subscriptions'

interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok?: number
  cacheReadPerMTok?: number
}

const DEFAULT_MODEL_PRICING: ModelPricing = {
  inputPerMTok: 3.0,
  outputPerMTok: 15.0,
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'anthropic/claude-3-5-haiku-latest': { inputPerMTok: 0.8, outputPerMTok: 4.0, cacheWritePerMTok: 1.0, cacheReadPerMTok: 0.08 },
  'claude-3-5-haiku': { inputPerMTok: 0.8, outputPerMTok: 4.0, cacheWritePerMTok: 1.0, cacheReadPerMTok: 0.08 },
  'anthropic/claude-haiku-4-5': { inputPerMTok: 0.8, outputPerMTok: 4.0, cacheWritePerMTok: 1.0, cacheReadPerMTok: 0.08 },
  'claude-haiku-4-5': { inputPerMTok: 0.8, outputPerMTok: 4.0, cacheWritePerMTok: 1.0, cacheReadPerMTok: 0.08 },

  'anthropic/claude-sonnet-4-20250514': { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 },
  'claude-sonnet-4': { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 },
  'anthropic/claude-sonnet-4-5': { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 },
  'claude-sonnet-4-5': { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 },
  'claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 },
  'anthropic/claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 },
  'claude-3-7-sonnet-latest': { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 },
  'claude-3-5-sonnet-latest': { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 },
  'anthropic/claude-3-5-sonnet-latest': { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 },
  'claude-3-5-sonnet': { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 },
  'claude-opus-4-5': { inputPerMTok: 15.0, outputPerMTok: 75.0, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.50 },
  'anthropic/claude-opus-4-5': { inputPerMTok: 15.0, outputPerMTok: 75.0, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.50 },
  'claude-opus-4-6': { inputPerMTok: 15.0, outputPerMTok: 75.0, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.50 },
  'anthropic/claude-opus-4-6': { inputPerMTok: 15.0, outputPerMTok: 75.0, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.50 },
  'claude-3-opus-latest': { inputPerMTok: 15.0, outputPerMTok: 75.0, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.50 },
  
  'gemini-3-pro-preview': { inputPerMTok: 1.25, outputPerMTok: 5.0, cacheReadPerMTok: 0.3125 },
  'gemini-3-flash-preview': { inputPerMTok: 0.075, outputPerMTok: 0.30, cacheReadPerMTok: 0.01875 },
  'gemini-3.1-pro-preview': { inputPerMTok: 1.25, outputPerMTok: 5.0, cacheReadPerMTok: 0.3125 },
  'gemini-3.1-flash-preview': { inputPerMTok: 0.075, outputPerMTok: 0.30, cacheReadPerMTok: 0.01875 },
  'gemini-3.1-flash-lite-preview': { inputPerMTok: 0.075, outputPerMTok: 0.30, cacheReadPerMTok: 0.01875 },
  'google-gemini-cli/gemini-3-pro-preview': { inputPerMTok: 1.25, outputPerMTok: 5.0, cacheReadPerMTok: 0.3125 },
  'google-gemini-cli/gemini-3-flash-preview': { inputPerMTok: 0.075, outputPerMTok: 0.30, cacheReadPerMTok: 0.01875 },
  'google-gemini-cli/gemini-3.1-pro-preview': { inputPerMTok: 1.25, outputPerMTok: 5.0, cacheReadPerMTok: 0.3125 },
  'google-gemini-cli/gemini-3.1-flash-preview': { inputPerMTok: 0.075, outputPerMTok: 0.30, cacheReadPerMTok: 0.01875 },
  'google-gemini-cli/gemini-3.1-flash-lite-preview': { inputPerMTok: 0.075, outputPerMTok: 0.30, cacheReadPerMTok: 0.01875 },

  'grok-4': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  'xai/grok-4': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  'grok-3': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  'xai/grok-3': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  'grok-2': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  'xai/grok-2': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  'grok-beta': { inputPerMTok: 5.0, outputPerMTok: 15.0 },
  'xai/grok-beta': { inputPerMTok: 5.0, outputPerMTok: 15.0 },
  'grok-vision': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  'xai/grok-vision': { inputPerMTok: 2.0, outputPerMTok: 10.0 },

  'openai/gpt-4o': { inputPerMTok: 2.50, outputPerMTok: 10.0 },
  'openai/o1': { inputPerMTok: 15.0, outputPerMTok: 60.0 },
  'openai/o3-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  'gpt-4o': { inputPerMTok: 2.50, outputPerMTok: 10.0 },
  'o1': { inputPerMTok: 15.0, outputPerMTok: 60.0 },
  'o3-mini': { inputPerMTok: 1.1, outputPerMTok: 4.4 },
  'openai/gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.60 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.60 },
  
  'openai-codex/gpt-5.3-codex': { inputPerMTok: 2.5, outputPerMTok: 10.0 },
  'openai-codex/gpt-5.4-codex': { inputPerMTok: 2.5, outputPerMTok: 10.0 },
  'ollama/qwen2.5-coder:7b': { inputPerMTok: 0.0, outputPerMTok: 0.0 },
  'ollama/qwen2.5-coder:14b': { inputPerMTok: 0.0, outputPerMTok: 0.0 },
  'qwen2.5-coder:7b': { inputPerMTok: 0.0, outputPerMTok: 0.0 },
  'qwen2.5-coder:14b': { inputPerMTok: 0.0, outputPerMTok: 0.0 },
  'qwen3-coder:30b': { inputPerMTok: 0.0, outputPerMTok: 0.0 },
  'ollama/qwen3-coder:30b': { inputPerMTok: 0.0, outputPerMTok: 0.0 },

  // Generic Fallbacks for better matching
  'claude-3': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'gemini-1.5': { inputPerMTok: 1.25, outputPerMTok: 5.0 },
  'gemini-3': { inputPerMTok: 1.25, outputPerMTok: 5.0 },
  'gemini': { inputPerMTok: 0.075, outputPerMTok: 0.30 }, // Default to flash price for safety
  'gpt-4': { inputPerMTok: 2.5, outputPerMTok: 10.0 },
  'gpt': { inputPerMTok: 2.5, outputPerMTok: 10.0 },
  'grok': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
}

function normalizedModelName(modelName: string): string {
  return modelName.trim().toLowerCase()
}

export function getModelPricing(modelName: string): ModelPricing {
  const normalized = normalizedModelName(modelName)
  if (MODEL_PRICING[normalized] !== undefined) return MODEL_PRICING[normalized]

  for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
    const shortName = model.split('/').pop() || model
    if (normalized.includes(shortName)) return pricing
  }

  return DEFAULT_MODEL_PRICING
}

interface CostOptions {
  providerSubscriptions?: Record<string, boolean>
  cacheRead?: number
  cacheWrite?: number
}

export function calculateTokenCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  options?: CostOptions,
): number {
  const provider = getProviderFromModel(modelName)
  if (provider !== 'unknown' && options?.providerSubscriptions?.[provider]) {
    return 0
  }

  const pricing = getModelPricing(modelName)
  const baseCost = (inputTokens * pricing.inputPerMTok) + (outputTokens * pricing.outputPerMTok)
  
  let cacheCost = 0
  if (options?.cacheRead && pricing.cacheReadPerMTok) {
    cacheCost += options.cacheRead * pricing.cacheReadPerMTok
  }
  if (options?.cacheWrite && pricing.cacheWritePerMTok) {
    cacheCost += options.cacheWrite * pricing.cacheWritePerMTok
  }

  return (baseCost + cacheCost) / 1_000_000
}
