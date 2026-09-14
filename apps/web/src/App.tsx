import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { ToastProvider } from '@/components/ui/toast';
import { BrandingProvider } from '@/app/BrandingContext';
import { AuthProvider } from '@/features/auth/AuthContext';
import { LoginPage } from '@/features/auth/LoginPage';
import { ForgotPasswordPage, ResetPasswordPage, SetPasswordPage, EnrollMfaPage } from '@/features/auth/PasswordPages';
import { SetupPage } from '@/features/provisioning/SetupPage';
import { FeatureRoute } from '@/features/config/FeatureRoute';
import { LicensedRoute } from '@/features/license/LicensedRoute';
import { AppShell } from '@/app/AppShell';
import { RequireAuth } from '@/app/RequireAuth';

/**
 * Route-level code splitting (F26).
 *
 * Every screen used to be a static import, so one ~1.9 MB bundle had to download and
 * parse before the login form appeared — painful on a phone or a slow connection, and
 * most of it is admin tooling a given user never opens. Feature screens now load on
 * demand. The sign-in and public evaluation paths stay eager where they matter, so the
 * first paint gains nothing to wait for.
 */
const SecurityPage = lazy(() => import('@/features/auth/SecurityPage').then((m) => ({ default: m.SecurityPage })));
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const SettingsPage = lazy(() => import('@/features/config/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const OrganizationPage = lazy(() => import('@/features/organization/OrganizationPage').then((m) => ({ default: m.OrganizationPage })));
const OrgChartPage = lazy(() => import('@/features/organization/OrgChartPage').then((m) => ({ default: m.OrgChartPage })));
const CompetencyPage = lazy(() => import('@/features/competency/pages/CompetencyPage').then((m) => ({ default: m.CompetencyPage })));
const QuestionnairePage = lazy(() => import('@/features/questionnaire/QuestionnairePage').then((m) => ({ default: m.QuestionnairePage })));
const WorkflowPage = lazy(() => import('@/features/workflow/WorkflowPage').then((m) => ({ default: m.WorkflowPage })));
const AppraisalPage = lazy(() => import('@/features/appraisal/AppraisalPage').then((m) => ({ default: m.AppraisalPage })));
const ReportsPage = lazy(() => import('@/features/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const AiPage = lazy(() => import('@/features/ai/AiPage').then((m) => ({ default: m.AiPage })));
const IntegrationPage = lazy(() => import('@/features/integration/IntegrationPage').then((m) => ({ default: m.IntegrationPage })));
const DevelopmentPage = lazy(() => import('@/features/development/DevelopmentPage').then((m) => ({ default: m.DevelopmentPage })));
const CommunicationPage = lazy(() => import('@/features/communication/CommunicationPage').then((m) => ({ default: m.CommunicationPage })));
const UpgradePage = lazy(() => import('@/features/license/UpgradePage').then((m) => ({ default: m.UpgradePage })));
const SubscriptionPage = lazy(() => import('@/features/billing/SubscriptionPage').then((m) => ({ default: m.SubscriptionPage })));
const SisEvaluationPage = lazy(() => import('@/features/external-evaluation/SisEvaluationPage').then((m) => ({ default: m.SisEvaluationPage })));
const BulkGenerationPage = lazy(() => import('@/features/bulk-generation/BulkGenerationPage').then((m) => ({ default: m.BulkGenerationPage })));
const AccessControlPage = lazy(() => import('@/features/rbac/AccessControlPage').then((m) => ({ default: m.AccessControlPage })));
const IndividualReportPage = lazy(() => import('@/features/reports/IndividualReportPage').then((m) => ({ default: m.IndividualReportPage })));
const AuditTrailPage = lazy(() => import('@/features/feedback-audit/AuditTrailPage').then((m) => ({ default: m.AuditTrailPage })));
const ImportPage = lazy(() => import('@/features/org-import/ImportPage').then((m) => ({ default: m.ImportPage })));
const HrIntegrationPage = lazy(() => import('@/features/hr-integration/HrIntegrationPage').then((m) => ({ default: m.HrIntegrationPage })));
const SisIntegrationPage = lazy(() => import('@/features/sis-integration/SisIntegrationPage').then((m) => ({ default: m.SisIntegrationPage })));
const LicensePage = lazy(() => import('@/features/license/LicensePage').then((m) => ({ default: m.LicensePage })));
const BrandStudioPage = lazy(() => import('@/features/branding/BrandStudioPage').then((m) => ({ default: m.BrandStudioPage })));
const PublicEvaluationPage = lazy(() => import('@/features/external-evaluation/PublicEvaluationPage').then((m) => ({ default: m.PublicEvaluationPage })));

/** Shown while a route chunk downloads. Deliberately quiet — chunks are small. */
function RouteFallback(): JSX.Element {
  return <div className="p-6"><div className="h-40 w-full animate-pulse rounded-lg bg-muted" /></div>;
}

export function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <BrandingProvider>
      <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          {/* Public password recovery */}
          {/* First-run / operator organisation setup (F22) — public by design. */}
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          {/* Forced password change after a temporary-password login (uses the session) */}
          <Route path="/set-password" element={<SetPasswordPage />} />
          {/* Forced MFA enrolment when the org policy requires it (uses the session) */}
          <Route path="/enroll-mfa" element={<EnrollMfaPage />} />
          {/* Public, no-login parent evaluation (tokenised link) */}
          <Route path="/evaluate/:token" element={<PublicEvaluationPage />} />
          {/* Printable individual 360 report (standalone for clean print/PDF) */}
          <Route path="/reports/individual/:employeeId" element={<IndividualReportPage />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/organization" element={<OrganizationPage />} />
            <Route path="/org-chart" element={<OrgChartPage />} />
            <Route path="/competency" element={<CompetencyPage />} />
            <Route path="/questionnaire" element={<QuestionnairePage />} />
            <Route path="/workflow" element={<WorkflowPage />} />
            <Route path="/appraisal" element={<AppraisalPage />} />
            <Route path="/bulk-generation" element={<BulkGenerationPage />} />
            <Route path="/development" element={<DevelopmentPage />} />
            <Route path="/reports" element={<LicensedRoute module="reports"><ReportsPage /></LicensedRoute>} />
            {/* Server-enforced too (F27) — the flag hides the feature, not just the menu. */}
            <Route path="/ai" element={<LicensedRoute module="ai_insights"><FeatureRoute flag="ai_insights"><AiPage /></FeatureRoute></LicensedRoute>} />
            <Route path="/integration" element={<LicensedRoute module="api_access"><IntegrationPage /></LicensedRoute>} />
            <Route path="/communication" element={<LicensedRoute module="communication"><CommunicationPage /></LicensedRoute>} />
            <Route path="/sis-evaluations" element={<LicensedRoute module="parent_feedback"><SisEvaluationPage /></LicensedRoute>} />
            <Route path="/branding" element={<BrandStudioPage />} />
            <Route path="/upgrade" element={<UpgradePage />} />
            <Route path="/subscription" element={<SubscriptionPage />} />
            <Route path="/license" element={<LicensePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/access-control" element={<AccessControlPage />} />
            <Route path="/audit-trail" element={<AuditTrailPage />} />
            <Route path="/data-import" element={<ImportPage />} />
            <Route path="/hr-integration" element={<LicensedRoute module="hr_integration"><HrIntegrationPage /></LicensedRoute>} />
            <Route path="/student-integration" element={<LicensedRoute module="sis_integration"><SisIntegrationPage /></LicensedRoute>} />
            <Route path="/security" element={<SecurityPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        </BrowserRouter>
      </AuthProvider>
      </ToastProvider>
      </BrandingProvider>
    </ErrorBoundary>
  );
}
