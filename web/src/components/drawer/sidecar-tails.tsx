import { useQuery } from "@tanstack/react-query"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fetchWorkpieceSidecars } from "@/lib/api"
import type { ApiSidecarTail } from "@/lib/api-types"

interface SidecarTailsProps {
  lineName: string
  fileName: string
}

function SidecarPre({ label, tail }: { label: string; tail?: ApiSidecarTail }) {
  const text = tail?.exists
    ? `${tail.truncated ? `[truncated to last ${tail.content.length} bytes]\n` : ""}${tail.content || `No ${label} content`}`
    : `No ${label} sidecar found`

  return (
    <pre className="h-[400px] overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs">
      {text}
    </pre>
  )
}

export function SidecarTails({ lineName, fileName }: SidecarTailsProps) {
  const query = useQuery({
    queryKey: ["workpiece-sidecars", lineName, fileName],
    queryFn: () => fetchWorkpieceSidecars(lineName, fileName),
    refetchInterval: 3000,
  })

  if (query.isLoading) {
    return <div className="rounded-md border p-6 text-sm text-muted-foreground">Loading sidecars...</div>
  }

  if (query.isError) {
    return <div className="rounded-md border border-destructive/30 p-4 text-sm text-destructive">Could not load sidecar tails.</div>
  }

  return (
    <Tabs defaultValue="stdout" className="space-y-3">
      <TabsList>
        <TabsTrigger value="stdout">stdout</TabsTrigger>
        <TabsTrigger value="stderr">stderr</TabsTrigger>
        <TabsTrigger value="retry">retry</TabsTrigger>
      </TabsList>
      <TabsContent value="stdout">
        <SidecarPre label="stdout" tail={query.data?.stdout} />
      </TabsContent>
      <TabsContent value="stderr">
        <SidecarPre label="stderr" tail={query.data?.stderr} />
      </TabsContent>
      <TabsContent value="retry">
        <SidecarPre label="retry" tail={query.data?.retry} />
      </TabsContent>
    </Tabs>
  )
}
