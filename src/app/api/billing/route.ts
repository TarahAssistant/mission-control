import { NextResponse, NextRequest } from 'next/server'
import { requireRole } from '@/lib/auth'
import { detectProviderSubscriptions } from '@/lib/provider-subscriptions'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { logger } from '@/lib/logger'
import { execSync } from 'child_process'

export const dynamic = 'force-dynamic'

// In-memory cache for billing responses to avoid hammering provider APIs
const billingCache: Record<string, { data: any; ts: number }> = {}
const BILLING_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// Claude Code OAuth config (from claude-code source)
const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/**
 * Refresh the Anthropic OAuth access token using the refresh token.
 * Claude Code refreshes tokens at runtime but doesn't persist the new access token
 * back to ~/.claude/.credentials.json, so the file goes stale after ~8 hours.
 * We refresh it ourselves and write it back so subsequent reads get a valid token.
 */
async function refreshClaudeOAuthToken(credsPath: string, creds: any): Promise<string | null> {
  const refreshToken = creds?.claudeAiOauth?.refreshToken
  if (!refreshToken) return null

  try {
    const res = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }).toString(),
    })

    if (!res.ok) {
      logger.warn({ status: res.status }, 'Failed to refresh Anthropic OAuth token')
      return null
    }

    const data = await res.json()
    const newAccessToken = data.access_token
    const expiresIn = data.expires_in || 28800 // default 8h

    if (!newAccessToken) return null

    // Persist the refreshed token back to the credentials file
    creds.claudeAiOauth.accessToken = newAccessToken
    creds.claudeAiOauth.expiresAt = Date.now() + expiresIn * 1000
    if (data.refresh_token) {
      creds.claudeAiOauth.refreshToken = data.refresh_token
    }
    fs.writeFileSync(credsPath, JSON.stringify(creds, null, 4), 'utf8')
    logger.info('Refreshed Anthropic OAuth token and persisted to credentials file')

    return newAccessToken
  } catch (e) {
    logger.error({ err: e }, 'Error refreshing Anthropic OAuth token')
    return null
  }
}

async function getClaudeUsage() {
  const cacheKey = 'anthropic'
  const cached = billingCache[cacheKey]

  try {
    const credsPath = path.join(os.homedir(), '.claude', '.credentials.json')
    if (!fs.existsSync(credsPath)) return null
    
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))

    // Return cached response if fresh enough
    if (cached && (Date.now() - cached.ts) < BILLING_CACHE_TTL_MS) {
      return cached.data
    }

    // Check if the access token is expired and refresh if needed
    let token = creds?.claudeAiOauth?.accessToken
    const expiresAt = creds?.claudeAiOauth?.expiresAt || 0
    if (!token || (expiresAt > 0 && Date.now() > expiresAt)) {
      logger.info('Anthropic OAuth token expired, attempting refresh...')
      const refreshed = await refreshClaudeOAuthToken(credsPath, creds)
      if (refreshed) {
        token = refreshed
      } else {
        // Fallback: try the Anthropic token from OpenCode's auth.json (separate OAuth session)
        try {
          const openCodeAuthPath = path.join(os.homedir(), '.local/share/opencode', 'auth.json')
          if (fs.existsSync(openCodeAuthPath)) {
            const openCodeAuth = JSON.parse(fs.readFileSync(openCodeAuthPath, 'utf8'))
            const ocToken = openCodeAuth?.anthropic?.access
            const ocExpires = openCodeAuth?.anthropic?.expires || 0
            if (ocToken && (ocExpires === 0 || Date.now() < ocExpires)) {
              logger.info('Using Anthropic token from OpenCode auth as fallback')
              token = ocToken
            }
          }
        } catch {}

        if (!token) {
          return { provider: 'anthropic', cost: 0, status: 'Token Refresh Failed', raw: null }
        }
      }
    }

    // For OAuth tokens (used by Claude Max/Pro CLI), we must use the undocumented /oauth/usage endpoint.
    // It returns utilization percentages rather than raw cost, but it's the only one that works for consumer accounts.
    const usageRes = await fetch(`https://api.anthropic.com/api/oauth/usage`, {
      headers: { 
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'openclaw',
        'Accept': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20'
      }
    })
    
    if (!usageRes.ok) {
       const status = usageRes.status
       const err = await usageRes.json().catch(() => null)

       // On rate limit (429), return cached data if available instead of showing an error
       if (status === 429 && cached) {
         logger.warn('Anthropic usage API rate limited, returning cached data')
         return { ...cached.data, _cached: true }
       }

       // If we get a 401/403 after refresh, the refresh token itself may be invalid
       if ((status === 401 || status === 403) && creds?.claudeAiOauth?.refreshToken) {
         return { provider: 'anthropic', cost: 0, status: 'API Access Restricted / Expired', raw: err }
       }

       return { provider: 'anthropic', cost: 0, status: status === 429 ? 'Rate Limited (will retry)' : 'API Access Restricted / Expired', raw: err }
    }
    
    const usage = await usageRes.json()
    const result = { provider: 'anthropic', cost: 0, raw: usage }
    billingCache[cacheKey] = { data: result, ts: Date.now() }
    return result
  } catch (e) {
    logger.error({ err: e }, 'Failed to fetch Claude billing')
    // Return stale cache on error rather than showing nothing
    if (cached) return { ...cached.data, _cached: true }
    return null
  }
}

