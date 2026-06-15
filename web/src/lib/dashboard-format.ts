export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.min(100, Math.max(0, value))
}

export function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "now"
  }

  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) {
    return `${Math.max(1, seconds)}s`
  }

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  }

  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

export function formatLastUpdate(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return "not connected"
  }

  if (ms < 1000) {
    return "just now"
  }

  return `${formatDurationShort(ms)} ago`
}

export function formatResetShort(iso: string | null, now = Date.now()): string {
  if (!iso) {
    return "reset unknown"
  }

  const resetAt = Date.parse(iso)
  if (!Number.isFinite(resetAt)) {
    return "reset unknown"
  }

  const diff = resetAt - now
  if (diff <= 0) {
    return "resets now"
  }

  if (diff < 60_000) {
    return "resets <1m"
  }

  return `resets ${formatDurationShort(diff)}`
}

export type ResetBucket = {
  resets_at: string | null
}

export function findSoonestReset(buckets: ResetBucket[]): string | null {
  let soonest: string | null = null
  let soonestTime = Number.POSITIVE_INFINITY

  for (const bucket of buckets) {
    if (!bucket.resets_at) {
      continue
    }

    const resetTime = Date.parse(bucket.resets_at)
    if (!Number.isFinite(resetTime)) {
      continue
    }

    if (resetTime < soonestTime) {
      soonest = bucket.resets_at
      soonestTime = resetTime
    }
  }

  return soonest
}
