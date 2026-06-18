import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchKanbanState, releaseAllHeld, releaseHeldTask } from "../../lib/api";

/**
 * Hook to fetch kanban state with 3-second polling.
 */
export function useKanbanQuery(lineName: string) {
  return useQuery({
    queryKey: ["kanban", lineName],
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
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => releaseAllHeld(lineName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["kanban", lineName] });
    },
  });
}

/**
 * Mutation hook to release a single held task.
 */
export function useReleaseHeldTask(lineName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taskFile: string) => releaseHeldTask(lineName, taskFile),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["kanban", lineName] });
    },
  });
}
