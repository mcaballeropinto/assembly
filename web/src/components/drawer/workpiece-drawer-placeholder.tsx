import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet"
import { closeWorkpieceSearch, type DashboardSearch } from "../../lib/drawer-url"
import { useNavigate } from "@tanstack/react-router"

export function WorkpieceDrawerPlaceholder({
  search,
}: {
  search: DashboardSearch
}) {
  const navigate = useNavigate()
  const fileName = search.wp

  return (
    <Sheet
      open={Boolean(fileName)}
      onOpenChange={(open) => {
        if (!open) {
          void navigate({
            search: (prev) => closeWorkpieceSearch(prev),
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
  )
}
