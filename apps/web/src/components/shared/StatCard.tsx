import * as React from 'react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Reusable gradient KPI tile used across module "stats rows" (Organization,
 * Competency, and later dashboards). Gradient is chosen from a small named set
 * so every module's tiles stay visually consistent without ad-hoc color values.
 */
export type StatCardTone = 'brand' | 'teal' | 'violet' | 'amber' | 'rose' | 'slate';

const toneGradients: Record<StatCardTone, string> = {
  brand: 'from-[#6d5dfc] to-[#5346d9]',
  teal: 'from-[#46c2cb] to-[#2f9aa3]',
  violet: 'from-[#8b7dff] to-[#6d5dfc]',
  amber: 'from-[#f5a524] to-[#e08a00]',
  rose: 'from-[#fb7185] to-[#e11d48]',
  slate: 'from-[#64748b] to-[#475569]',
};

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  tone?: StatCardTone;
  hint?: string;
  loading?: boolean;
  className?: string;
  onClick?: () => void;
}

export function StatCard({
  label,
  value,
  icon,
  tone = 'brand',
  hint,
  loading = false,
  className,
  onClick,
}: StatCardProps): JSX.Element {
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      className={cn(
        'relative overflow-hidden rounded-lg bg-gradient-to-br p-5 text-white shadow-card',
        toneGradients[tone],
        onClick && 'cursor-pointer transition-transform hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-white/80">{label}</p>
          {loading ? (
            <Skeleton className="mt-2 h-8 w-16 bg-white/30" />
          ) : (
            <p className="mt-1 text-3xl font-extrabold leading-tight">{value}</p>
          )}
          {hint ? <p className="mt-1 text-xs text-white/70">{hint}</p> : null}
        </div>
        {icon ? (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/20 [&_svg]:size-5">
            {icon}
          </span>
        ) : null}
      </div>
    </div>
  );
}
