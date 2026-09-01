import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { HelpCircle } from 'lucide-react';
import { helpForPath } from './page-help';

/**
 * Header contextual-help button (F29). Shows a short "what this page is for" +
 * first-run steps panel for the current route. Hidden on pages that have no
 * registered help. Dependency-free popover; closes on outside-click / Escape.
 */
export function PageHelpButton(): JSX.Element | null {
  const { pathname } = useLocation();
  const help = helpForPath(pathname);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!help) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Help for this page"
        aria-expanded={open}
        className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <HelpCircle className="size-4" />
      </button>
      {open ? (
        <div role="dialog" aria-label={`Help: ${help.title}`} className="absolute right-0 top-11 z-30 w-80 rounded-xl border border-border bg-card p-4 text-left shadow-lg">
          <p className="text-sm font-bold">{help.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{help.body}</p>
          {help.steps?.length ? (
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold">Getting started</p>
              <ol className="list-decimal space-y-0.5 pl-4 text-xs text-muted-foreground">
                {help.steps.map((s) => <li key={s}>{s}</li>)}
              </ol>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
