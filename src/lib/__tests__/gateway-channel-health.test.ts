import { describe, expect, it } from 'vitest'
import { deriveDiscordTransportHealthCheck } from '../gateway-channel-health'

describe('deriveDiscordTransportHealthCheck', () => {
  it('returns null when no discord accounts are present', () => {
    expect(deriveDiscordTransportHealthCheck({ channelAccounts: {} })).toBeNull()
  })

  it('returns healthy when configured discord accounts are connected', () => {
    expect(
      deriveDiscordTransportHealthCheck({
        channelAccounts: {
          discord: [
            {
              accountId: 'default',
              configured: true,
              running: true,
              connected: true,
              lastError: null,
            },
          ],
        },
      }),
    ).toEqual({
      name: 'Discord Transport',
      status: 'healthy',
      message: 'Discord transport healthy (1 account)',
    })
  })

  it('returns warning when a configured discord account is disconnected or has a runtime error', () => {
    expect(
      deriveDiscordTransportHealthCheck({
        channelAccounts: {
          discord: [
            {
              accountId: 'default',
              configured: true,
              running: true,
              connected: false,
              lastError: 'WebSocket was closed before the connection was established',
            },
          ],
        },
      }),
    ).toEqual({
      name: 'Discord Transport',
      status: 'warning',
      message: 'Discord account default degraded: WebSocket was closed before the connection was established',
    })
  })
})
