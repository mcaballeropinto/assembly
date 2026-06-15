import { Archive, RotateCcw, Send, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  useDismissErrors,
  useReleaseHeld,
  useRetryWorkpiece,
} from "@/hooks/use-dashboard-mutations"
import type { ApiWorkpieceResponse, Workpiece } from "@/lib/api"
import { getWorkpieceOutcome } from "./drawer-utils"

type WorkpieceData = Extract<ApiWorkpieceResponse, Workpiece>

interface DrawerFooterProps {
  workpiece: WorkpieceData
  fileName: string
  lineName: string
  onClose?: () => void
}

function ActionButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  variant = "outline",
}: {
  label: string
  icon: LucideIcon
  onClick: () => void
  disabled?: boolean
  variant?: "outline" | "secondary" | "destructive"
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
      {label.split(" ")[0]}
    </Button>
  )
}

export function DrawerFooter({
  workpiece,
  fileName,
  lineName,
  onClose,
}: DrawerFooterProps) {
  const retry = useRetryWorkpiece(lineName)
  const dismiss = useDismissErrors(lineName)
  const release = useReleaseHeld(lineName)
  const outcome = getWorkpieceOutcome(workpiece)
  const source = workpiece._source ?? ""
  const hasFailedStation = Object.values(workpiece.stations ?? {}).some((station) => station.status === "failed")
  const actions: Array<"retry" | "dismiss" | "release"> = []

  if (source === "review" && hasFailedStation) {
    actions.push("dismiss")
  } else if (outcome.state === "failed") {
    actions.push("retry", "dismiss")
  } else if (source === "held" || outcome.state === "held") {
    actions.push("release")
  }

  return (
    <div className="border-t p-4">
      <div className="flex items-center justify-end gap-2" aria-label={`Actions for ${fileName}`}>
        {actions.length === 0 ? (
          <div className="text-xs text-muted-foreground">No actions available for this workpiece state</div>
        ) : null}
        {actions.includes("retry") ? (
          <ActionButton
            label={`Retry ${fileName}`}
            icon={RotateCcw}
            disabled={retry.isPending}
            onClick={() => {
              retry.mutate(fileName, { onSuccess: onClose })
            }}
          />
        ) : null}
        {actions.includes("dismiss") ? (
          <ActionButton
            label={`Dismiss ${fileName}`}
            icon={Archive}
            variant="secondary"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate([fileName])}
          />
        ) : null}
        {actions.includes("release") ? (
          <ActionButton
            label={`Release ${fileName}`}
            icon={Send}
            disabled={release.isPending}
            onClick={() => {
              release.mutate(fileName, { onSuccess: onClose })
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
