// Vendored from janhesters/shadcn-kanban-board ea1261c; do not edit without noting upstream.
import type {
  ChangeEvent,
  ComponentProps,
  KeyboardEvent,
  MutableRefObject,
  ReactNode,
  Ref,
} from "react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"

import { cn } from "../../../lib/utils"

export type KanbanBoardDndMonitorEventHandler = {
  onDragStart?: (activeId: string) => void
  onDragMove?: (activeId: string, overId?: string) => void
  onDragOver?: (activeId: string, overId?: string) => void
  onDragEnd?: (activeId: string, overId?: string) => void
  onDragCancel?: (activeId: string) => void
}

export type KanbanBoardDndEventType = keyof KanbanBoardDndMonitorEventHandler

export type KanbanBoardDndMonitorContextValue = {
  activeIdRef: MutableRefObject<string | null>
  draggableDescribedById: string
  registerMonitor: (monitor: KanbanBoardDndMonitorEventHandler) => void
  unregisterMonitor: (monitor: KanbanBoardDndMonitorEventHandler) => void
  triggerEvent: (
    eventType: KanbanBoardDndEventType,
    activeId: string,
    overId?: string
  ) => void
}

export const KanbanBoardContext = createContext<
  KanbanBoardDndMonitorContextValue | undefined
>(undefined)

function useDndMonitor(monitor: KanbanBoardDndMonitorEventHandler) {
  const context = useContext(KanbanBoardContext)
  if (!context) {
    throw new Error("useDndMonitor must be used within a DndMonitorProvider")
  }

  const { registerMonitor, unregisterMonitor } = context
  useEffect(() => {
    registerMonitor(monitor)
    return () => {
      unregisterMonitor(monitor)
    }
  }, [monitor, registerMonitor, unregisterMonitor])
}

export function useDndEvents() {
  const context = useContext(KanbanBoardContext)
  if (!context) {
    throw new Error("useDndEvents must be used within a DndMonitorProvider")
  }

  const { activeIdRef, draggableDescribedById, triggerEvent } = context
  const onDragStart = useCallback(
    (activeId: string) => {
      activeIdRef.current = activeId
      triggerEvent("onDragStart", activeId)
    },
    [activeIdRef, triggerEvent]
  )
  const onDragMove = useCallback(
    (activeId: string, overId?: string) => {
      triggerEvent("onDragMove", activeId, overId)
    },
    [triggerEvent]
  )
  const onDragOver = useCallback(
    (activeId: string, overId?: string) => {
      const actualActiveId = activeId || activeIdRef.current
      if (actualActiveId) {
        triggerEvent("onDragOver", actualActiveId, overId)
      }
    },
    [activeIdRef, triggerEvent]
  )
  const onDragEnd = useCallback(
    (activeId: string, overId?: string) => {
      triggerEvent("onDragEnd", activeId, overId)
    },
    [triggerEvent]
  )
  const onDragCancel = useCallback(
    (activeId: string) => {
      triggerEvent("onDragCancel", activeId)
    },
    [triggerEvent]
  )

  return {
    draggableDescribedById,
    onDragStart,
    onDragMove,
    onDragOver,
    onDragEnd,
    onDragCancel,
  }
}

export const defaultScreenReaderInstructions = `
To pick up a draggable item, press the space bar.
While dragging, use the arrow keys to move the item. Press space again to drop the item in its new position, or press escape to cancel.
`

export type KanbanBoardAnnouncements = {
  onDragStart: (activeId: string) => string
  onDragMove?: (activeId: string, overId?: string) => string | undefined
  onDragOver: (activeId: string, overId?: string) => string
  onDragEnd: (activeId: string, overId?: string) => string
  onDragCancel: (activeId: string) => string
}

