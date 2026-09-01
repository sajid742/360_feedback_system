import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Badge with the reference "soft" color system. Semantic variants
 * (success/warning/danger/info) map cleanly onto domain statuses so callers
 * never hardcode raw color classes.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-brand text-white',
        outline: 'border border-border text-foreground',
        success: 'badge-soft-success',
        warning: 'badge-soft-warning',
        danger: 'badge-soft-danger',
        info: 'badge-soft-info',
        brand: 'badge-soft-brand',
        neutral: 'badge-soft-neutral',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
