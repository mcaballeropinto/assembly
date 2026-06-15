import { useQuery } from '@tanstack/react-query';
import { apiStateQueryOptions } from '../lib/query';

export function useGlobalState() {
  return useQuery(apiStateQueryOptions());
}
