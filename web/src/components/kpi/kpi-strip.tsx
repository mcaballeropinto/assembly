import type { KpiTileProps } from "./kpi-tile"

import { cn } from "../../lib/utils"
import { KpiTile } from "./kpi-tile"

export interface KpiStripProps {
  items: KpiTileProps[]
  className?: string
}

export function KpiStrip({ items, className }: KpiStripProps) {
  return (
    <section
      className={cn("grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-4", className)}
    >
      {items.map((item) => (
        <KpiTile key={item.label} {...item} />
      ))}
    </section>
  )
}
