import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronsUpDown, Search, X } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

export interface GridColumn {
  key: string;
  label: string;
  numeric?: boolean;
}
export interface GridData {
  columns: GridColumn[];
  rows: Record<string, unknown>[];
}

/**
 * Chrome shared by every drill-down level: backdrop, panel, title, optional Back,
 * and Close. Extracted so a deeper level (an employee's 360 profile) sits in the
 * same frame rather than a second, subtly different modal.
 */
export function DrilldownShell({
  title,
  subtitle,
  onBack,
  onClose,
  toolbar,
  children,
  wide,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  onClose: () => void;
  toolbar?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className={`flex max-h-[88vh] w-full ${wide ? 'max-w-5xl' : 'max-w-4xl'} flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="flex min-w-0 items-start gap-2">
            {onBack ? (
              <button
                onClick={onBack}
                className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              >
                <ChevronLeft className="size-3.5" /> Back
              </button>
            ) : null}
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold">{title}</h2>
              {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        {toolbar}
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}

/**
 * Reusable drill-down grid shown in a modal. Any dashboard element can open it
 * with a title and a { columns, rows } payload. Provides a global search box
 * (filters across all cells) and click-to-sort column headers — all client-side,
 * since drill-down result sets are small.
 *
 * When `onRowClick` is supplied the rows become a drill-down of their own — the
 * dashboards use this to go from a filtered employee list to one person's 360
 * breakdown.
 */
export function DataGridModal({
  title,
  subtitle,
  data,
  loading,
  onClose,
  onBack,
  onRowClick,
  rowClickable,
}: {
  title: string;
  subtitle?: string;
  data: GridData | null;
  loading: boolean;
  onClose: () => void;
  onBack?: () => void;
  /** Drill one level deeper from a row. Rows without the needed key stay inert. */
  onRowClick?: (row: Record<string, unknown>) => void;
  /** Whether a given row can be drilled into (drives the cursor). */
  rowClickable?: (row: Record<string, unknown>) => boolean;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function toggleSort(key: string): void {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    let out = q
      ? data.rows.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q)))
      : data.rows;
    if (sortKey) {
      const col = data.columns.find((c) => c.key === sortKey);
      out = [...out].sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        const cmp = col?.numeric ? Number(av) - Number(bv) : String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return out;
  }, [data, query, sortKey, sortDir]);

  const clickable = (r: Record<string, unknown>): boolean =>
    Boolean(onRowClick) && (rowClickable ? rowClickable(r) : true);

  return (
    <DrilldownShell
      title={title}
      subtitle={subtitle}
      onBack={onBack}
      onClose={onClose}
      toolbar={
        <div className="flex items-center gap-2 border-b border-border p-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {loading ? '…' : `${rows.length} record${rows.length === 1 ? '' : 's'}`}
          </span>
        </div>
      }
    >
      {loading || !data ? (
        <div className="p-4"><Skeleton className="h-40 w-full" /></div>
      ) : rows.length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">No matching records.</div>
      ) : (
        <>
          {onRowClick ? (
            <p className="border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Select an employee to see their 360 feedback breakdown.
            </p>
          ) : null}
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur">
              <tr className="text-left text-xs uppercase text-muted-foreground">
                {data.columns.map((c) => (
                  <th key={c.key} className="p-3">
                    <button
                      onClick={() => toggleSort(c.key)}
                      className={`inline-flex items-center gap-1 hover:text-foreground ${c.numeric ? 'justify-end' : ''}`}
                    >
                      {c.label}
                      {sortKey === c.key ? (
                        sortDir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
                      ) : (
                        <ChevronsUpDown className="size-3 opacity-40" />
                      )}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={i}
                  onClick={clickable(r) ? () => onRowClick?.(r) : undefined}
                  className={`border-t border-border hover:bg-muted/40 ${clickable(r) ? 'cursor-pointer' : ''}`}
                >
                  {data.columns.map((c) => (
                    <td key={c.key} className={`p-3 ${c.numeric ? 'text-right tabular-nums' : ''}`}>
                      {formatCell(r[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </DrilldownShell>
  );
}

function formatCell(v: unknown): string {
  if (v == null) return '—';
  return String(v);
}
