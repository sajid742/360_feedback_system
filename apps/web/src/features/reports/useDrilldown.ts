import { useCallback, useState } from 'react';
import type { GridData } from '@/components/shared/DataGridModal';

/** A level in the drill-down: either a record grid or one employee's 360 profile. */
export type DrillLevel =
  | { kind: 'grid'; title: string; subtitle?: string; data: GridData | null; loading: boolean }
  | { kind: 'employee'; title: string; subtitle?: string; employeeId: string; cycleId?: string };

export interface DrilldownState {
  /** The level currently shown, or null when the modal is closed. */
  view: DrillLevel | null;
  /** True when there is a level to go back to. */
  canGoBack: boolean;
  /** Convenience accessors kept for the existing grid call sites. */
  data: GridData | null;
  loading: boolean;
  /** Open a record grid. Replaces the whole stack — this is a top-level drill-down. */
  open: (title: string, subtitle: string | undefined, fetcher: () => Promise<GridData>) => void;
  /** Push one employee's 360 profile on top of the current level. */
  openEmployee: (employeeId: string, name: string, subtitle?: string, cycleId?: string) => void;
  /** Return to the previous level (no-op at the root). */
  back: () => void;
  close: () => void;
}

/**
 * Shared drill-down controller for the dashboards.
 *
 * Originally a single slot: `open()` replaced the view outright, so there was no way
 * to go one level deeper and come back. It is now a small stack, which is what lets a
 * widget drill Executive → filtered employee list → that employee's 360 profile while
 * keeping the dashboard (and its cycle filter) untouched behind the modal.
 *
 * `open()` still starts a fresh stack, so every existing call site behaves exactly as
 * before; only `openEmployee()` pushes.
 */
export function useDrilldown(): DrilldownState {
  const [stack, setStack] = useState<DrillLevel[]>([]);
  const view = stack.length > 0 ? stack[stack.length - 1] : null;

  const open = useCallback((title: string, subtitle: string | undefined, fetcher: () => Promise<GridData>): void => {
    const level: DrillLevel = { kind: 'grid', title, subtitle, data: null, loading: true };
    setStack([level]);
    fetcher()
      .then((d) => setStack((s) => replaceTop(s, { ...level, data: d, loading: false })))
      .catch(() => setStack((s) => replaceTop(s, { ...level, data: { columns: [], rows: [] }, loading: false })));
  }, []);

  const openEmployee = useCallback((employeeId: string, name: string, subtitle?: string, cycleId?: string): void => {
    setStack((s) => [...s, { kind: 'employee', title: name, subtitle, employeeId, cycleId }]);
  }, []);

  const back = useCallback((): void => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const close = useCallback((): void => setStack([]), []);

  return {
    view,
    canGoBack: stack.length > 1,
    data: view?.kind === 'grid' ? view.data : null,
    loading: view?.kind === 'grid' ? view.loading : false,
    open,
    openEmployee,
    back,
    close,
  };
}

/** Swap the top of the stack, ignoring the update if the user has already moved on. */
function replaceTop(stack: DrillLevel[], level: DrillLevel): DrillLevel[] {
  if (stack.length === 0) return stack;
  const top = stack[stack.length - 1];
  if (top.kind !== 'grid' || top.title !== level.title) return stack;
  return [...stack.slice(0, -1), level];
}
