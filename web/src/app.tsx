import { OverviewRoute } from "@/routes"

export function App() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-screen-2xl px-6 py-6 lg:px-8">
        <OverviewRoute />
      </div>
    </main>
  )
}

export default App
