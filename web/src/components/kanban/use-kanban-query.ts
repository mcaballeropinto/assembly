import { useQuery } from "@tanstack/react-query";
import { fetchKanbanState } from "../../lib/api";
import {
  useReleaseAllHeld as useSharedReleaseAllHeld,
  useReleaseHeld as useSharedReleaseHeld,
} from "../../hooks/use-dashboard-mutations";
import { lineKanbanQueryKey } from "../../lib/query";

/**
 * Hook to fetch kanban state with 3-second polling.
 */
export function useKanbanQuery(lineName: string) {
  return useQuery({
    queryKey: lineKanbanQueryKey(lineName),
    queryFn: () => fetchKanbanState(lineName),
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
    enabled: !!lineName,
  });
}

/**
 * Mutation hook to release all held tasks.
 */
export function useReleaseAllHeld(lineName: string) {
  return useSharedReleaseAllHeld(lineName);
}

/**
 * Mutation hook to release a single held task.
 */
export function useReleaseHeldTask(lineName: string) {
  return useSharedReleaseHeld(lineName);
}
