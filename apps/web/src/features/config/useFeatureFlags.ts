import { useEffect, useState } from 'react';
import { configApi } from './api';

/**
 * Feature flags that the application actually honours (F-H11).
 *
 * The Settings screen offered full create/enable/disable of feature flags, but
 * nothing in the product ever read them — an administrator could toggle a switch
 * and nothing whatsoever changed, which is worse than having no panel at all.
 *
 * Recognised keys are declared here so the Settings screen can document them and
 * the app can act on them. A flag that does not exist keeps the default, so adding
 * this changes nothing for an existing organization until an admin opts in.
 */
export const RECOGNISED_FLAGS: { key: string; label: string; description: string; defaultEnabled: boolean }[] = [
  {
    key: 'ai_insights',
    label: 'AI Insights',
    description: 'Show the AI Insights module in the main menu. Turn off to hide this early-stage feature from users.',
    defaultEnabled: true,
  },
];

export type FlagMap = Record<string, boolean>;

function defaults(): FlagMap {
  return Object.fromEntries(RECOGNISED_FLAGS.map((f) => [f.key, f.defaultEnabled]));
}

/**
 * Read the org's feature flags. Reading flags requires a permission that lower
 * roles don't hold, so a failure quietly falls back to defaults rather than
 * surfacing an error — flags must never block the app from rendering.
 */
export function useFeatureFlags(): FlagMap {
  const [flags, setFlags] = useState<FlagMap>(defaults);

  useEffect(() => {
    let cancelled = false;
    configApi
      .listFeatureFlags()
      .then((rows) => {
        if (cancelled) return;
        const map = defaults();
        for (const row of rows) {
          if (row.key in map) map[row.key] = row.isEnabled;
        }
        setFlags(map);
      })
      .catch(() => {
        /* no permission or unavailable — keep defaults */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return flags;
}
