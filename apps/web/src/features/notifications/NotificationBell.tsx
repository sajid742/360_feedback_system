import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, ChevronRight } from 'lucide-react';
import { notificationsApi, type UserNotification } from './api';

/**
 * Only an in-app absolute path is ever followed.
 *
 * The server already returns hard-coded internal routes, so this is defence in depth
 * rather than a live concern — but it means no future change on the server, and no
 * older or tampered response, can turn the bell into an open redirect. `//host` is
 * rejected explicitly because the browser reads it as protocol-relative.
 */
function isInternalRoute(route: string | undefined): route is string {
  return typeof route === 'string' && route.startsWith('/') && !route.startsWith('//');
}

/** A notification is clickable only when the SERVER says it has a reachable action. */
function actionOf(n: UserNotification): { route: string; label: string } | null {
  const a = n.action;
  if (!a || !isInternalRoute(a.route)) return null;
  return { route: a.route, label: a.label };
}

/** Topbar notification center (NH-5): unread badge + dropdown list. */
export function NotificationBell(): JSX.Element {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<UserNotification[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const refreshCount = (): void => {
    notificationsApi.unreadCount().then((r) => setCount(r.count)).catch(() => undefined);
  };

  useEffect(() => {
    refreshCount();
    const t = setInterval(refreshCount, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    notificationsApi.list().then(setItems);
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const markAll = async (): Promise<void> => {
    await notificationsApi.markAllRead();
    setItems((prev) => (prev ? prev.map((n) => ({ ...n, read: true })) : prev));
    setCount(0);
  };

  /**
   * Open an actionable notification: mark it read, then navigate. The read call is
   * fire-and-forget — a failed mark-read must never swallow the navigation the user
   * asked for, and the next poll corrects the badge either way.
   */
  const openAction = (n: UserNotification, route: string): void => {
    if (!n.read) {
      notificationsApi.markRead(n.id).catch(() => undefined);
      setItems((prev) => (prev ? prev.map((i) => (i.id === n.id ? { ...i, read: true } : i)) : prev));
      setCount((c) => Math.max(0, c - 1));
    }
    setOpen(false);
    navigate(route);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Notifications"
      >
        <Bell className="size-4" />
        {count > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-white">
            {count > 9 ? '9+' : count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-20 mt-2 w-80 overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {count > 0 ? <button onClick={markAll} className="text-xs text-brand hover:underline">Mark all read</button> : null}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {!items ? (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            ) : items.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">You're all caught up.</p>
            ) : (
              items.map((n) => {
                const action = actionOf(n);
                const unread = n.read ? '' : 'bg-brand/5';

                // Informational: rendered identically, but as static content — no
                // pointer, no hover treatment, no keyboard focus, nowhere to go.
                if (!action) {
                  return (
                    <div key={n.id} className={`cursor-default border-b border-border px-3 py-2 last:border-0 ${unread}`}>
                      <NotificationBody n={n} />
                    </div>
                  );
                }

                // Actionable: a real button, so it is focusable, keyboard-operable and
                // announced as a control.
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => openAction(n, action.route)}
                    title={action.label}
                    className={`flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left transition-colors last:border-0 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40 ${unread}`}
                  >
                    <span className="min-w-0 flex-1">
                      <NotificationBody n={n} />
                      <span className="mt-1 block text-[11px] font-semibold text-brand">{action.label}</span>
                    </span>
                    <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Shared content so an actionable and an informational row read identically. */
function NotificationBody({ n }: { n: UserNotification }): JSX.Element {
  return (
    <>
      <span className="block text-sm font-medium">{n.title}</span>
      {n.body ? <span className="mt-0.5 block text-xs text-muted-foreground">{n.body}</span> : null}
      <span className="mt-0.5 block text-[10px] text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</span>
    </>
  );
}
