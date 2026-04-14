type HealthCheckStatus = 'healthy' | 'warning'

export type GatewayChannelHealthCheck = {
  name: string
  status: HealthCheckStatus
  message: string
} | null

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function formatDiscordAccountLabel(account: Record<string, unknown>): string {
  const name = readString(account.name)?.trim()
  if (name) return name
  return readString(account.accountId)?.trim() || 'default'
}

export function deriveDiscordTransportHealthCheck(payload: unknown): GatewayChannelHealthCheck {
  const parsed = asRecord(payload)
  const channelAccounts = asRecord(parsed?.channelAccounts)
  const rawAccounts = channelAccounts?.discord
  if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) {
    return null
  }

  const accounts = rawAccounts
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .filter((account) => readBoolean(account.configured) !== false)

  if (accounts.length === 0) {
    return null
  }

  const failing = accounts.find((account) => {
    const connected = readBoolean(account.connected)
    const running = readBoolean(account.running)
    const lastError = readString(account.lastError)?.trim()
    return connected === false || (running === true && Boolean(lastError))
  })

  if (failing) {
    const label = formatDiscordAccountLabel(failing)
    const lastError = readString(failing.lastError)?.trim()
    const reason = lastError || 'transport disconnected'
    return {
      name: 'Discord Transport',
      status: 'warning',
      message: `Discord account ${label} degraded: ${reason}`,
    }
  }

  return {
    name: 'Discord Transport',
    status: 'healthy',
    message: `Discord transport healthy (${accounts.length} account${accounts.length === 1 ? '' : 's'})`,
  }
}
