import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { fetchApiState } from "../../lib/api"
import { cn } from "../../lib/utils"

import type { ApiStateLineEntry } from "../../../../src/dashboard-api"

export const SIDEBAR_COLLAPSE_STORAGE_KEY =
  "assembly-dashboard-sidebar-collapsed"
export const STATE_REFETCH_INTERVAL_MS = 30000

function readStoredCollapsedState(): boolean {
  if (typeof window === "undefined") {
    return false
  }

  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

function getInboxCount(line: ApiStateLineEntry): number {
  return line.state?.lineQueue.inbox ?? 0
}

function getStatusDotClass(line: ApiStateLineEntry): string {
  if (line.status === "running") {
    return "bg-emerald-600 dark:bg-emerald-500"
  }

  if (line.status === "error") {
    return "bg-destructive"
  }

  return "bg-muted-foreground"
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(readStoredCollapsedState)
  const { data, isError, isLoading } = useQuery({
    queryKey: ["dashboard-state"],
    queryFn: fetchApiState,
    refetchInterval: STATE_REFETCH_INTERVAL_MS,
    retry: false,
  })

  const lines = useMemo(
    () => [...(data?.lines ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [data?.lines],
  )

  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }

    try {
      window.localStorage.setItem(
        SIDEBAR_COLLAPSE_STORAGE_KEY,
        String(collapsed),
      )
    } catch {
      // Storage can be unavailable in restricted browser contexts.
    }
  }, [collapsed])

  return (
    <aside
      className={cn(
        "min-h-screen shrink-0 border-r bg-background",
        collapsed ? "w-16" : "w-64",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center border-b px-4",
          collapsed ? "justify-center" : "justify-end",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((current) => !current)}
        >
          <span aria-hidden="true">{collapsed ? ">" : "<"}</span>
        </Button>
      </div>

      <nav className="space-y-2 p-2" aria-label="Assembly lines">
        {isLoading ? (
          <SidebarMessage collapsed={collapsed}>Loading lines</SidebarMessage>
        ) : null}
        {isError ? (
          <SidebarMessage collapsed={collapsed} destructive>
            Unable to load lines
          </SidebarMessage>
        ) : null}
        {!isLoading && !isError && lines.length === 0 ? (
          <SidebarMessage collapsed={collapsed}>No lines</SidebarMessage>
        ) : null}
        {!isError
          ? lines.map((line) => (
              <a
                key={line.name}
                href={`/line/${encodeURIComponent(line.name)}`}
                aria-label={collapsed ? line.name : undefined}
                className={cn(
                  "flex items-center rounded-md p-3 text-sm hover:bg-accent hover:text-accent-foreground",
                  collapsed ? "justify-center" : "gap-3",
                )}
              >
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    getStatusDotClass(line),
                  )}
                  aria-hidden="true"
                />
                {!collapsed ? (
                  <>
                    <span className="min-w-0 flex-1 truncate">{line.name}</span>
                    <Badge variant="secondary">{getInboxCount(line)}</Badge>
                  </>
                ) : null}
              </a>
            ))
          : null}
      </nav>
    </aside>
  )
}

function SidebarMessage({
  children,
  collapsed,
  destructive = false,
}: {
  children: string
  collapsed: boolean
  destructive?: boolean
}) {
  return (
    <div
      className={cn(
        "rounded-md p-3 text-xs",
        destructive ? "text-destructive" : "text-muted-foreground",
        collapsed ? "sr-only" : undefined,
      )}
    >
      {children}
    </div>
  )
}
