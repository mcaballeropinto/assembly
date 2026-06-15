import { Archive, RotateCcw, Send, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { ApiWorkpieceResponse } from "../../../../src/dashboard-api"
import { getWorkpieceOutcome } from "./drawer-utils"

interface DrawerFooterProps {
  workpiece: ApiWorkpieceResponse
  fileName: string
}

function DisabledAction({
  label,
  icon: Icon,
  variant = "outline",
}: {
  label: string
  icon: LucideIcon
  variant?: "outline" | "secondary" | "destructive"
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button type="button" variant={variant} size="sm" disabled>
            <Icon className="h-4 w-4" />
            {label}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>TODO: Phase 9 will wire this action</TooltipContent>
    </Tooltip>
  )
}

export function DrawerFooter({ workpiece, fileName }: DrawerFooterProps) {
  const outcome = getWorkpieceOutcome(workpiece)
  const source = workpiece._source ?? ""
  const hasFailedStation = Object.values(workpiece.stations ?? {}).some((station) => station.status === "failed")
  const actions: Array<"retry" | "dismiss" | "release"> = []

  if (source === "review" && hasFailedStation) {
    actions.push("dismiss")
  } else if (outcome.state === "failed") {
    actions.push("retry", "dismiss")
  } else if (outcome.state === "inbox" || outcome.state === "held") {
    actions.push("release")
  }

  return (
    <TooltipProvider>
      <div className="border-t p-4">
        <div className="flex items-center justify-end gap-2" aria-label={`Actions for ${fileName}`}>
          {actions.length === 0 ? (
            <div className="text-xs text-muted-foreground">No actions available for this workpiece state</div>
          ) : null}
          {actions.includes("retry") ? <DisabledAction label="Retry" icon={RotateCcw} /> : null}
          {actions.includes("dismiss") ? <DisabledAction label="Dismiss" icon={Archive} variant="secondary" /> : null}
          {actions.includes("release") ? <DisabledAction label="Release" icon={Send} /> : null}
        </div>
      </div>
    </TooltipProvider>
  )
}