export const defaultAnnouncements: KanbanBoardAnnouncements = {
  onDragStart(activeId) {
    return `Picked up draggable item ${activeId}.`
  },
  onDragOver(activeId, overId) {
    if (overId) {
      return `Draggable item ${activeId} was moved over droppable area ${overId}.`
    }
    return `Draggable item ${activeId} is no longer over a droppable area.`
  },
  onDragEnd(activeId, overId) {
    if (overId) {
      return `Draggable item ${activeId} was dropped over droppable area ${overId}.`
    }
    return `Draggable item ${activeId} was dropped.`
  },
  onDragCancel(activeId) {
    return `Dragging was cancelled. Draggable item ${activeId} was dropped.`
  },
}

export type KanbanBoardLiveRegionProps = {
  id: string
  announcement: string
  ariaLiveType?: "polite" | "assertive" | "off"
}

export function KanbanBoardLiveRegion({
  announcement,
  ariaLiveType = "assertive",
  className,
  id,
  ...props
}: ComponentProps<"div"> & KanbanBoardLiveRegionProps) {
  return (
    <div
      aria-atomic
      aria-live={ariaLiveType}
      className={cn("sr-only", className)}
      id={id}
      role="status"
      {...props}
    >
      {announcement}
    </div>
  )
}

export type KanbanBoardHiddenTextProps = {
  id: string
  value: string
}

export function KanbanBoardHiddenText({
  className,
  id,
  value,
  ...props
}: ComponentProps<"div"> & KanbanBoardHiddenTextProps) {
  return (
    <div className={cn("sr-only", className)} id={id} {...props}>
      {value}
    </div>
  )
}

export function useAnnouncement() {
  const [announcement, setAnnouncement] = useState("")
  const announce = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      setAnnouncement(value)
    }
  }, [])

  return { announce, announcement } as const
}

export type KanbanBoardAccessibilityProps = {
  announcements?: KanbanBoardAnnouncements
  container?: Element
  screenReaderInstructions?: string
  hiddenTextDescribedById: string
}

export function KanbanBoardAccessibility({
  announcements = defaultAnnouncements,
  container,
  hiddenTextDescribedById,
  screenReaderInstructions = defaultScreenReaderInstructions,
}: KanbanBoardAccessibilityProps) {
  const { announce, announcement } = useAnnouncement()
  const liveRegionId = useId()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useDndMonitor(
    useMemo(
      () => ({
        onDragStart(activeId: string) {
          announce(announcements.onDragStart(activeId))
        },
        onDragMove(activeId: string, overId?: string) {
          if (announcements.onDragMove) {
            announce(announcements.onDragMove(activeId, overId))
          }
        },
        onDragOver(activeId: string, overId?: string) {
          announce(announcements.onDragOver(activeId, overId))
        },
        onDragEnd(activeId: string, overId?: string) {
          announce(announcements.onDragEnd(activeId, overId))
        },
        onDragCancel(activeId: string) {
          announce(announcements.onDragCancel(activeId))
        },
      }),
      [announce, announcements]
    )
  )

  if (!mounted) {
    return null
  }

  const markup = (
    <>
      <KanbanBoardHiddenText
        id={hiddenTextDescribedById}
        value={screenReaderInstructions}
      />
      <KanbanBoardLiveRegion
        announcement={announcement}
        id={liveRegionId}
      />
    </>
  )

  return container ? createPortal(markup, container) : markup
}

export type KanbanBoardProviderProps = {
  announcements?: KanbanBoardAnnouncements
  children: ReactNode
  container?: Element
  onDragStart?: (activeId: string) => void
  screenReaderInstructions?: string
}

