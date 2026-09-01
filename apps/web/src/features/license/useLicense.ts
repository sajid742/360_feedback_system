import { useEffect, useState } from 'react';
import { licenseApi, type LicenseView } from './api';

/**
 * The licence status, fetched once per app-shell mount.
 *
 * NOT polled. A licence changes a handful of times a year, and re-checking on every
 * navigation would put two round trips on every page for information that is almost
 * always identical. The server enforces the licence regardless of what this says — this
 * exists to drive the banner and to hide modules a customer has not bought.
 */
export function useLicense(): { license: LicenseView | null; loading: boolean } {
  const [license, setLicense] = useState<LicenseView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    licenseApi
      .status()
      // A user without `configuration.read` gets a 403 here, which is not an error worth
      // showing: they simply see no banner and no module filtering beyond what the
      // server already enforces.
      .then((v) => !cancelled && setLicense(v))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  return { license, loading };
}

/** Nav keys that a licence module switches off, mapped to the module that pays for them. */
export const ROUTE_MODULE: Record<string, string> = {
  '/sis-evaluations': 'parent_feedback',
  '/student-integration': 'sis_integration',
  '/hr-integration': 'hr_integration',
  '/communication': 'communication',
  '/ai': 'ai_insights',
  '/integration': 'api_access',
  '/reports': 'reports',
};
