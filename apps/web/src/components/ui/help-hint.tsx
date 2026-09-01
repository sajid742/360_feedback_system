import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Lightweight, dependency-free contextual-help popover (F29). Renders a small
 * "?" icon that toggles a short explanation on click. Used inline next to
 * section titles, labels, or actions to explain what something does without
 * sending the user to the manual. Closes on outside-click / Escape.
 */
export function HelpHint({
  title,
  children,
  className,
  side = 'bottom',
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  side?: 'bottom' | 'top';
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className={cn('relative inline-flex', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={title ? `Help: ${title}` : 'Help'}
        aria-expanded={open}
        className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
      >
        <HelpCircle />
      </button>
      {open ? (
        <span
          role="tooltip"
          className={cn(
            'absolute z-30 w-64 rounded-lg border border-border bg-card p-3 text-left text-xs leading-relaxed text-foreground shadow-lg',
            side === 'bottom' ? 'top-7 left-0' : 'bottom-7 left-0',
          )}
        >
          {title ? <span className="mb-1 block font-semibold">{title}</span> : null}
          <span className="block text-muted-foreground">{children}</span>
        </span>
      ) : null}
    </span>
  );
}
