import { closeWorkpieceSearch, type DashboardSearch } from "../../lib/drawer-url"
import { useNavigate } from "@tanstack/react-router"
import { lazy, Suspense } from "react"

const Sheet = lazy(() =>
  import("../ui/sheet").then((module) => ({ default: module.Sheet })),
)
const SheetContent = lazy(() =>
  import("../ui/sheet").then((module) => ({ default: module.SheetContent })),
)
const SheetDescription = lazy(() =>
  import("../ui/sheet").then((module) => ({
    default: module.SheetDescription,
  })),
)
const SheetHeader = lazy(() =>
  import("../ui/sheet").then((module) => ({ default: module.SheetHeader })),
)
const SheetTitle = lazy(() =>
  import("../ui/sheet").then((module) => ({ default: module.SheetTitle })),
)

export function WorkpieceDrawerPlaceholder({
  search,
}: {
  search: DashboardSearch
}) {
  const navigate = useNavigate()
  const fileName = search.wp

  return (
    <Suspense fallback={null}>
      <Sheet
        open={Boolean(fileName)}
        onOpenChange={(open) => {
          if (!open) {
            void navigate({
              search: ((prev: Record<string, unknown>) => closeWorkpieceSearch(prev)) as never,
              replace: false,
            })
          }
        }}
      >
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>Workpiece drawer placeholder</SheetTitle>
            {fileName ? (
              <SheetDescription>{fileName}</SheetDescription>
            ) : null}
          </SheetHeader>
        </SheetContent>
      </Sheet>
    </Suspense>
  )
}
