import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { BarChart3, Building2, ClipboardCheck, ClipboardList, Cloud, FileSpreadsheet, GitBranch, GraduationCap, Layers, LayoutDashboard, ListChecks, LogOut, Menu, MessageSquare, KeyRound, Network, Palette, Plug, ScrollText, Settings, ShieldCheck, Sparkles, Target, UserCog, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth, usePermissions } from '@/features/auth/AuthContext';
import { NotificationBell } from '@/features/notifications/NotificationBell';
import { useFeatureFlags } from '@/features/config/useFeatureFlags';
import { PageHelpButton } from './PageHelpButton';
import { useBranding } from '@/app/BrandingContext';
import { ROUTE_MODULE, useLicense } from '@/features/license/useLicense';
import { LicenseBanner } from '@/features/license/LicenseBanner';

interface NavItem {
  to: string;
  label: string;
  icon: JSX.Element;
  perm?: string; // permission required to see this item (omitted = always shown)
}

// Flat menu ordered to follow the natural 360 workflow: start at the dashboard;
// build the foundation (organization → competencies → questionnaires); run the
// evaluations (appraisals → bulk generation → parent evaluations); follow up and
// process (development → workflows → communication); analyse (reports → AI); then
// administer & configure (integration → access control → security → settings).
// Order only — labels, routes and RBAC permissions are unchanged; `perm` still
// controls per-role visibility.
const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: <LayoutDashboard /> },
  { to: '/organization', label: 'Organization', icon: <Building2 />, perm: 'organization.read' },
  // Sits beside Organization and shares its permission: the chart reads the same two
  // endpoints (departments/tree and org-chart), both gated by `organization.read`.
  { to: '/org-chart', label: 'Org Chart', icon: <Network />, perm: 'organization.read' },
  { to: '/competency', label: 'Competencies', icon: <Target />, perm: 'competency.read' },
  { to: '/questionnaire', label: 'Questionnaires', icon: <ClipboardList />, perm: 'questionnaire.read' },
  { to: '/appraisal', label: 'Appraisals', icon: <ClipboardCheck />, perm: 'appraisal.read' },
  { to: '/bulk-generation', label: 'Bulk Generation', icon: <Layers />, perm: 'appraisal.cycle.manage' },
  { to: '/sis-evaluations', label: 'Parent Evaluations', icon: <GraduationCap />, perm: 'external.evaluation.manage' },
  { to: '/development', label: 'Development', icon: <ListChecks />, perm: 'development.read' },
  { to: '/workflow', label: 'Workflows', icon: <GitBranch />, perm: 'workflow.read' },
  { to: '/communication', label: 'Communication', icon: <MessageSquare />, perm: 'communication.read' },
  { to: '/reports', label: 'Reports', icon: <BarChart3 />, perm: 'reports.read' },
  { to: '/ai', label: 'AI Insights', icon: <Sparkles />, perm: 'ai.read' },
  { to: '/integration', label: 'Integration', icon: <Plug />, perm: 'integration.read' },
  { to: '/access-control', label: 'Access Control', icon: <UserCog />, perm: 'security.rbac.manage' },
  { to: '/audit-trail', label: 'Audit Trail', icon: <ScrollText />, perm: 'feedback.audit.read' },
  // Self-service security (password, MFA enrolment, backup codes) must be reachable
  // by EVERY signed-in user — it was gated on a permission no standard role holds, so
  // a user required to enrol in MFA could never reach the page to do it, or to
  // retrieve backup codes if they lost their authenticator (F-H10). The page gates
  // its own organisation-policy card separately.
  { to: '/security', label: 'Security', icon: <ShieldCheck /> },
  { to: '/data-import', label: 'Data Import', icon: <FileSpreadsheet />, perm: 'organization.import.manage' },
  { to: '/hr-integration', label: 'HR Integration', icon: <Cloud />, perm: 'organization.hr.manage' },
  { to: '/student-integration', label: 'Student Integration', icon: <GraduationCap />, perm: 'organization.sis.manage' },
  // Same permission as the Communication branding form it replaces, so no role
  // gains or loses access as a result of the move.
  { to: '/branding', label: 'Brand Studio', icon: <Palette />, perm: 'communication.manage' },
  { to: '/license', label: 'Licence', icon: <KeyRound />, perm: 'configuration.read' },
  { to: '/settings', label: 'Settings', icon: <Settings />, perm: 'configuration.read' },
];

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }): JSX.Element {
  return (
    <nav className="flex-1 space-y-1 px-3 py-2">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors [&_svg]:size-4',
              isActive ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white',
            )
          }
        >
          {item.icon}
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

