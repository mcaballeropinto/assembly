import type { DashboardErrorBannerItem } from "@/components/banners/error-banner"
import type { ConnectionChipProps } from "@/components/chips/connection-chip"
import type { UsageChipProps } from "@/components/chips/usage-chip"

function fromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

export const mockConnectionStates = {
  live: {
    state: "live",
    lastUpdateMs: 8_000,
  },
  stale: {
    state: "stale",
    lastUpdateMs: 4 * 60_000,
  },
  disconnected: {
    state: "disconnected",
    lastUpdateMs: null,
  },
} satisfies Record<string, ConnectionChipProps>

export const mockUsageHealthy: UsageChipProps = {
  providerLabel: "Codex usage",
  checkedAgeMs: 30_000,
  buckets: [
    { label: "Hourly tokens", utilization: 24, resets_at: fromNow(42 * 60_000) },
    { label: "Daily tokens", utilization: 38, resets_at: fromNow(9 * 60 * 60_000) },
  ],
}

export const mockUsageWarn: UsageChipProps = {
  providerLabel: "Codex usage",
  checkedAgeMs: 45_000,
  buckets: [
    { label: "Hourly tokens", utilization: 67, resets_at: fromNow(18 * 60_000) },
    { label: "Daily tokens", utilization: 84, resets_at: fromNow(6 * 60 * 60_000) },
  ],
}

export const mockUsagePaused: UsageChipProps = {
  state: "paused",
  providerLabel: "Codex usage",
  checkedAgeMs: 20_000,
  pauseReason: "Provider pause window is active until the next hourly reset.",
  buckets: [
    { label: "Hourly tokens", utilization: 100, resets_at: fromNow(11 * 60_000) },
    { label: "Daily tokens", utilization: 72, resets_at: fromNow(4 * 60 * 60_000) },
  ],
}

export const mockUsageUnknown: UsageChipProps = {
  providerLabel: "Codex usage",
  checkedAgeMs: null,
  buckets: [],
}

export const mockBannerErrors: DashboardErrorBannerItem[] = [
  {
    id: "critical-1",
    fileName: "FANOUT-dashboard-RESULT.json",
    lineName: "assembly-dev",
    task: "Implement shadcn dashboard chrome",
    message: "Develop station exceeded the critical age threshold.",
    severity: "critical",
    failed: [{ station: "develop", error: "bun test web/src failed" }],
    finished_at: new Date(Date.now() - 35 * 60_000).toISOString(),
  },
  {
    id: "warning-1",
    fileName: "FANOUT-demo-RESULT.json",
    lineName: "hello-world",
    task: "Render demo route samples",
    message: "Visual review is pending.",
    severity: "warning",
    failed: [{ station: "review", error: "Pending approval" }],
    finished_at: new Date(Date.now() - 12 * 60_000).toISOString(),
  },
]

export const mockFetchError = "GET /api/state returned 503 Service Unavailable"

export function noopDismiss(_fileNames: string[]) {}

export function noopRetry() {}
