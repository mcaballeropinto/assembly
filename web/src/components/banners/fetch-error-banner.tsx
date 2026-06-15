import { RefreshCw } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type FetchErrorBannerProps = {
  error: string | Error | null | undefined
  onRetry: () => void | Promise<unknown>
  isRetrying?: boolean
  className?: string
}

function errorMessage(error: string | Error): string {
  return typeof error === "string" ? error : error.message
}

export function FetchErrorBanner({
  error,
  onRetry,
  isRetrying = false,
  className,
}: FetchErrorBannerProps) {
  if (!error) {
    return null
  }

  return (
    <Alert
      variant="default"
      className={cn(
        "flex items-start justify-between gap-4 border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200",
        className
      )}
    >
      <div className="min-w-0 space-y-1">
        <AlertTitle>Dashboard data fetch failed</AlertTitle>
        <AlertDescription>{errorMessage(error)}</AlertDescription>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isRetrying}
        onClick={() => void onRetry()}
        className="shrink-0 border-amber-300 bg-transparent text-amber-950 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-100 dark:hover:bg-amber-950"
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        {isRetrying ? "Retrying" : "Retry"}
      </Button>
    </Alert>
  )
}
