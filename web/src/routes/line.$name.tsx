import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/line/$name")({
  component: LineDetailRoute,
})

function LineDetailRoute() {
  const { name } = Route.useParams()

  return (
    <h1 className="text-xl font-semibold">
      Line detail placeholder: {name}
    </h1>
  )
}