async function refreshGeminiTokenIfNeeded(auth: any, authPath: string) {
  if (auth?.google?.expires && auth.google.expires < Date.now()) {
    try {
      const script = `
        const { refreshAccessToken } = require('${path.join(os.homedir(), '.cache/opencode/node_modules/opencode-gemini-auth/src/plugin/token.ts')}');
        const fs = require('fs');
        const auth = JSON.parse(fs.readFileSync('${authPath}', 'utf8'));
        const authRecord = { type: 'oauth', access: auth.google.access, refresh: auth.google.refresh, expires: auth.google.expires };
        const client = { store: { get: () => auth, set: (k, v) => fs.writeFileSync('${authPath}', JSON.stringify(v, null, 2)) } };
        refreshAccessToken(authRecord, client).then(res => {
          if (res) {
            auth.google = { ...auth.google, ...res };
            fs.writeFileSync('${authPath}', JSON.stringify(auth, null, 2));
            console.log('REFRESHED');
          }
        });
      `;
      execSync(`npx tsx -e "${script.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
      return JSON.parse(fs.readFileSync(authPath, 'utf8'));
    } catch (e) {
      logger.error('Failed to auto-refresh Gemini token');
    }
  }
  return auth;
}

async function getGeminiUsage() {
  const cacheKey = 'google'
  const cached = billingCache[cacheKey]

  try {
    // Return cached response if fresh enough
    if (cached && (Date.now() - cached.ts) < BILLING_CACHE_TTL_MS) {
      return cached.data
    }

    const authPath = path.join(os.homedir(), '.local/share/opencode/auth.json')
    if (!fs.existsSync(authPath)) return null
    
    let auth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
    auth = await refreshGeminiTokenIfNeeded(auth, authPath)
    
    const token = auth?.google?.access
    const project = auth?.google?.refresh?.split('||')[1] || 'certain-drake-44n29'
    
    if (!token) return null

    // Query cloudaicompanion directly, mimicking opencode gemini_quota
    const res = await fetch(`https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'gemini-cli/1.0.0',
        'X-Goog-Api-Client': 'gl-node/1.0.0'
      },
      body: JSON.stringify({ project })
    })
    
    if (!res.ok) {
       const status = res.status
       const err = await res.json().catch(() => null)
       if (status === 429 && cached) {
         logger.warn('Gemini usage API rate limited, returning cached data')
         return { ...cached.data, _cached: true }
       }
       return { provider: 'google', cost: 0, status: 'Token Expired', raw: err }
    }
    const quota = await res.json()
    const result = { provider: 'google', cost: 0, raw: quota }
    billingCache[cacheKey] = { data: result, ts: Date.now() }
    return result
  } catch (e) {
    logger.error({ err: e }, 'Failed to fetch Gemini billing')
    if (cached) return { ...cached.data, _cached: true }
    return null
  }
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const [claude, gemini] = await Promise.all([
      getClaudeUsage(),
      getGeminiUsage()
    ])

    // Include detected subscription types for display (use cache, no need to force-refresh)
    const subs = detectProviderSubscriptions()

    return NextResponse.json({
      success: true,
      providers: {
        anthropic: claude,
        google: gemini
      },
      subscriptions: Object.fromEntries(
        Object.entries(subs.active).map(([k, v]) => [k, { type: v.type, source: v.source }])
      )
    })
  } catch (error) {
    logger.error({ err: error }, 'Failed to load true billing data')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
