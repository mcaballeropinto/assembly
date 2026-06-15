import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type DashboardErrorBannerItem = {
  id?: string
  fileName: string
  lineName?: string
  task?: string
  message?: string
  failed?: Array<{ station?: string; error?: string }>
  severity?: "critical" | "warning" | "suppressed"
  finished_at?: string
}

export type ErrorBannerProps = {
  errors: DashboardErrorBannerItem[]
  onDismiss?: (fileNames: string[]) => void
  className?: string
}

function formatIdentifier(error: DashboardErrorBannerItem): string {
  return error.lineName ? `${error.lineName} / ${error.fileName}` : error.fileName
}

function formatFailedStation(error: DashboardErrorBannerItem): string | null {
  const failed = error.failed?.find((item) => item.station || item.error)
  if (!failed) {
    return null
  }

  return [failed.station, failed.error].filter(Boolean).join(": ")
}

export function ErrorBanner({ errors, onDismiss, className }: ErrorBannerProps) {
  const visibleErrors = errors.filter((error) => error.severity !== "suppressed")
  if (visibleErrors.length === 0) {
    return null
  }

  const firstError = visibleErrors[0]
  const extraCount = visibleErrors.length - 1
  const failedStation = formatFailedStation(firstError)
  const hasCritical = visibleErrors.some((error) => error.severity === "critical")

  return (
    <Alert
      variant="destructive"
      className={cn(
        "relative flex items-start justify-between gap-4",
        hasCritical &&
          "overflow-hidden pl-6 before:absolute before:left-0 before:top-0 before:h-full before:w-1 before:bg-destructive",
        className
      )}
    >
      <div className="min-w-0 space-y-1">
        <AlertTitle>{visibleErrors.length === 1 ? "Active error" : "Active errors"}</AlertTitle>
        <AlertDescription>
          <div className="space-y-1">
            <div className="font-medium">{formatIdentifier(firstError)}</div>
            <div>{firstError.task || firstError.message || "Task failed without a message."}</div>
            {failedStation ? <div className="text-xs opacity-80">{failedStation}</div> : null}
            {extraCount > 0 ? (
              <div className="text-xs text-muted-foreground">+{extraCount} more</div>
            ) : null}
          </div>
        </AlertDescription>
      </div>
      {onDismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Dismiss error banner"
          onClick={() => onDismiss(visibleErrors.map((error) => error.fileName))}
        >
          <span className="text-base leading-none" aria-hidden="true">
            x
          </span>
        </Button>
      ) : null}
    </Alert>
  )
}
