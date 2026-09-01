import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Lightweight, dependency-free toast system (F12). Provides consistent success/error
 * feedback for mutations across the app. Mount <ToastProvider> once near the root and
 * call `useToast().toast(message, { variant })` anywhere.
 */
type Variant = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  message: string;
  variant: Variant;
}
interface ToastApi {
  toast: (message: string, opts?: { variant?: Variant; durationMs?: number }) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
let seq = 0;

const STYLES: Record<Variant, string> = {
  success: 'border-l-4 border-emerald-500',
  error: 'border-l-4 border-red-500',
  info: 'border-l-4 border-brand',
};
const ICONS: Record<Variant, string> = { success: '✓', error: '!', info: 'i' };

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback(
    (message: string, opts?: { variant?: Variant; durationMs?: number }) => {
      const id = ++seq;
      const variant = opts?.variant ?? 'info';
      setToasts((t) => [...t, { id, message, variant }]);
      const ms = opts?.durationMs ?? (variant === 'error' ? 6000 : 3500);
      window.setTimeout(() => remove(id), ms);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (m: string) => toast(m, { variant: 'success' }),
      error: (m: string) => toast(m, { variant: 'error' }),
    }),
    [toast],
  );

  /**
   * Global safety net for failed API calls (F-H2).
   *
   * Many mutations across the app were written as bare `.then(...)` with no
   * `.catch`, so a rejected save/assign/delete produced an unhandled promise
   * rejection and NOTHING on screen — the action simply looked like it had
   * succeeded. Catching unhandled rejections here surfaces every one of them as
   * an error toast without editing ~84 call sites, and covers new ones
   * automatically. Screens that already handle their own errors are unaffected
   * (their promises never reject unhandled), so no duplicate messages appear.
   */
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent): void => {
      const reason = event.reason as { name?: string; status?: number; message?: string } | undefined;
      if (!reason || reason.name !== 'ApiError') return;
      // 401 is already handled by the API client (silent refresh, or redirect to login).
      if (reason.status === 401) return;
      event.preventDefault();
      toast(reason.message || 'That action could not be completed.', { variant: 'error' });
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2" aria-live="polite" role="status">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-md bg-card px-4 py-3 text-sm shadow-card-hover ${STYLES[t.variant]}`}
          >
            <span className="mt-0.5 font-bold">{ICONS[t.variant]}</span>
            <span className="flex-1">{t.message}</span>
            <button onClick={() => remove(t.id)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Access the toast API. Returns a no-op-safe API even outside the provider (defensive). */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  const noop = (): void => undefined;
  return { toast: noop, success: noop, error: noop };
}
