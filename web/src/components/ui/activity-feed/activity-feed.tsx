// Vendored from shadcn.io timeline-activity-feed block, retrieved 2026-06-09; dashboard-activity-feed was not publicly accessible.
import { CheckCircle2, CircleDot, GitCommit, MessageSquare } from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

const activityIcons = {
  comment: MessageSquare,
  commit: GitCommit,
  review: CheckCircle2,
  status: CircleDot,
}

export type ActivityFeedItem = {
  id: string
  actor: {
    name: string
    initials: string
    avatarUrl?: string
  }
  action: string
  subject: string
  timestamp: string
  type: keyof typeof activityIcons
  badge?: string
  description?: string
}

const defaultItems: ActivityFeedItem[] = [
  {
    id: "activity-1",
    actor: { name: "Maya Chen", initials: "MC" },
    action: "commented on",
    subject: "Dashboard smoke scaffold",
    timestamp: "12m ago",
    type: "comment",
    badge: "Comment",
    description: "Confirmed the Vite smoke app renders the shadcn Button.",
  },
  {
    id: "activity-2",
    actor: { name: "Noah Kim", initials: "NK" },
    action: "updated",
    subject: "Frontend dependencies",
    timestamp: "28m ago",
    type: "status",
    badge: "Update",
  },
  {
    id: "activity-3",
    actor: { name: "Ari Patel", initials: "AP" },
    action: "reviewed",
    subject: "Phase 1 scaffold",
    timestamp: "1h ago",
    type: "review",
    badge: "Review",
  },
]

export type ActivityFeedProps = {
  className?: string
  items?: ActivityFeedItem[]
  title?: string
}

export function ActivityFeed({
  className,
  items = defaultItems,
  title = "Activity",
}: ActivityFeedProps) {
  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <Button size="sm" variant="ghost">
          View all
        </Button>
      </CardHeader>
      <CardContent>
        <ol className="relative space-y-0">
          {items.map((item, index) => {
            const Icon = activityIcons[item.type]

            return (
              <li className="relative flex gap-4 pb-6 last:pb-0" key={item.id}>
                {index < items.length - 1 ? (
                  <Separator
                    className="absolute left-5 top-10 h-[calc(100%-2.5rem)] w-px"
                    orientation="vertical"
                  />
                ) : null}
                <Avatar className="z-10 size-10 border bg-background">
                  {item.actor.avatarUrl ? (
                    <AvatarImage alt={item.actor.name} src={item.actor.avatarUrl} />
                  ) : null}
                  <AvatarFallback>{item.actor.initials}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{item.actor.name}</span>
                    <span className="text-muted-foreground">{item.action}</span>
                    <span className="font-medium">{item.subject}</span>
                    {item.badge ? (
                      <Badge className="gap-1" variant="secondary">
                        <Icon className="size-3" />
                        {item.badge}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-sm text-muted-foreground">{item.timestamp}</p>
                  {item.description ? (
                    <p className="text-sm text-foreground">{item.description}</p>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}
