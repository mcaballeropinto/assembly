import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Archive, RotateCcw, Send } from "lucide-react"

import { Button } from "../ui/button"
import {
  dismissErrors,
  releaseHeldTask,
  retryErroredWorkpiece,
} from "../../lib/api"
import type { ApiWorkpieceResponse } from "../../../../src/dashboard-api"
import type { Workpiece } from "../../../../src/types"
import { getWorkpieceOutcome } from "./drawer-utils"

type WorkpieceData = Extract<ApiWorkpieceResponse, Workpiece>

interface DrawerFooterProps {
  lineName: string
  workpiece: WorkpieceData
  fileName: string
  onClose?: () => void
}

export function DrawerFooter({
  lineName,
  workpiece,
  fileName,
  onClose,
}: DrawerFooterProps) {
  const queryClient = useQueryClient()
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const outcome = getWorkpieceOutcome(workpiece)
  const source = workpiece._source ?? ""
  const hasFailedStation = Object.values(workpiece.stations ?? {}).some(
    (station) => station.status === "failed",
  )

  useEffect(() => {
    if (!confirmDismiss) return
    const timeout = window.setTimeout(() => setConfirmDismiss(false), 4000)
    return () => window.clearTimeout(timeout)
  }, [confirmDismiss])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["api", "state"] })
    queryClient.invalidateQueries({ queryKey: ["line", lineName] })
    queryClient.invalidateQueries({ queryKey: ["line", lineName, "kanban"] })
    queryClient.invalidateQueries({ queryKey: ["workpiece", lineName, fileName] })
  }

  const retry = useMutation({
    mutationFn: () => retryErroredWorkpiece(lineName, fileName),
    onSuccess: () => {
      setActionError(null)
      invalidate()
      onClose?.()
    },
    onError: (error: Error) => setActionError(error.message),
  })
  const dismiss = useMutation({
    mutationFn: () => dismissErrors(lineName, [fileName]),
    onSuccess: () => {
      setActionError(null)
      invalidate()
      onClose?.()
    },
    onError: (error: Error) => setActionError(error.message),
  })
  const release = useMutation({
    mutationFn: () => releaseHeldTask(lineName, fileName),
    onSuccess: () => {
      setActionError(null)
      invalidate()
      onClose?.()
    },
    onError: (error: Error) => setActionError(error.message),
  })

  const canRetry = outcome.state === "failed"
  const canDismiss = canRetry || (source === "review" && hasFailedStation)
  const canRelease = outcome.state === "inbox" || outcome.state === "held"

  return (
    <div className="border-t p-4">
      {actionError ? (
        <p className="mb-3 text-sm text-destructive">{actionError}</p>
      ) : null}
      <div className="flex items-center justify-end gap-2" aria-label={`Actions for ${fileName}`}>
        {!canRetry && !canDismiss && !canRelease ? (
          <div className="text-xs text-muted-foreground">
            No actions available for this workpiece state
          </div>
        ) : null}
        {canRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
          >
            <RotateCcw className="h-4 w-4" />
            {retry.isPending ? "Retrying..." : "Retry"}
          </Button>
        ) : null}
        {canDismiss ? (
          <Button
            type="button"
            variant={confirmDismiss ? "destructive" : "secondary"}
            size="sm"
            disabled={dismiss.isPending}
            onClick={() => {
              if (!confirmDismiss) {
                setConfirmDismiss(true)
                return
              }
              dismiss.mutate()
            }}
          >
            <Archive className="h-4 w-4" />
            {dismiss.isPending
              ? "Dismissing..."
              : confirmDismiss
                ? "Click again to confirm"
                : "Dismiss"}
          </Button>
        ) : null}
        {canRelease ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={release.isPending}
            onClick={() => release.mutate()}
          >
            <Send className="h-4 w-4" />
            {release.isPending ? "Releasing..." : "Release"}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
