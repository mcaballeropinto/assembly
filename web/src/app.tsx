import { Header } from "@/components/shell/header"
import { Sidebar } from "@/components/shell/sidebar"

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-screen-2xl px-6 pb-12 pt-6 lg:px-8">
            <div className="space-y-8">
              <section className="rounded-lg border bg-card p-6">
                <h1 className="text-xl font-semibold">Assembly Dashboard</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Shell placeholder until Phase 4 panels are wired.
                </p>
              </section>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
