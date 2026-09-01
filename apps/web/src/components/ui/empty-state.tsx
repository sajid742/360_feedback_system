import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Richer empty-state (F29). Replaces bland "No X yet" one-liners with an icon,
 * a title, a short explanation, and an optional call-to-action — so a first-run
 * user understands what the screen is for and what to do next.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center',
        className,
      )}
    >
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
        {icon ?? <Inbox />}
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