export function KanbanBoardProvider({
  announcements,
  children,
  container,
  onDragStart,
  screenReaderInstructions,
}: KanbanBoardProviderProps) {
  const draggableDescribedById = useId()
  const monitorsRef = useRef<KanbanBoardDndMonitorEventHandler[]>([])
  const activeIdRef = useRef("")

  const registerMonitor = useCallback(
    (monitor: KanbanBoardDndMonitorEventHandler) => {
      monitorsRef.current.push(monitor)
    },
    []
  )
  const unregisterMonitor = useCallback(
    (monitor: KanbanBoardDndMonitorEventHandler) => {
      monitorsRef.current = monitorsRef.current.filter(item => item !== monitor)
    },
    []
  )
  const triggerEvent = useCallback(
    (
      eventType: KanbanBoardDndEventType,
      activeId: string,
      overId?: string
    ) => {
      if (eventType === "onDragStart") {
        onDragStart?.(activeId)
      }
      for (const monitor of monitorsRef.current) {
        monitor[eventType]?.(activeId, overId)
      }
    },
    [onDragStart]
  )

  const contextValue = useMemo(
    () => ({
      activeIdRef,
      draggableDescribedById,
      registerMonitor,
      unregisterMonitor,
      triggerEvent,
    }),
    [draggableDescribedById, registerMonitor, triggerEvent, unregisterMonitor]
  )

  return (
    <KanbanBoardContext.Provider value={contextValue}>
      {children}
      <KanbanBoardAccessibility
        announcements={announcements}
        container={container}
        hiddenTextDescribedById={draggableDescribedById}
        screenReaderInstructions={screenReaderInstructions}
      />
    </KanbanBoardContext.Provider>
  )
}

const DATA_TRANSFER_TYPES = {
  CARD: "kanban-board-card",
}

const KANBAN_BOARD_CIRCLE_COLORS_MAP = {
  primary: "bg-kanban-board-circle-primary",
  gray: "bg-kanban-board-circle-gray",
  red: "bg-kanban-board-circle-red",
  yellow: "bg-kanban-board-circle-yellow",
  green: "bg-kanban-board-circle-green",
  cyan: "bg-kanban-board-circle-cyan",
  blue: "bg-kanban-board-circle-blue",
  indigo: "bg-kanban-board-circle-indigo",
  violet: "bg-kanban-board-circle-violet",
  purple: "bg-kanban-board-circle-purple",
  pink: "bg-kanban-board-circle-pink",
}

export type KanbanBoardCircleColor =
  keyof typeof KANBAN_BOARD_CIRCLE_COLORS_MAP

export const KANBAN_BOARD_CIRCLE_COLORS = Object.keys(
  KANBAN_BOARD_CIRCLE_COLORS_MAP
) as KanbanBoardCircleColor[]

export function KanbanBoard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex h-full gap-3 overflow-x-auto p-1", className)}
      {...props}
    />
  )
}

export function KanbanBoardExtraMargin({
  className,
  ...props
}: ComponentProps<"div">) {
  return <div className={cn("w-2 flex-shrink-0", className)} {...props} />
}

export type KanbanBoardColumnProps = {
  columnId?: string
  onDropOverColumn?: (dataTransferData: string) => void
}

export const kanbanBoardColumnClassNames =
  "w-64 flex-shrink-0 rounded-lg border flex flex-col border-border bg-sidebar py-2 max-h-full"

export function KanbanBoardColumn({
  className,
  columnId,
  onDropOverColumn,
  ...props
}: ComponentProps<"section"> & KanbanBoardColumnProps) {
  const [isDropTarget, setIsDropTarget] = useState(false)
  const { onDragEnd, onDragOver } = useDndEvents()

  return (
    <section
      className={cn(
        kanbanBoardColumnClassNames,
        isDropTarget && "ring-2 ring-ring",
        className
      )}
      onDragLeave={() => setIsDropTarget(false)}
      onDragOver={event => {
        if (columnId && event.dataTransfer.types.includes(DATA_TRANSFER_TYPES.CARD)) {
          event.preventDefault()
          setIsDropTarget(true)
          onDragOver("", columnId)
        }
      }}
      onDrop={event => {
        const data = event.dataTransfer.getData(DATA_TRANSFER_TYPES.CARD)
        onDropOverColumn?.(data)
        if (columnId) {
          onDragEnd(JSON.parse(data).id as string, columnId)
        }
        setIsDropTarget(false)
      }}
      {...props}
    />
  )
}

