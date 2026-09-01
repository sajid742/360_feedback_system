import { useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { reportsApi, type Individual } from './api';

/**
 * Printable individual 360° feedback report (F14). Standalone (no app chrome) so it
 * prints / saves-to-PDF cleanly via the browser. Reuses the existing
 * GET /reports/individual/:id data (scores, competencies, gaps, anonymised sources).
 */
function band(gap: number): { label: string; cls: string } {
  if (gap >= 0) return { label: 'Ready', cls: 'ready' };
  if (gap >= -1) return { label: 'Developing', cls: 'developing' };
  return { label: 'At risk', cls: 'atrisk' };
}

export function IndividualReportPage(): JSX.Element {
  const { employeeId = '' } = useParams();
  const [params] = useSearchParams();
  const cycleId = params.get('cycleId') ?? undefined;
  const { token } = useAuth();
  const navigate = useNavigate();
  const [report, setReport] = useState<Individual | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) { navigate('/login', { replace: true }); return; }
    reportsApi
      .individual(employeeId, cycleId)
      .then(setReport)
      .catch(() => setError('This report is not available, or you do not have access to it.'));
  }, [employeeId, cycleId, token, navigate]);

  if (error) return <div className="p-10 text-center text-sm text-red-600">{error}</div>;
  if (!report) return <div className="p-10 text-center text-sm text-muted-foreground">Loading report…</div>;

  const printedOn = new Date().toLocaleDateString();
  const trend =
    report.overallScore != null && report.previousOverall != null
      ? report.overallScore - report.previousOverall
      : null;

  return (
    <div className="report-root">
      <style>{`
        .report-root{max-width:900px;margin:0 auto;padding:28px;color:#1f2430;font-size:14px;line-height:1.5;}
        .report-root h1{font-size:24px;font-weight:800;margin:0;}
        .report-root h2{font-size:16px;font-weight:700;margin:22px 0 8px;border-bottom:2px solid #e5e8ef;padding-bottom:4px;color:#333b49;}
        .rp-actions{display:flex;justify-content:flex-end;gap:8px;margin-bottom:12px;}
        .rp-btn{border:1px solid #d5d9e2;border-radius:6px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;background:#fff;}
        .rp-btn.primary{background:#6D5DFC;color:#fff;border-color:#6D5DFC;}
        .rp-head{border-bottom:3px solid #6D5DFC;padding-bottom:12px;}
        .rp-muted{color:#5b6472;font-size:13px;}
        .rp-kpis{display:flex;gap:16px;margin:16px 0;}
        .rp-kpi{flex:1;border:1px solid #e5e8ef;border-radius:8px;padding:14px;text-align:center;}
        .rp-kpi .v{font-size:28px;font-weight:800;}
        table{border-collapse:collapse;width:100%;font-size:13.5px;}
        th,td{border:1px solid #e5e8ef;padding:7px 10px;text-align:left;}
        th{background:#eef0f7;}
        .tag{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;}
        .tag.ready{background:#e5f6ee;color:#127a4f;}
        .tag.developing{background:#fdf3e5;color:#a86a12;}
        .tag.atrisk{background:#fdecec;color:#b42222;}
        .rp-cmt{border:1px solid #e5e8ef;border-radius:8px;padding:10px 12px;margin-bottom:10px;break-inside:avoid;}
        .rp-q{font-weight:700;font-size:13.5px;margin-bottom:6px;}
        .rp-self{background:#f5f4ff;border-left:3px solid #6D5DFC;padding:6px 10px;border-radius:0 6px 6px 0;margin-bottom:6px;font-size:13.5px;}
        .rp-tagline{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6D5DFC;}
        .rp-cmt ul{margin:4px 0 0 18px;padding:0;font-size:13.5px;}
        .rp-cmt li{margin-bottom:4px;}
        @media print{ .rp-actions{display:none;} .report-root{padding:0;} @page{margin:16mm;} }
      `}</style>

      <div className="rp-actions">
        <button className="rp-btn" onClick={() => window.close()}>Close</button>
        <button className="rp-btn primary" onClick={() => window.print()}>Print / Save as PDF</button>
      </div>

      <div className="rp-head">
        <div className="rp-muted" style={{ letterSpacing: 2, textTransform: 'uppercase' }}>360° Feedback Report</div>
        <h1>{report.employee.name}</h1>
        <div className="rp-muted">{report.employee.designation ?? '—'} · Generated {printedOn}</div>
      </div>

      <div className="rp-kpis">
        <div className="rp-kpi">
          <div className="rp-muted">Overall score</div>
          <div className="v">{report.overallScore != null ? report.overallScore.toFixed(2) : '—'}</div>
        </div>
        <div className="rp-kpi">
          <div className="rp-muted">Previous</div>
          <div className="v">{report.previousOverall != null ? report.previousOverall.toFixed(2) : '—'}</div>
        </div>
        <div className="rp-kpi">
          <div className="rp-muted">Trend</div>
          <div className="v">{trend == null ? '—' : `${trend >= 0 ? '▲ +' : '▼ '}${trend.toFixed(2)}`}</div>
        </div>
      </div>

      <h2>Competency results</h2>
      <table>
        <thead><tr><th>Competency</th><th>Score</th><th>Gap vs target</th><th>Readiness</th></tr></thead>
        <tbody>
          {report.byCompetency.map((c) => {
            const g = report.gap.find((x) => x.competency === c.competency);
            const gap = g ? g.gap : 0;
            const b = band(gap);
            return (
              <tr key={c.competency}>
                <td>{c.competency}</td>
                <td>{c.score.toFixed(2)}</td>
                <td>{gap >= 0 ? `+${gap.toFixed(2)}` : gap.toFixed(2)}</td>
                <td><span className={`tag ${b.cls}`}>{b.label}</span></td>
              </tr>
            );
          })}
          {report.byCompetency.length === 0 ? <tr><td colSpan={4} className="rp-muted">No competency data yet.</td></tr> : null}
        </tbody>
      </table>

      <h2>Feedback by source</h2>
      <p className="rp-muted">To protect reviewer anonymity, a source is only shown once it has at least {report.minResponses} responses. Self assessment is always shown.</p>
      <table>
        <thead><tr><th>Source</th><th>Responses</th><th>Score</th></tr></thead>
        <tbody>
          {report.bySource.map((s) => (
            <tr key={s.source}>
              <td>{s.source}</td>
              <td>{s.reviewers}</td>
              <td>
                {s.suppressed ? (
                  <span className="rp-muted">Confidential (below {report.minResponses} responses)</span>
                ) : s.score != null ? (
                  <>
                    {s.score.toFixed(2)}
                    {report.confidentialUnlocked && s.reviewers > 0 && s.reviewers < report.minResponses ? (
                      <span className="rp-muted"> (below {report.minResponses} — shown under elevated access)</span>
                    ) : null}
                  </>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
          {report.bySource.length === 0 ? <tr><td colSpan={3} className="rp-muted">No feedback submitted yet.</td></tr> : null}
        </tbody>
      </table>

      <h2>Top strengths</h2>
      <ul>{report.strengths.map((s) => <li key={s.competency}>{s.competency} ({s.score.toFixed(2)})</li>)}</ul>
      <h2>Development areas</h2>
      <ul>{report.weaknesses.map((s) => <li key={s.competency}>{s.competency} ({s.score.toFixed(2)})</li>)}</ul>

      {/* Written feedback (F-C7) — anonymised and pooled across sources. */}
      {report.comments && report.comments.length > 0 ? (
        <>
          <h2>Written feedback</h2>
          <p className="rp-muted">
            Comments are shown anonymously and pooled across reviewers, so no comment can be traced back to an
            individual. A group is withheld until it reaches {report.minResponses} responses.
          </p>
          {report.comments.map((c) => (
            <div className="rp-cmt" key={c.question}>
              <div className="rp-q">{c.question}</div>
              {c.self.length > 0 ? (
                <div className="rp-self">
                  <span className="rp-tagline">Self assessment</span>
                  {c.self.map((t, i) => <p key={i} style={{ margin: '2px 0' }}>{t}</p>)}
                </div>
              ) : null}
              {c.suppressed ? (
                <p className="rp-muted">
                  Confidential — {c.othersCount} response{c.othersCount === 1 ? '' : 's'} received; shown once there
                  are at least {report.minResponses}.
                </p>
              ) : c.others.length > 0 ? (
                <ul>{c.others.map((t, i) => <li key={i}>{t}</li>)}</ul>
              ) : (
                <p className="rp-muted">No written feedback for this question.</p>
              )}
            </div>
          ))}
        </>
      ) : null}

      <p className="rp-muted" style={{ marginTop: 28, borderTop: '1px solid #e5e8ef', paddingTop: 10 }}>
        Confidential — this 360° feedback report is intended for the named individual and authorised HR/management only.
      </p>
    </div>
  );
}
