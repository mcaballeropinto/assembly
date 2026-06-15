import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  dismissErrors,
  releaseAllHeld,
  releaseHeldTask,
  retryWorkpiece,
  undismissErrors,
} from "../lib/api"
import {
  API_STATE_QUERY_KEY,
  lineKanbanQueryKey,
  workpieceQueryKey,
} from "../lib/query"
import type { ApiStateLineEntry, ApiStateResponse } from "../lib/api"

type MutationContext = {
  previousState?: ApiStateResponse
}

export function getItemFileName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  return typeof record.fileName === "string" ? record.fileName : undefined
}

function withDismissedAt(value: unknown, dismissedAt: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  return {
    ...record,
    dismissed_at:
      typeof record.dismissed_at === "string" && record.dismissed_at.length > 0
        ? record.dismissed_at
        : dismissedAt,
  }
}

function recalculateLine(line: ApiStateLineEntry): ApiStateLineEntry {
  if (!line.state) return line
  return {
    ...line,
    state: {
      ...line.state,
      lineQueue: {
        ...line.state.lineQueue,
        errorActive: line.state.errors.length,
        error: line.state.errors.length + line.state.errorsDismissed.length,
      },
      errors_meta: line.state.errors_meta
        ? {
            ...line.state.errors_meta,
            total_active: line.state.errors.length,
            in_banner: Math.min(
              line.state.errors_meta.in_banner,
              line.state.errors.length
            ),
          }
        : undefined,
      banner_errors: line.state.banner_errors?.filter((item) =>
        line.state?.errors.some(
          (error) => getItemFileName(error) === getItemFileName(item)
        )
      ),
    },
  }
}

function recalculateTotals(state: ApiStateResponse): ApiStateResponse {
  return {
    ...state,
    totals: {
      ...state.totals,
      totalErrors: state.lines.reduce(
        (sum, line) => sum + (line.state?.lineQueue.errorActive ?? 0),
        0
      ),
    },
  }
}

export function optimisticallyDismissErrors(
  state: ApiStateResponse,
  lineName: string,
  fileNames: string[],
  nowIso = new Date().toISOString()
): ApiStateResponse {
  const selected = new Set(fileNames)
  const lines = state.lines.map((line) => {
    if (line.name !== lineName || !line.state) return line
    const moved: unknown[] = []
    const errors = line.state.errors.filter((item) => {
      const fileName = getItemFileName(item)
      if (!fileName || !selected.has(fileName)) return true
      moved.push(withDismissedAt(item, nowIso))
      return false
    })
    if (moved.length === 0) return line
    return recalculateLine({
      ...line,
      state: {
        ...line.state,
        errors,
        errorsDismissed: [...moved, ...line.state.errorsDismissed],
      },
    })
  })
  return recalculateTotals({ ...state, lines })
}

export function optimisticallyUndismissErrors(
  state: ApiStateResponse,
  lineName: string,
  fileNames: string[]
): ApiStateResponse {
  const selected = new Set(fileNames)
  const lines = state.lines.map((line) => {
    if (line.name !== lineName || !line.state) return line
    const moved: unknown[] = []
    const errorsDismissed = line.state.errorsDismissed.filter((item) => {
      const fileName = getItemFileName(item)
      if (!fileName || !selected.has(fileName)) return true
      moved.push(item)
      return false
    })
    if (moved.length === 0) return line
    return recalculateLine({
      ...line,
      state: {
        ...line.state,
        errors: [...moved, ...line.state.errors],
        errorsDismissed,
      },
    })
  })
  return recalculateTotals({ ...state, lines })
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function invalidateLine(
  queryClient: ReturnType<typeof useQueryClient>,
  lineName: string,
  fileName?: string
) {
  void queryClient.invalidateQueries({ queryKey: API_STATE_QUERY_KEY })
  void queryClient.invalidateQueries({ queryKey: lineKanbanQueryKey(lineName) })
  if (fileName) {
    void queryClient.invalidateQueries({
      queryKey: workpieceQueryKey(lineName, fileName),
    })
  }
}

export function useDismissErrors(lineName: string) {
  const queryClient = useQueryClient()

  return useMutation<void, Error, string[], MutationContext>({
    mutationFn: async (fileNames) => {
      await dismissErrors(lineName, fileNames)
    },
    onMutate: async (fileNames) => {
      await queryClient.cancelQueries({ queryKey: API_STATE_QUERY_KEY })
      const previousState =
        queryClient.getQueryData<ApiStateResponse>(API_STATE_QUERY_KEY)
      if (previousState) {
        queryClient.setQueryData<ApiStateResponse>(API_STATE_QUERY_KEY, (state) =>
          state
            ? optimisticallyDismissErrors(state, lineName, fileNames)
            : state
        )
      }
      return { previousState }
    },
    onError: (error, _fileNames, context) => {
      if (context?.previousState) {
        queryClient.setQueryData(API_STATE_QUERY_KEY, context.previousState)
      }
      toast.error(errorMessage(error, "Failed to dismiss errors"))
    },
    onSettled: (_data, _error, fileNames) => {
      invalidateLine(queryClient, lineName, fileNames[0])
    },
  })
}

export function useUndismissErrors(lineName: string) {
  const queryClient = useQueryClient()

  return useMutation<void, Error, string[], MutationContext>({
    mutationFn: async (fileNames) => {
      await undismissErrors(lineName, fileNames)
    },
    onMutate: async (fileNames) => {
      await queryClient.cancelQueries({ queryKey: API_STATE_QUERY_KEY })
      const previousState =
        queryClient.getQueryData<ApiStateResponse>(API_STATE_QUERY_KEY)
      if (previousState) {
        queryClient.setQueryData<ApiStateResponse>(API_STATE_QUERY_KEY, (state) =>
          state
            ? optimisticallyUndismissErrors(state, lineName, fileNames)
            : state
        )
      }
      return { previousState }
    },
    onError: (error, _fileNames, context) => {
      if (context?.previousState) {
        queryClient.setQueryData(API_STATE_QUERY_KEY, context.previousState)
      }
      toast.error(errorMessage(error, "Failed to undismiss errors"))
    },
    onSettled: (_data, _error, fileNames) => {
      invalidateLine(queryClient, lineName, fileNames[0])
    },
  })
}

export function useRetryWorkpiece(lineName: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (fileName: string) => retryWorkpiece(lineName, fileName),
    onSuccess: () => {
      toast.success("Retry queued")
    },
    onError: (error) => {
      toast.error(errorMessage(error, "Failed to retry workpiece"))
    },
    onSettled: (_data, _error, fileName) => {
      invalidateLine(queryClient, lineName, fileName)
    },
  })
}

export function useReleaseHeld(lineName: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (fileName: string) => releaseHeldTask(lineName, fileName),
    onSuccess: () => {
      toast.success("Held task released")
    },
    onError: (error) => {
      toast.error(errorMessage(error, "Failed to release held task"))
    },
    onSettled: (_data, _error, fileName) => {
      invalidateLine(queryClient, lineName, fileName)
    },
  })
}

export function useReleaseAllHeld(lineName: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => releaseAllHeld(lineName),
    onSuccess: () => {
      toast.success("Held tasks released")
    },
    onError: (error) => {
      toast.error(errorMessage(error, "Failed to release held tasks"))
    },
    onSettled: () => {
      invalidateLine(queryClient, lineName)
    },
  })
}
