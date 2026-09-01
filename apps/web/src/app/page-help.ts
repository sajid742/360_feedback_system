/**
 * Contextual per-page help (F29). Keyed by top-level route path; the header
 * Help button shows the entry for the current page (longest-prefix match) so a
 * new admin gets first-run guidance in-context instead of reaching for the manual.
 */
export interface PageHelp {
  title: string;
  body: string;
  steps?: string[];
}

export const PAGE_HELP: Record<string, PageHelp> = {
  '/': {
    title: 'Dashboard',
    body: 'Your organisation-wide 360° performance at a glance — participation, completion, average scores and readiness. Use the cycle selector to focus on one appraisal cycle, and Customize to rearrange the widgets.',
  },
  '/organization': {
    title: 'Organization',
    body: 'The people and structure the whole system builds on: campuses, departments, designations and employees, plus the reporting hierarchy that determines who is a manager, peer or subordinate. To see that structure drawn out, use Org Chart.',
    steps: ['Add campuses and departments', 'Add designations (job titles)', 'Add employees and set each one’s Reporting-To', 'Open any employee’s 360 Report once a cycle has scores'],
  },
  '/org-chart': {
    title: 'Org Chart',
    body: 'The organisation drawn as a picture. Units shows the department hierarchy; People shows the reporting lines between individuals — a solid edge is the line manager, a dashed edge a matrix (dotted-line) manager.',
    steps: ['Switch between Units and People', 'Search for a department or a head', 'Expand or collapse a branch', 'Click a unit card to open its details'],
  },
  '/appraisal': {
    title: 'Appraisals',
    body: 'Create and run 360° feedback cycles. A cycle defines who is reviewed, by which feedback sources, over what dates.',
    steps: ['Create a cycle (or start from a saved template)', 'Add feedback sources and enrol participants', 'Assign or nominate reviewers', 'Activate the cycle to notify reviewers', 'Track participation, then calibrate and release results'],
  },
  '/bulk-generation': {
    title: 'Bulk Generation',
    body: 'Provision a whole cycle at once — participants and reviewer/parent assignments for an entire campus, department or the whole organisation — then preview before confirming.',
  },
  '/sis-evaluations': {
    title: 'Parent Evaluations',
    body: 'Manage the secure, no-login links parents/guardians use to give feedback on a teacher, and map teachers to their student roster.',
  },
  '/reports': {
    title: 'Reports & Dashboards',
    body: 'Executive and HR dashboards, department/campus breakdowns, trends and individual reports. Aggregated views respect the anonymity threshold; individual results honour release gating.',
  },
  '/communication': {
    title: 'Communication',
    body: 'Email/SMS/WhatsApp templates, providers and campaigns used for cycle notifications, reminders and OTPs.',
  },
  '/access-control': {
    title: 'Access Control',
    body: 'Assign roles to users and review what each role can do. Roles combine a permission set with a data scope (organization, reporting line, or own records).',
    steps: ['Find a user and assign one or more roles', 'Use the effective-permissions view to confirm access', 'Reset a password or deactivate a user when needed'],
  },
  '/audit-trail': {
    title: 'Feedback Audit Trail',
    body: 'An append-only record of every action in the feedback lifecycle — who did what, when, to which cycle/participant. Filter, inspect history, and export to CSV. Content of feedback is never copied here.',
  },
  '/security': {
    title: 'Security',
    body: 'Your own security settings and organisation security policy, including the MFA enforcement policy (require MFA for all users or for administrators).',
  },
  '/data-import': {
    title: 'Data Import & Onboarding',
    body: 'Bulk-load your organisation from CSV/Excel — campuses, departments, designations, employees and competencies — with validation and a preview before anything is written.',
  },
  '/hr-integration': {
    title: 'HR Integration',
    body: 'Choose whether this app manages its own org data (Internal) or mirrors an external HR system (BambooHR, Zoho People, Generic). In external mode the org is read-only and syncs on a schedule.',
  },
  '/student-integration': {
    title: 'Student / SIS Integration',
    body: 'Bring students, guardians and teachers in for the parent-feedback workflow — from a Mock SIS, Excel/CSV, a Generic REST/SFTP feed, or OneRoster.',
  },
  '/settings': {
    title: 'Settings',
    body: 'Configure rating scales, feature flags and other organisation-wide options that shape how cycles and scoring behave.',
  },
};

/** Resolve help for a pathname by longest matching route prefix. */
export function helpForPath(pathname: string): PageHelp | null {
  if (PAGE_HELP[pathname]) return PAGE_HELP[pathname];
  const keys = Object.keys(PAGE_HELP)
    .filter((k) => k !== '/' && pathname.startsWith(k))
    .sort((a, b) => b.length - a.length);
  if (keys.length) return PAGE_HELP[keys[0]];
  return pathname === '/' ? PAGE_HELP['/'] : null;
}
