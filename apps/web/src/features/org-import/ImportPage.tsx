import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api-client';
import { fileToBase64, orgImportApi, type ImportEntity, type ImportMode, type ImportResult, type ValidationResult } from './api';

const MODE_LABEL: Record<ImportMode, string> = {
  skip: 'Add new · skip existing',
  update: 'Add new · update existing',
  replace: 'Replace all (delete, then import)',
  reset: 'Reset only (delete existing data)',
};
const MODE_HELP: Record<ImportMode, string> = {
  skip: 'Creates records that don’t exist yet and leaves existing ones untouched.',
  update: 'Creates new records and updates existing ones (matched by code/name).',
  replace: 'Deletes all existing employees, departments, designations, campuses and competencies for this organization, then imports the file. Destructive.',
  reset: 'Deletes all existing employees, departments, designations, campuses and competencies for this organization. Imports nothing. Destructive.',
};
const ENTITIES: ImportEntity[] = ['campuses', 'departments', 'designations', 'employees', 'competencies'];
const STEPS = ['Upload', 'Validate', 'Preview', 'Confirm', 'Import', 'Verify'];

export function ImportPage(): JSX.Element {
  const [step, setStep] = useState<'upload' | 'review' | 'done'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [csvEntity, setCsvEntity] = useState<ImportEntity>('employees');
  // A flat staff CSV is still an employees file; the flag only changes whether the
  // master data it references is derived or required.
  const [flatCsv, setFlatCsv] = useState(true);
  const [mode, setMode] = useState<ImportMode>('skip');
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [ack, setAck] = useState(false);
  const [defaultPassword, setDefaultPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const isCsv = !!file && /\.csv$/i.test(file.name);
  const destructive = mode === 'replace' || mode === 'reset';
  const activeStep = step === 'upload' ? 0 : step === 'review' ? 2 : 5;

  async function validate() {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const contentBase64 = await fileToBase64(file);
      const res = await orgImportApi.validate({
        filename: file.name,
        contentBase64,
        entity: isCsv ? csvEntity : undefined,
        flat: isCsv && csvEntity === 'employees' ? flatCsv : undefined,
        mode,
      });
      setResult(res); setStep('review'); setAck(false);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Validation failed.'); }
    finally { setBusy(false); }
  }

  async function changeMode(next: ImportMode) {
    setMode(next); setAck(false);
    if (!result) return;
    setBusy(true);
    try { setResult(await orgImportApi.preview(result.jobId, next)); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Preview failed.'); }
    finally { setBusy(false); }
  }

  async function runImport() {
    if (!result) return;
    setBusy(true); setError(null);
    try {
      const res = await orgImportApi.confirm(result.jobId, { mode, confirmDestructive: destructive ? ack : undefined, defaultPassword: defaultPassword || undefined });
      setImported(res); setStep('done');
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Import failed.'); }
    finally { setBusy(false); }
  }

  function reset() {
    setStep('upload'); setFile(null); setResult(null); setImported(null); setAck(false); setDefaultPassword(''); setError(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <div className="grid gap-6">
      <div>
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><FileSpreadsheet className="size-4" /></span>
          <h1 className="text-2xl font-extrabold tracking-tight">Data Import & Onboarding</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Initialize this organization from a spreadsheet — campuses, departments, designations, employees and their reporting lines. Nothing is written until you confirm. (SIS / students / parents are handled separately.)
        </p>
      </div>

      <Stepper active={activeStep} />

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {step === 'upload' && (
        <Card className="grid gap-4 p-5">
          <div>
            <h2 className="text-sm font-bold">1 · Download a template</h2>
            <p className="text-sm text-muted-foreground">Two templates, one importer. Pick the shape your data is already in.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => orgImportApi.downloadStaffTemplate('xlsx')}><Download className="size-4" /> Staff list (1 sheet)</Button>
              <Button variant="outline" size="sm" onClick={() => orgImportApi.downloadTemplate('xlsx')}><Download className="size-4" /> Full template (all sheets)</Button>
              <span className="text-xs text-muted-foreground">or a single-sheet CSV:</span>
              {ENTITIES.map((e) => (
                <Button key={e} variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => orgImportApi.downloadTemplate('csv', e)}>{e}.csv</Button>
              ))}
            </div>
            {/*
              The single sheet is not a cut-down version. It carries the same columns as
              the Employees sheet; what it adds is that the departments, designations and
              campuses named in it are CREATED from the list, so an HR user with one staff
              export does not have to hand-build three more sheets to satisfy referential
              integrity. Same importer, same validation, same upsert on employee code.
            */}
            <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              <div className="rounded-md border border-border p-2.5">
                <div className="font-semibold text-foreground">Staff list — one sheet</div>
                <strong>One row per employee.</strong> Departments, designations and campuses are created
                automatically from what you type in those columns, so there is nothing to set up first.
                The preview tells you exactly which new records it is about to create. Use this if you
                have a staff list and nothing else.
              </div>
              <div className="rounded-md border border-border p-2.5">
                <div className="font-semibold text-foreground">Full template — all sheets</div>
                Organization, Campuses, Departments, Designations, Employees and Competencies as separate
                sheets. Use it when you need parent departments, seniority levels or promotion paths —
                things a staff list cannot express. Same result, same importer.
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Either way, an employee is matched on <code>Employee Code</code>: importing the same person
              again updates them and never creates a second record, so their appraisal history and the
              feedback already collected about them stay attached. Choose <strong>Insert new + update
              existing</strong> below to apply changes to people who already exist. On an update, a blank
              cell leaves the stored value alone.
            </p>
          </div>

          {/* Export the CURRENT data in the same layout — round-trippable (F-H6). */}
          <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3">
            <h2 className="text-sm font-bold">Export current data</h2>
            <p className="text-sm text-muted-foreground">
              Download your existing organization, campuses, departments, designations, employees and competencies in the
              same layout as the template — for reconciling against your HR system, keeping an offline copy, or editing in
              bulk and re-importing. Passwords are never exported.
            </p>
            <div className="mt-2">
              <Button variant="outline" size="sm" onClick={() => orgImportApi.exportData('xlsx')}>
                <Download className="size-4" /> Export organization data (Excel)
              </Button>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <h2 className="text-sm font-bold">2 · Upload your file</h2>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white hover:file:bg-brand-dark" />
              {isCsv && (
                <label className="flex items-center gap-1 text-sm text-muted-foreground">This CSV contains:
                  <select value={csvEntity} onChange={(e) => setCsvEntity(e.target.value as ImportEntity)} className="h-9 rounded-md border border-input bg-card px-2 text-sm text-foreground">
                    {ENTITIES.map((e) => <option key={e} value={e}>{e}</option>)}
                  </select>
                </label>
              )}
            </div>
            {/* An .xlsx says so by naming its sheet "Staff"; a CSV has no sheet name. */}
            {isCsv && csvEntity === 'employees' && (
              <label className="mt-2 flex items-start gap-2 text-sm text-muted-foreground">
                <input type="checkbox" checked={flatCsv} onChange={(e) => setFlatCsv(e.target.checked)} className="mt-0.5" />
                <span>
                  Create any departments, designations and campuses this file names
                  <span className="block text-xs">
                    Leave it ticked for a plain staff list. Untick it to require that they already exist,
                    which catches typos but means setting them up first.
                  </span>
                </span>
              </label>
            )}
          </div>

          <div className="border-t border-border pt-4">
            <h2 className="text-sm font-bold">3 · Import mode</h2>
            <ModePicker mode={mode} onChange={setMode} />
          </div>

          <div>
            <Button onClick={validate} disabled={!file || busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Validate &amp; preview
            </Button>
          </div>
        </Card>
      )}

      {step === 'review' && result && (
        <ReviewStep
          result={result} mode={mode} busy={busy} ack={ack} destructive={destructive}
          defaultPassword={defaultPassword} setDefaultPassword={setDefaultPassword} setAck={setAck}
          onChangeMode={changeMode} onImport={runImport} onBack={reset}
        />
      )}

      {step === 'done' && imported && (
        <DoneStep imported={imported} onReport={() => imported && orgImportApi.downloadReport(imported.jobId)} onAgain={reset} />
      )}
    </div>
  );
}

function Stepper({ active }: { active: number }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {STEPS.map((s, i) => (
        <span key={s} className="flex items-center gap-1">
          <span className={`flex size-5 items-center justify-center rounded-full text-[10px] font-bold ${i <= active ? 'bg-brand text-white' : 'bg-muted text-muted-foreground'}`}>{i + 1}</span>
          <span className={i <= active ? 'font-semibold' : 'text-muted-foreground'}>{s}</span>
          {i < STEPS.length - 1 && <span className="mx-1 text-muted-foreground">→</span>}
        </span>
      ))}
    </div>
  );
}

function ModePicker({ mode, onChange }: { mode: ImportMode; onChange: (m: ImportMode) => void }): JSX.Element {
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {(Object.keys(MODE_LABEL) as ImportMode[]).map((m) => {
        const destructive = m === 'replace' || m === 'reset';
        return (
          <label key={m} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${mode === m ? 'border-brand bg-brand/5' : 'border-border'}`}>
            <input type="radio" name="mode" checked={mode === m} onChange={() => onChange(m)} className="mt-0.5" />
            <span>
              <span className="font-semibold">{MODE_LABEL[m]} {destructive && <Badge variant="danger">destructive</Badge>}</span>
              <span className="block text-xs text-muted-foreground">{MODE_HELP[m]}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function ReviewStep(props: {
  result: ValidationResult; mode: ImportMode; busy: boolean; ack: boolean; destructive: boolean;
  defaultPassword: string; setDefaultPassword: (s: string) => void; setAck: (b: boolean) => void;
  onChangeMode: (m: ImportMode) => void; onImport: () => void; onBack: () => void;
}): JSX.Element {
  const { result, mode, busy, ack, destructive } = props;
  const withData = useMemo(() => result.counts.filter((c) => c.parsed > 0), [result]);

  return (
    <div className="grid gap-4">
      {/* Counts */}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold">Preview — what will happen</h2>
          {result.canImport
            ? <Badge variant="success">Ready to import</Badge>
            : <Badge variant="danger">{result.errors.length} error{result.errors.length === 1 ? '' : 's'} — fix before importing</Badge>}
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="py-1 pr-4">Entity</th><th className="py-1 pr-4">In file</th><th className="py-1 pr-4">Create</th><th className="py-1 pr-4">Update</th><th className="py-1 pr-4">Skip</th><th className="py-1">Already in system</th></tr>
            </thead>
            <tbody>
              {withData.map((c) => (
                <tr key={c.entity} className="border-t border-border/60">
                  <td className="py-1.5 pr-4 font-medium capitalize">{c.entity}</td>
                  <td className="py-1.5 pr-4">{c.parsed}</td>
                  <td className="py-1.5 pr-4 text-emerald-600">{c.toCreate}</td>
                  <td className="py-1.5 pr-4 text-amber-600">{c.toUpdate}</td>
                  <td className="py-1.5 pr-4 text-muted-foreground">{c.toSkip}</td>
                  <td className="py-1.5 text-muted-foreground">{result.existing[c.entity] ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Errors + warnings */}
      {(result.errors.length > 0 || result.warnings.length > 0) && (
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold">Validation</h2>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => orgImportApi.downloadReport(result.jobId)}><Download className="size-3.5" /> Error report (CSV)</Button>
          </div>
          <IssueList title="Errors (block import)" issues={result.errors} tone="danger" />
          <IssueList title="Warnings (allowed)" issues={result.warnings} tone="warning" />
        </Card>
      )}

      {/* Sample preview */}
      <Card className="p-4">
        <h2 className="text-sm font-bold">Sample rows</h2>
        <div className="mt-2 grid gap-3">
          {Object.entries(result.preview).filter(([, rows]) => rows.length > 0).map(([entity, rows]) => (
            <div key={entity}>
              <div className="text-xs font-semibold capitalize text-muted-foreground">{entity}</div>
              <div className="overflow-x-auto">
                <table className="mt-1 w-full text-xs">
                  <thead className="text-left text-muted-foreground"><tr>{Object.keys(rows[0]).map((k) => <th key={k} className="py-0.5 pr-3 font-medium">{k}</th>)}</tr></thead>
                  <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-border/50">{Object.keys(rows[0]).map((k) => <td key={k} className="py-0.5 pr-3">{String(r[k] ?? '')}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Confirm */}
      <Card className="grid gap-3 p-4">
        <h2 className="text-sm font-bold">Confirm &amp; import</h2>
        <ModePicker mode={mode} onChange={props.onChangeMode} />
        {mode === 'skip' || mode === 'update' ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">Default password for new logins (optional):
            <Input value={props.defaultPassword} onChange={(e) => props.setDefaultPassword(e.target.value)} placeholder="leave blank to keep logins disabled" className="h-8 w-64" />
          </label>
        ) : null}
        {destructive && (
          <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm">
            <div className="flex items-center gap-2 font-semibold text-danger"><AlertTriangle className="size-4" /> Destructive operation</div>
            <p className="mt-1 text-danger/90">This will permanently remove existing employees, departments, designations, campuses and competencies for this organization (system settings, roles and permissions are never touched).{result.activeCycleCount > 0 && <> <strong>{result.activeCycleCount} active/closed feedback cycle(s)</strong> reference this data and may be affected.</>}</p>
            <label className="mt-2 flex items-center gap-2 font-medium text-danger"><input type="checkbox" checked={ack} onChange={(e) => props.setAck(e.target.checked)} /> I understand this cannot be undone.</label>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={props.onBack}><X className="size-4" /> Start over</Button>
          <Button onClick={props.onImport} disabled={busy || (!result.canImport && mode !== 'reset') || (destructive && !ack)}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} {mode === 'reset' ? 'Reset organization data' : 'Import now'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function IssueList({ title, issues, tone }: { title: string; issues: ValidationResult['errors']; tone: 'danger' | 'warning' }): JSX.Element | null {
  if (!issues.length) return null;
  return (
    <div className="mt-3">
      <div className={`text-xs font-semibold ${tone === 'danger' ? 'text-danger' : 'text-amber-600'}`}>{title} · {issues.length}</div>
      <ul className="mt-1 max-h-52 space-y-0.5 overflow-y-auto text-xs">
        {issues.slice(0, 200).map((i, idx) => (
          <li key={idx} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">{i.entity}{i.row ? ` r${i.row}` : ''}{i.key ? ` · ${i.key}` : ''}:</span>
            <span>{i.message}</span>
          </li>
        ))}
        {issues.length > 200 && <li className="text-muted-foreground">…and {issues.length - 200} more (see the CSV report).</li>}
      </ul>
    </div>
  );
}

function DoneStep({ imported, onReport, onAgain }: { imported: ImportResult; onReport: () => void; onAgain: () => void }): JSX.Element {
  const s = imported.summary;
  return (
    <div className="grid gap-4">
      <Card className="p-4">
        <div className="flex items-center gap-2 text-emerald-600"><CheckCircle2 className="size-5" /> <h2 className="text-base font-bold">Import complete</h2><Badge variant="neutral" className="capitalize">{s.mode}</Badge></div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="py-1 pr-4">Entity</th><th className="py-1 pr-4">Processed</th><th className="py-1 pr-4">Created</th><th className="py-1 pr-4">Updated</th><th className="py-1 pr-4">Skipped</th><th className="py-1">Failed</th></tr>
            </thead>
            <tbody>
              {s.perEntity.filter((e) => e.processed > 0).map((e) => (
                <tr key={e.entity} className="border-t border-border/60">
                  <td className="py-1.5 pr-4 font-medium capitalize">{e.entity}</td>
                  <td className="py-1.5 pr-4">{e.processed}</td>
                  <td className="py-1.5 pr-4 text-emerald-600">{e.created}</td>
                  <td className="py-1.5 pr-4 text-amber-600">{e.updated}</td>
                  <td className="py-1.5 pr-4 text-muted-foreground">{e.skipped}</td>
                  <td className={`py-1.5 ${e.failed ? 'text-danger' : 'text-muted-foreground'}`}>{e.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-bold">Verify — current organization totals</h2>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {Object.entries(imported.verify).map(([k, v]) => (
            <div key={k} className="rounded-md border border-border p-2">
              <div className="text-lg font-extrabold">{v}</div>
              <div className="text-[11px] capitalize text-muted-foreground">{k.replace(/([A-Z])/g, ' $1')}</div>
            </div>
          ))}
        </div>
        {s.warnings.length > 0 && <p className="mt-2 text-xs text-amber-600">{s.warnings.length} warning(s) recorded — download the report for details.</p>}
      </Card>

      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onReport}><Download className="size-4" /> Download report</Button>
        <Button onClick={onAgain}><Upload className="size-4" /> Import another file</Button>
      </div>
    </div>
  );
}
