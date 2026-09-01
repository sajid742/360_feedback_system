import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { StatCard } from '@/components/shared/StatCard';
import type { CardVariant, StatCardTone } from './shared';

/**
 * KPI tile styles.
 *
 * `StatCard` (the original gradient tile) is deliberately NOT modified — it is
 * also used by the Organization and Competency stats rows, which must keep
 * looking exactly as they do. This component wraps it for the `gradient`
 * variant and draws the alternatives itself, so a dashboard KPI can change
 * style without touching a shared component.
 *
 * Every variant takes the same props, so a widget selects one by passing
 * `variant` and changes nothing else.
 */

/** Static class strings per tone — written out in full so Tailwind's JIT sees them. */
const ACCENT: Record<StatCardTone, { text: string; chip: string; bar: string; ring: string }> = {
  brand:  { text: 'text-[#5346d9]', chip: 'bg-[#6d5dfc]/10', bar: 'bg-[#6d5dfc]', ring: 'border-[#6d5dfc]/30' },
  teal:   { text: 'text-[#2f9aa3]', chip: 'bg-[#46c2cb]/15', bar: 'bg-[#46c2cb]', ring: 'border-[#46c2cb]/30' },
  violet: { text: 'text-[#6d5dfc]', chip: 'bg-[#8b7dff]/15', bar: 'bg-[#8b7dff]', ring: 'border-[#8b7dff]/30' },
  amber:  { text: 'text-[#a36a00]', chip: 'bg-[#f5a524]/15', bar: 'bg-[#f5a524]', ring: 'border-[#f5a524]/30' },
  rose:   { text: 'text-[#e11d48]', chip: 'bg-[#fb7185]/15', bar: 'bg-[#fb7185]', ring: 'border-[#fb7185]/30' },
  slate:  { text: 'text-[#475569]', chip: 'bg-[#64748b]/15', bar: 'bg-[#64748b]', ring: 'border-[#64748b]/30' },
};

export interface KpiCardProps {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
  tone?: StatCardTone;
  variant?: CardVariant;
  onClick?: () => void;
  /**
   * Only used by the `progress` variant. Widgets pass the numbers they already
   * have — a percentage against 100, or a score against the configured target.
   * Omitted, the progress variant falls back to `outline`, because a progress
   * bar with no scale would be decoration rather than information.
   */
  progress?: { value: number; max: number };
}

/** Shared click/keyboard affordance, matching StatCard's. */
function interactive(onClick?: () => void): Record<string, unknown> {
  if (!onClick) return {};
  return {
    role: 'button',
    tabIndex: 0,
    onClick,
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
    },
  };
}

export function KpiCard({ label, value, hint, icon, tone = 'brand', variant = 'gradient', onClick, progress }: KpiCardProps): JSX.Element {
  // The original tile, unchanged.
  if (variant === 'gradient') {
    return <StatCard label={label} value={value} hint={hint} icon={icon} tone={tone} onClick={onClick} />;
  }

  const a = ACCENT[tone];
  const hover = onClick ? 'cursor-pointer transition-shadow hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40' : '';

  if (variant === 'compact') {
    return (
      <div {...interactive(onClick)} className={cn('flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-card', hover)}>
        {icon ? <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-md [&_svg]:size-4', a.chip, a.text)}>{icon}</span> : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          {hint ? <p className="truncate text-[11px] text-muted-foreground">{hint}</p> : null}
        </div>
        <p className={cn('text-xl font-extrabold tabular-nums', a.text)}>{value}</p>
      </div>
    );
  }

  if (variant === 'plain') {
    return (
      <div {...interactive(onClick)} className={cn('grid gap-0.5 rounded-lg border border-border bg-card p-5 shadow-card', hover)}>
        <p className="text-3xl font-extrabold leading-none tabular-nums">{value}</p>
        <p className="text-sm font-semibold">{label}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    );
  }

  // `progress` needs a scale; without one it is indistinguishable from `outline`.
  const showBar = variant === 'progress' && progress != null && progress.max > 0;
  const pct = showBar ? Math.max(0, Math.min(100, (progress!.value / progress!.max) * 100)) : 0;

  return (
    <div {...interactive(onClick)} className={cn('grid content-start gap-2 rounded-lg border bg-card p-5 shadow-card', a.ring, hover)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className={cn('mt-1 text-3xl font-extrabold leading-tight tabular-nums', a.text)}>{value}</p>
        </div>
        {icon ? <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5', a.chip, a.text)}>{icon}</span> : null}
      </div>

      {showBar ? (
        <div className="grid gap-1">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className={cn('h-full rounded-full transition-[width]', a.bar)} style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground">{hint ?? `${Math.round(pct)}% of ${progress!.max}`}</p>
        </div>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
