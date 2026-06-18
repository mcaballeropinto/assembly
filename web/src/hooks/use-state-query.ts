import { useQuery } from '@tanstack/react-query';
import { fetchGlobalState } from '../lib/api';

export function useGlobalState() {
  return useQuery({
    queryKey: ['global-state'],
    queryFn: fetchGlobalState,
    refetchInterval: 3000,
  });
}
