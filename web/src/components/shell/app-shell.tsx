import type { ReactNode } from "react"

import { mockConnectionStates, mockUsageWarn } from "../../lib/dashboard-mock-data"
import { Header } from "./header"

export type AppShellProps = {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header connection={mockConnectionStates.live} usage={mockUsageWarn} />
      <main className="mx-auto max-w-screen-2xl space-y-8 px-6 pb-12 pt-6 lg:px-8">{children}</main>
    </div>
  )
}
