import type { ReactNode } from "react"

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto max-w-screen-2xl px-6 py-6 lg:px-8">
        {children}
      </main>
    </div>
  )
}