function SidebarBrand(): JSX.Element {
  const branding = useBranding();
  return (
    <div className="flex items-center gap-2 px-5 py-5">
      {branding.logoUrl ? (
        <img src={branding.logoUrl} alt="" className="h-9 max-w-[7rem] object-contain" />
      ) : (
        <span className="flex size-9 items-center justify-center rounded-lg bg-white/10 text-sm font-extrabold">
          {branding.shortName || '360'}
        </span>
      )}
      {/* Clients choose their own product name, and some are long. Step the size down
          rather than truncating, which reads as a bug. */}
      <span className={`min-w-0 font-bold leading-tight ${branding.appName.length > 16 ? 'text-xs' : branding.appName.length > 12 ? 'text-sm' : ''}`}>
        {branding.appName}
      </span>
    </div>
  );
}

/** App chrome: dark gradient sidebar + sticky topbar (reference design).
 *  Responsive (F13): the sidebar collapses below `lg` into a hamburger-triggered
 *  slide-in drawer so managers/employees can navigate on phones and tablets. */
export function AppShell(): JSX.Element {
  const { user, logout } = useAuth();
  const branding = useBranding();
  const { has } = usePermissions();
  // Feature flags now actually gate something (F-H11): an org can hide the
  // early-stage AI Insights module. Unset flags keep the previous behaviour.
  const flags = useFeatureFlags();
  const { license } = useLicense();
  const nav = NAV.filter((item) => !item.perm || has(item.perm))
    .filter((item) => item.to !== '/ai' || flags.ai_insights !== false)
    // Licence gating sits ALONGSIDE permissions, never instead of them: a permission
    // says this user may, a licence says this organisation bought it. Both must hold.
    // Hiding here is a courtesy — every one of these APIs refuses server-side too.
    .filter((item) => {
      const module = ROUTE_MODULE[item.to];
      if (!module || !license) return true;
      return license.modules.some((m) => m.key === module);
    });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Close the drawer on route change and lock body scroll while it's open.
  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileOpen]);

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col text-white lg:flex print:hidden"
        style={{ background: 'var(--sidebar-gradient)' }}>
        <SidebarBrand />
        <NavLinks items={nav} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden print:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 max-w-[80%] flex-col text-white shadow-xl"
            style={{ background: 'var(--sidebar-gradient)' }}>
            <div className="flex items-center justify-between pr-3">
              <SidebarBrand />
              <button
                onClick={() => setMobileOpen(false)}
                className="flex size-9 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white"
                aria-label="Close menu"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <NavLinks items={nav} onNavigate={() => setMobileOpen(false)} />
            </div>
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-2 border-b border-border bg-card/80 px-4 backdrop-blur sm:px-6 print:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <button
              onClick={() => setMobileOpen(true)}
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="size-5" />
            </button>
            <div className="truncate text-sm text-muted-foreground">{user?.organizationId ? branding.organizationName || 'Workspace' : ''}</div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <PageHelpButton />
            <NotificationBell />
            <div className="hidden text-right sm:block">
              <p className="text-sm font-semibold leading-tight">{user?.fullName ?? user?.email}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
            </div>
            <button
              onClick={logout}
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Log out"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </header>

        <LicenseBanner license={license} />
        <main className="flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
