import type { ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { ErrorBanner } from "../banners/error-banner"
import { FetchErrorBanner } from "../banners/fetch-error-banner"
import type { ConnectionChipState } from "../chips/connection-chip"
import type { UsageBucket, UsageState } from "../chips/usage-chip"
import { dismissErrors, fetchUsage, type ApiStateResponse } from "../../lib/api"
import { apiStateQueryOptions } from "../../lib/query"
import { Header } from "./header"
import { Sidebar } from "./sidebar"

export function Shell({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const state = useQuery(apiStateQueryOptions())
  const usage = useQuery({
    queryKey: ["api", "usage"],
    queryFn: fetchUsage,
    refetchInterval: 30000,
    retry: false,
  })
  const dismiss = useMutation({
    mutationFn: ({ lineName, fileNames }: { lineName: string; fileNames: string[] }) =>
      dismissErrors(lineName, fileNames),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["api", "state"] }),
  })
  const connection = connectionProps(state.data)
  const usageProps = usageChipProps(usage.data)
  const bannerErrors = collectBannerErrors(state.data)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header connection={connection} usage={usageProps} />
      <div className="flex min-h-[calc(100vh-3.5rem)]">
        <Sidebar />
        <main className="min-w-0 flex-1 w-full px-4 pb-12 pt-6 sm:px-6 lg:px-8 2xl:px-10">
          <FetchErrorBanner
            error={state.error as Error | null}
            onRetry={() => state.refetch()}
            isRetrying={state.isFetching}
            className="mb-4"
          />
          <ErrorBanner
            errors={bannerErrors}
            className="mb-4"
            onDismiss={(fileNames) => {
              const lineName = bannerErrors.find((item) =>
                fileNames.includes(item.fileName),
              )?.lineName
              if (lineName) dismiss.mutate({ lineName, fileNames })
            }}
          />
          {children}
        </main>
      </div>
    </div>
  )
}

function connectionProps(data: ApiStateResponse | undefined): {
  state: ConnectionChipState
  lastUpdateMs: number | null
} {
  if (!data?.timestamp) return { state: "disconnected", lastUpdateMs: null }
  const age = Math.max(0, Date.now() - Date.parse(data.timestamp))
  if (!Number.isFinite(age)) return { state: "disconnected", lastUpdateMs: null }
  return {
    state: age < 5000 ? "live" : age < 30000 ? "stale" : "disconnected",
    lastUpdateMs: age,
  }
}

function usageChipProps(data: Awaited<ReturnType<typeof fetchUsage>> | undefined) {
  const buckets: UsageBucket[] = [
    ...(data?.providers?.["claude-code"]?.buckets ?? []),
    ...(data?.providers?.codex?.buckets ?? []),
  ]
  const explicit = data?.state === "paused" || data?.paused
    ? "paused"
    : data?.state === "unknown"
      ? "unknown"
      : undefined
  return {
    state: explicit as UsageState | undefined,
    buckets,
    threshold: data?.threshold ?? 75,
    pauseReason: data?.pauseReason ?? data?.reason,
    providerLabel: "Usage",
    checkedAgeMs: data?.ageMs ?? null,
  }
}

function collectBannerErrors(data: ApiStateResponse | undefined) {
  return (data?.lines ?? []).flatMap((line) => {
    const errors = Array.isArray(line.state?.banner_errors)
      ? line.state.banner_errors
      : []
    return errors.flatMap((error) => {
      if (!error || typeof error !== "object") return []
      const record = error as Record<string, unknown>
      const fileName = typeof record.fileName === "string" ? record.fileName : undefined
      if (!fileName) return []
      return [{
        id: typeof record.id === "string" ? record.id : fileName,
        fileName,
        lineName: line.name,
        task: typeof record.task === "string" ? record.task : undefined,
        message: typeof record.message === "string" ? record.message : undefined,
        failed: Array.isArray(record.failed)
          ? record.failed as Array<{ station?: string; error?: string }>
          : undefined,
        severity:
          record.severity === "critical" || record.severity === "warning"
            ? record.severity
            : "warning" as const,
        finished_at: typeof record.finished_at === "string" ? record.finished_at : undefined,
      }]
    })
  })
}
