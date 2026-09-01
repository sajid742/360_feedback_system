import type { BadgeVariant } from '@/components/ui/badge';
import type { VersionStatus } from './types';

/**
 * Single source of truth for competency status → soft badge variant. Keeps the
 * semantic color mapping out of individual components (DRY). Statuses are the
 * documented lifecycle values, not raw colors.
 */
const versionStatusVariant: Record<VersionStatus, BadgeVariant> = {
  draft: 'warning',
  active: 'success',
  retired: 'neutral',
};

export function versionStatusBadge(status: VersionStatus): BadgeVariant {
  return versionStatusVariant[status];
}

export function versionStatusLabel(status: VersionStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