export function KanbanBoardColumnSkeleton() {
  return (
    <div
      className="h-full w-64 flex-shrink-0 animate-pulse rounded-lg bg-muted"
      aria-hidden="true"
    />
  )
}

export function KanbanBoardColumnHeader({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center gap-2 px-3 pb-2", className)}
      {...props}
    />
  )
}

export type KanbanBoardColumnTitleProps = {
  columnId: string
}

export function KanbanBoardColumnTitle({
  className,
  columnId: _columnId,
  ...props
}: ComponentProps<"h2"> & KanbanBoardColumnTitleProps) {
  return <h2 className={cn("text-sm font-medium", className)} {...props} />
}

export function KanbanBoardColumnIconButton({
  className,
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      className={cn(
        "inline-flex size-7 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      type="button"
      {...props}
    />
  )
}

export type KanbanBoardColorCircleProps = {
  color?: KanbanBoardCircleColor
}

export function KanbanColorCircle({
  className,
  color = "primary",
  ...props
}: ComponentProps<"div"> & KanbanBoardColorCircleProps) {
  return (
    <div
      className={cn(
        "size-2.5 rounded-full",
        KANBAN_BOARD_CIRCLE_COLORS_MAP[color],
        className
      )}
      {...props}
    />
  )
}

export function KanbanBoardColumnList({
  className,
  ...props
}: ComponentProps<"ul">) {
  return <ul className={cn("flex flex-1 flex-col", className)} {...props} />
}

export type KanbanBoardDropDirection = "none" | "top" | "bottom"

export type KanbanBoardColumnListItemProps = {
  cardId: string
  onDropOverListItem?: (
    dataTransferData: string,
    dropDirection: KanbanBoardDropDirection
  ) => void
}

export const kanbanBoardColumnListItemClassNames =
  "-mb-[2px] border-b-2 border-t-2 border-b-transparent border-t-transparent px-2 py-1 last:mb-0"

export function KanbanBoardColumnListItem({
  cardId,
  className,
  onDropOverListItem,
  ...props
}: ComponentProps<"li"> & KanbanBoardColumnListItemProps) {
  const [dropDirection, setDropDirection] =
    useState<KanbanBoardDropDirection>("none")
  const { onDragEnd, onDragOver } = useDndEvents()

  return (
    <li
      className={cn(
        kanbanBoardColumnListItemClassNames,
        dropDirection === "top" && "border-t-primary",
        dropDirection === "bottom" && "border-b-primary",
        className
      )}
      onDragLeave={() => setDropDirection("none")}
      onDragOver={event => {
        if (event.dataTransfer.types.includes(DATA_TRANSFER_TYPES.CARD)) {
          event.preventDefault()
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          const midpoint = (rect.top + rect.bottom) / 2
          setDropDirection(event.clientY <= midpoint ? "top" : "bottom")
          onDragOver("", cardId)
        }
      }}
      onDrop={event => {
        event.stopPropagation()
        const data = event.dataTransfer.getData(DATA_TRANSFER_TYPES.CARD)
        onDropOverListItem?.(data, dropDirection)
        onDragEnd(JSON.parse(data).id as string, cardId)
        setDropDirection("none")
      }}
      {...props}
    />
  )
}

export function KanbanBoardColumnFooter({
  className,
  ...props
}: ComponentProps<"div">) {
  return <div className={cn("px-2 pt-2", className)} {...props} />
}

export function KanbanBoardColumnButton({
  className,
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      className={cn(
        "inline-flex h-9 w-full items-center justify-start gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      type="button"
      {...props}
    />
  )
}

export type KanbanBoardCardProps<T extends { id: string }> = {
  data: T
  isActive?: boolean
  isDragDisabled?: boolean
}

export const kanbanBoardCardClassNames =
  "rounded-lg border border-border bg-background p-3 text-start text-foreground shadow-sm"

export function KanbanBoardCard<T extends { id: string }>({
  className,
  data,
  isActive = false,
  isDragDisabled = false,
  ...props
}: ComponentProps<"button"> & KanbanBoardCardProps<T>) {
  const [isDragging, setIsDragging] = useState(false)
  const { draggableDescribedById, onDragStart } = useDndEvents()

  return (
    <button
      aria-describedby={draggableDescribedById}
      aria-disabled={isDragDisabled || undefined}
      className={cn(
        kanbanBoardCardClassNames,
        "group relative w-full cursor-grab disabled:cursor-not-allowed",
        isDragDisabled && "cursor-default",
        (isDragging || isActive) && "opacity-50",
        className
      )}
      data-kanban-card-id={data.id}
      draggable={!isDragDisabled}
      onDragEnd={() => setIsDragging(false)}
      onDragStart={event => {
        if (isDragDisabled) {
          event.preventDefault()
          return
        }
        setIsDragging(true)
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData(DATA_TRANSFER_TYPES.CARD, JSON.stringify(data))
        event.currentTarget.blur()
        onDragStart(data.id)
      }}
      type="button"
      {...props}
    />
  )
}

export function KanbanBoardCardTitle({
  className,
  ...props
}: ComponentProps<"h3">) {
  return <h3 className={cn("text-sm font-medium", className)} {...props} />
}

export function KanbanBoardCardDescription({
  className,
  ...props
}: ComponentProps<"p">) {
  return (
    <p className={cn("mt-1 text-xs text-muted-foreground", className)} {...props} />
  )
}

export function KanbanBoardCardTextarea({
  className,
  onChange,
  value,
  ref: externalRef,
  ...props
}: ComponentProps<"textarea">) {
  const internalRef = useRef<HTMLTextAreaElement | null>(null)

  const adjustTextareaHeight = () => {
    if (internalRef.current) {
      internalRef.current.style.height = "auto"
      internalRef.current.style.height = `${internalRef.current.scrollHeight}px`
    }
  }

  useEffect(() => {
    adjustTextareaHeight()
  }, [])

  useEffect(() => {
    if (value === "") {
      adjustTextareaHeight()
    }
  }, [value])

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    onChange?.(event)
    adjustTextareaHeight()
  }

  useImperativeHandle(
    externalRef as Ref<HTMLTextAreaElement> | undefined,
    () => internalRef.current as HTMLTextAreaElement
  )

  return (
    <textarea
      className={cn("resize-none overflow-hidden", className)}
      onChange={handleChange}
      ref={internalRef}
      value={value}
      {...props}
    />
  )
}

export type KanbanBoardCardButtonGroupProps = {
  disabled?: boolean
}

export function KanbanBoardCardButtonGroup({
  className,
  disabled = false,
  ...props
}: ComponentProps<"div"> & KanbanBoardCardButtonGroupProps) {
  return (
    <div
      className={cn(
        "absolute right-2.5 top-2.5 z-40 hidden items-center bg-background",
        !disabled && "group-focus-within:flex group-hover:flex",
        className
      )}
      {...props}
    />
  )
}

export type KanbanBoardCardButtonProps = {
  tooltip?: string
}

export function KanbanBoardCardButton({
  className,
  tooltip,
  ref: externalRef,
  ...props
}: ComponentProps<"div"> & KanbanBoardCardButtonProps) {
  const internalRef = useRef<HTMLDivElement | null>(null)
  useImperativeHandle(
    externalRef as Ref<HTMLDivElement> | undefined,
    () => internalRef.current as HTMLDivElement
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      event.stopPropagation()
      internalRef.current?.click()
    }
  }

  const button = (
    <div
      className={cn(
        "inline-flex size-5 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-border text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground hover:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&_svg]:size-3.5",
        className
      )}
      onKeyDown={handleKeyDown}
      ref={internalRef}
      role="button"
      tabIndex={0}
      {...props}
    />
  )

  return tooltip ? (
    <span title={tooltip}>
      {button}
    </span>
  ) : button
}
