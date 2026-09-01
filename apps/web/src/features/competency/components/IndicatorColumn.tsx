import { useState } from 'react';
import { Plus, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { BehaviourIndicator, IndicatorType, ProficiencyLevel } from '../types';

interface IndicatorColumnProps {
  type: IndicatorType;
  indicators: BehaviourIndicator[];
  proficiencyLevels: ProficiencyLevel[];
  editable: boolean;
  onAdd: (text: string, proficiencyLevelId: string | null) => Promise<void>;
  onRemove: (indicator: BehaviourIndicator) => Promise<void>;
}

const columnStyle: Record<IndicatorType, { title: string; ring: string; chip: string; icon: JSX.Element }> = {
  positive: {
    title: 'Positive indicators',
    ring: 'ring-emerald-600/20',
    chip: 'badge-soft-success',
    icon: <ThumbsUp className="size-4 text-emerald-600" />,
  },
  negative: {
    title: 'Negative indicators',
    ring: 'ring-red-600/20',
    chip: 'badge-soft-danger',
    icon: <ThumbsDown className="size-4 text-red-600" />,
  },
};

/** One column of observable behaviours (positive or negative). Add form is
 *  shown only when the parent version is an editable draft. */
export function IndicatorColumn({
  type,
  indicators,
  proficiencyLevels,
  editable,
  onAdd,
  onRemove,
}: IndicatorColumnProps): JSX.Element {
  const [text, setText] = useState('');
  const [levelId, setLevelId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const style = columnStyle[type];

  async function handleAdd(): Promise<void> {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await onAdd(text.trim(), levelId || null);
      setText('');
      setLevelId('');
    } finally {
      setBusy(false);
    }
  }

  function levelName(id: string | null): string | null {
    return proficiencyLevels.find((l) => l.id === id)?.name ?? null;
  }

  return (
    <div className={cn('rounded-lg border border-border bg-card p-4 shadow-card ring-1 ring-inset', style.ring)}>
      <div className="mb-3 flex items-center gap-2">
        {style.icon}
        <h4 className="text-sm font-bold">{style.title}</h4>
        <span className={cn('ml-auto rounded-full px-2 py-0.5 text-xs font-semibold', style.chip)}>
          {indicators.length}
        </span>
      </div>

      <ul className="grid gap-2">
        {indicators.map((indicator) => (
          <li
            key={indicator.id}
            className="flex items-start justify-between gap-2 rounded-md bg-muted/50 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-sm">{indicator.text}</p>
              {levelName(indicator.proficiencyLevelId) ? (
                <span className={cn('mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold', style.chip)}>
                  {levelName(indicator.proficiencyLevelId)}
                </span>
              ) : null}
            </div>
            {editable ? (
              <button
                type="button"
                aria-label="Remove indicator"
                className="mt-0.5 text-muted-foreground transition-colors hover:text-red-600"
                onClick={() => onRemove(indicator)}
              >
                <Trash2 className="size-4" />
              </button>
            ) : null}
          </li>
        ))}
        {indicators.length === 0 ? (
          <li className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
            No {type} indicators yet.
          </li>
        ) : null}
      </ul>

      {editable ? (
        <div className="mt-3 grid gap-2 border-t border-border pt-3">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Describe an observable ${type} behaviour`}
            className="min-h-[60px]"
          />
          {proficiencyLevels.length > 0 ? (
            <select
              value={levelId}
              onChange={(e) => setLevelId(e.target.value)}
              className="h-9 rounded-md border border-input bg-card px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Applies to whole competency</option>
              {proficiencyLevels.map((level) => (
                <option key={level.id} value={level.id}>
                  L{level.level} · {level.name}
                </option>
              ))}
            </select>
          ) : null}
          <Button size="sm" variant="outline" disabled={busy || !text.trim()} onClick={handleAdd}>
            <Plus /> Add indicator
          </Button>
        </div>
      ) : null}
    </div>
  );
}
