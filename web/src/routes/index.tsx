import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({
  component: OverviewRoute,
})

function OverviewRoute() {
  return <h1 className="text-xl font-semibold">Overview placeholder</h1>
}
