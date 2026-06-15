import { useRouterState } from "@tanstack/react-router"

import {
  ConnectionChip,
  type ConnectionChipProps,
} from "@/components/chips/connection-chip"
import { UsageChip, type UsageChipProps } from "@/components/chips/usage-chip"
import { Badge } from "../ui/badge"

export type HeaderProps = {
  connection?: ConnectionChipProps
  usage?: UsageChipProps
}

export function getBreadcrumb(pathname: string): string {
  if (pathname === "/") {
    return "Overview"
  }

  if (pathname.startsWith("/line/")) {
    const lineName = pathname.split("/")[2]

    if (lineName) {
      try {
        return `Line: ${decodeURIComponent(lineName)}`
      } catch {
        return `Line: ${lineName}`
      }
    }
  }

  return "Overview"
}

export function Header({ connection, usage }: HeaderProps) {
  const breadcrumb = useRouterState({
    select: (state) => getBreadcrumb(state.location.pathname),
  })

  return (
    <header className="sticky top-0 z-40 h-14 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-full max-w-screen-2xl items-center justify-between gap-4 px-6 lg:px-8">
        <div className="min-w-0 truncate text-sm font-medium text-foreground">
          {breadcrumb}
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          {connection ? (
            <ConnectionChip {...connection} />
          ) : (
            <Badge variant="outline">TODO connection</Badge>
          )}
          {usage ? (
            <UsageChip {...usage} />
          ) : (
            <Badge variant="outline">TODO usage</Badge>
          )}
          <Badge variant="outline">TODO theme</Badge>
        </div>
      </div>
    </header>
  )
}
