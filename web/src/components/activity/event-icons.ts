import {
  AlertCircle,
  CheckCircle2,
  RotateCcw,
  ArrowRight,
  AlertTriangle,
  Inbox,
  Zap,
  ZapOff,
  Heart,
  Activity,
  type LucideIcon,
} from 'lucide-react';

export interface EventIconConfig {
  icon: LucideIcon;
  className: string;
}

const EVENT_ICON_MAP: Record<string, EventIconConfig> = {
  error: { icon: AlertCircle, className: 'text-destructive' },
  error_bucket: { icon: AlertCircle, className: 'text-destructive' },
  station_done: { icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-500' },
  task_done: { icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-500' },
  retry: { icon: RotateCcw, className: 'text-amber-600 dark:text-amber-500' },
  routed: { icon: ArrowRight, className: 'text-blue-600 dark:text-blue-500' },
  queued: { icon: ArrowRight, className: 'text-blue-600 dark:text-blue-500' },
  escalated: { icon: AlertTriangle, className: 'text-amber-600 dark:text-amber-500' },
  task_received: { icon: Inbox, className: 'text-muted-foreground' },
  trigger_fired: { icon: Zap, className: 'text-muted-foreground' },
  trigger_skipped: { icon: ZapOff, className: 'text-muted-foreground' },
  station_heartbeat: { icon: Heart, className: 'text-muted-foreground' },
  orchestrator_start: { icon: Activity, className: 'text-muted-foreground' },
};

const DEFAULT_ICON: EventIconConfig = { icon: Activity, className: 'text-muted-foreground' };

export function getEventIcon(event: string): EventIconConfig {
  // Check for exact match first, then check if event contains 'error'
  if (EVENT_ICON_MAP[event]) return EVENT_ICON_MAP[event];
  if (event.includes('error')) return EVENT_ICON_MAP.error;
  return DEFAULT_ICON;
}
