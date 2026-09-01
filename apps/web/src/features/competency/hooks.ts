import { useCallback, useEffect, useState } from 'react';
import type { ListParams, Paginated } from '@/lib/api-client';
import { competencyApi } from './api';
import type {
  BehaviourIndicator,
  Competency,
  CompetencyCategory,
  CompetencyStats,
} from './types';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** Generic loader that tracks loading/error and exposes a manual `reload`. */
function useAsyncResource<T>(loader: () => Promise<T>): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });

  const run = useCallback(() => {
    let active = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    loader()
      .then((data) => active && setState({ data, loading: false, error: null }))
      .catch((err: Error) => active && setState({ data: null, loading: false, error: err.message }));
    return () => {
      active = false;
    };
  }, [loader]);

  useEffect(() => run(), [run]);

  return { ...state, reload: run };
}

/**
 * @param refreshToken bump to force a refetch. Activating or cloning a version changes
 * the "active" and "draft versions" counts, and those live in a sibling component.
 */
export function useCompetencyStats(
  refreshToken = 0,
): AsyncState<CompetencyStats> & { reload: () => void } {
  return useAsyncResource<CompetencyStats>(useCallback(() => competencyApi.getStats(), [refreshToken]));
}

export function useCategories(
  params: ListParams,
): AsyncState<Paginated<CompetencyCategory>> & { reload: () => void } {
  const loader = useCallback(() => competencyApi.listCategories(params), [JSON.stringify(params)]);
  return useAsyncResource<Paginated<CompetencyCategory>>(loader);
}

export function useCompetencies(
  params: ListParams,
): AsyncState<Paginated<Competency>> & { reload: () => void } {
  const loader = useCallback(() => competencyApi.listCompetencies(params), [JSON.stringify(params)]);
  return useAsyncResource<Paginated<Competency>>(loader);
}

export function useIndicators(
  versionId: string | null,
): AsyncState<BehaviourIndicator[]> & { reload: () => void } {
  const loader = useCallback(
    () => (versionId ? competencyApi.listIndicators(versionId) : Promise.resolve([])),
    [versionId],
  );
  return useAsyncResource<BehaviourIndicator[]>(loader);
}
