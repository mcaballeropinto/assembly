import { useState, type ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Archive, RotateCcw, Send, Undo2 } from "lucide-react"

import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Card } from "../ui/card"
import {
  dismissErrors,
  releaseAllHeld,
  releaseHeldTask,
  retryErroredWorkpiece,
  undismissErrors,
} from "../../lib/api"
import type { LineWorkpieceRecord } from "../../lib/line-detail"

interface WorkpieceSectionsProps {
  lineName: string
  held: LineWorkpieceRecord[]
  completed: LineWorkpieceRecord[]
  errors: LineWorkpieceRecord[]
  dismissed: LineWorkpieceRecord[]
  reviews: LineWorkpieceRecord[]
  onOpenWorkpiece: (fileName: string) => void
}

export function WorkpieceSections({
  lineName,
  held,
  completed,
  errors,
  dismissed,
  reviews,
  onOpenWorkpiece,
}: WorkpieceSectionsProps) {
  const queryClient = useQueryClient()
  const [confirmReleaseAll, setConfirmReleaseAll] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["api", "state"] })
    queryClient.invalidateQueries({ queryKey: ["line", lineName] })
    queryClient.invalidateQueries({ queryKey: ["line", lineName, "kanban"] })
    queryClient.invalidateQueries({ queryKey: ["workpiece"] })
  }

  const mutationOptions = {
    onSuccess: () => {
      setActionError(null)
      invalidate()
    },
    onError: (error: Error) => setActionError(error.message),
  }

  const releaseOne = useMutation({
    mutationFn: (fileName: string) => releaseHeldTask(lineName, fileName),
    ...mutationOptions,
  })
  const releaseAll = useMutation({
    mutationFn: () => releaseAllHeld(lineName),
    ...mutationOptions,
  })
  const retryOne = useMutation({
    mutationFn: (fileName: string) => retryErroredWorkpiece(lineName, fileName),
    ...mutationOptions,
  })
  const dismissOne = useMutation({
    mutationFn: (fileName: string) => dismissErrors(lineName, [fileName]),
    ...mutationOptions,
  })
  const undismissOne = useMutation({
    mutationFn: (fileName: string) => undismissErrors(lineName, [fileName]),
    ...mutationOptions,
  })

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      {actionError ? (
        <Card className="border-destructive/40 p-4 text-sm text-destructive xl:col-span-2">
          {actionError}
        </Card>
      ) : null}
      <Section
        title={`Held (${held.length})`}
        action={
          held.length > 0 ? (
            confirmReleaseAll ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => releaseAll.mutate()}
                  disabled={releaseAll.isPending}
                >
                  Yes, release all
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmReleaseAll(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConfirmReleaseAll(true)}
              >
                Release all
              </Button>
            )
          ) : null
        }
      >
        {held.map((item) => (
          <Row key={item.fileName} item={item} onOpen={onOpenWorkpiece}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={releaseOne.isPending}
              onClick={(event) => {
                event.stopPropagation()
                releaseOne.mutate(item.fileName)
              }}
            >
              <Send className="h-4 w-4" />
              Release
            </Button>
          </Row>
        ))}
      </Section>

      <Section title={`Recently Completed (${completed.length})`}>
        {completed.map((item) => (
          <Row key={`${item.source}-${item.fileName}`} item={item} onOpen={onOpenWorkpiece} />
        ))}
      </Section>

      <Section title={`Errored (${errors.length} active / ${dismissed.length} dismissed)`}>
        {errors.map((item) => (
          <Row key={item.fileName} item={item} onOpen={onOpenWorkpiece}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={retryOne.isPending}
              onClick={(event) => {
                event.stopPropagation()
                retryOne.mutate(item.fileName)
              }}
            >
              <RotateCcw className="h-4 w-4" />
              Retry
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={dismissOne.isPending}
              onClick={(event) => {
                event.stopPropagation()
                dismissOne.mutate(item.fileName)
              }}
            >
              <Archive className="h-4 w-4" />
              Dismiss
            </Button>
          </Row>
        ))}
        {dismissed.map((item) => (
          <Row key={`dismissed-${item.fileName}`} item={item} onOpen={onOpenWorkpiece}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={undismissOne.isPending}
              onClick={(event) => {
                event.stopPropagation()
                undismissOne.mutate(item.fileName)
              }}
            >
              <Undo2 className="h-4 w-4" />
              Undismiss
            </Button>
          </Row>
        ))}
      </Section>

      <Section title={`Review / Escalated (${reviews.length})`}>
        {reviews.map((item) => (
          <Row key={item.fileName} item={item} onOpen={onOpenWorkpiece} />
        ))}
      </Section>
    </div>
  )
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      <div className="space-y-3">
        {children || (
          <p className="text-sm text-muted-foreground">No workpieces in this section.</p>
        )}
      </div>
    </Card>
  )
}

function Row({
  item,
  children,
  onOpen,
}: {
  item: LineWorkpieceRecord
  children?: ReactNode
  onOpen: (fileName: string) => void
}) {
  return (
    <button
      type="button"
      className="w-full rounded-md border p-3 text-left transition-colors hover:bg-accent"
      onClick={() => onOpen(item.fileName)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{item.id}</span>
            <Badge variant={item.source === "error" ? "destructive" : "secondary"}>
              {item.outcome ?? item.source}
            </Badge>
            {item.failedStation ?? item.escalatedStation ? (
              <Badge variant="outline">{item.failedStation ?? item.escalatedStation}</Badge>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {item.error ?? item.taskPreview}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {item.durationLabel ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {item.durationLabel}
            </span>
          ) : null}
          {children}
        </div>
      </div>
    </button>
  )
}
