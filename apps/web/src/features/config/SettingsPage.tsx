import { useCallback, useEffect, useState } from 'react';
import { Gauge, Plus, ToggleLeft, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { reportsApi, type AggregateVisibility, type ComparisonThresholds, type FeedbackRules } from '@/features/reports/api';
import { appraisalApi, type ReminderSettings } from '@/features/appraisal/api';
import { configApi, type FeatureFlag, type RatingScale } from './api';
import { RECOGNISED_FLAGS } from './useFeatureFlags';

/** Configuration (Settings): feature flags + rating scales. Both fetched. */
export function SettingsPage(): JSX.Element {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Organization configuration, feature flags, and rating scales.</p>
      </div>
      <Card className="p-4 sm:p-5">
        <Tabs defaultValue="rules">
          <TabsList>
            <TabsTrigger value="rules">Feedback Rules</TabsTrigger>
            <TabsTrigger value="reminders">Reminders</TabsTrigger>
            <TabsTrigger value="flags">Feature Flags</TabsTrigger>
            <TabsTrigger value="scales">Rating Scales</TabsTrigger>
          </TabsList>
          <TabsContent value="rules">
            <FeedbackRulesPanel />
          </TabsContent>
          <TabsContent value="reminders">
            <RemindersPanel />
          </TabsContent>
          <TabsContent value="flags">
            <FeatureFlagsPanel />
          </TabsContent>
          <TabsContent value="scales">
            <RatingScalesPanel />
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}

/**
 * Reminder cadence and send time (F6).
 *
 * Chasing outstanding reviewers is what a 360 cycle lives on, but the cadence was
 * only reachable through raw configuration keys and the automatic run was pinned to
 * 08:00 — so an organisation could neither slow the nudges down nor move them to a
 * time its people actually read email.
 */
function RemindersPanel(): JSX.Element {
  const toast = useToast();
  const [settings, setSettings] = useState<ReminderSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    appraisalApi.getReminderSettings().then(setSettings).catch(() => setReadOnly(true));
  }, []);

  async function save(): Promise<void> {
    if (!settings) return;
    setSaving(true);
    try {
      setSettings(await appraisalApi.setReminderSettings(settings));
      toast.success('Reminder settings saved.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save reminder settings.');
    } finally {
      setSaving(false);
    }
  }

  if (readOnly) return <p className="p-4 text-sm text-muted-foreground">You do not have access to reminder settings.</p>;
  if (!settings) return <div className="p-4"><Skeleton className="h-32 w-full" /></div>;

  return (
    <div className="grid gap-4 p-1 pt-4">
      <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
        <div>
          <p className="text-sm font-medium">Automatic reminders</p>
          <p className="text-xs text-muted-foreground">
            Chase reviewers who have not submitted yet, for every active cycle. Manual “Send reminders” on a cycle
            always works regardless of this setting.
          </p>
        </div>
        <Switch checked={settings.enabled} onCheckedChange={(v) => setSettings({ ...settings, enabled: v })} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="cadence">Days between reminders</Label>
          <Input id="cadence" type="number" min={1} max={14} value={settings.cadenceDays}
            onChange={(e) => setSettings({ ...settings, cadenceDays: Number(e.target.value) })} />
          <p className="text-xs text-muted-foreground">The same reviewer is never reminded more often than this.</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="sendHour">Send at</Label>
          <select id="sendHour" value={settings.sendHour}
            onChange={(e) => setSettings({ ...settings, sendHour: Number(e.target.value) })}
            className="h-10 rounded-md border border-input bg-card px-3 text-sm">
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">Server time. Pick an hour your people are likely to read email.</p>
        </div>
      </div>
      <Button onClick={save} disabled={saving} className="w-fit">{saving ? 'Saving…' : 'Save reminder settings'}</Button>
    </div>
  );
}

/**
 * Feedback rules (F-C4): the anonymity threshold and target score that define the
 * 360 programme. These drive report suppression and every readiness/gap/at-risk
 * calculation, and previously could only be changed by a developer writing raw
 * configuration keys.
 */
type ComparisonKey = keyof ComparisonThresholds;

/**
 * The thresholds that decide when a difference between two evaluator groups is
 * reported, and how tightly a group has to agree. Kept in plain language: no
 * statistical shorthand on screen.
 */
const COMPARISON_FIELDS: { key: ComparisonKey; label: string; help: string; step: string; min: number; max: number }[] = [
  {
    key: 'gapModerate',
    label: 'Difference worth noting',
    help: 'How far apart two evaluator groups have to score the same competency before the report points the difference out.',
    step: '0.1', min: 0, max: 10,
  },
  {
    key: 'gapPronounced',
    label: 'Difference worth acting on',
    help: 'The bigger gap between two groups that is called out as pronounced and usually needs a conversation.',
    step: '0.1', min: 0, max: 10,
  },
  {
    key: 'consensusSdLow',
    label: 'Reviewers agree below this spread',
    help: 'Spread means how far apart the reviewers in one group are from each other. Below this, their feedback is reported as consistent.',
    step: '0.1', min: 0, max: 10,
  },
  {
    key: 'consensusSdHigh',
    label: 'Reviewers disagree above this spread',
    help: 'Above this spread the group is reported as divided, so a single average would be misleading.',
    step: '0.1', min: 0, max: 10,
  },
  {
    key: 'comparisonMinQuadrants',
    label: 'Groups needed to compare',
    help: 'How many evaluator groups must ask about a competency before their scores are compared at all.',
    step: '1', min: 2, max: 10,
  },
];

function FeedbackRulesPanel(): JSX.Element {
  const toast = useToast();
  const [rules, setRules] = useState<FeedbackRules | null>(null);
  const [target, setTarget] = useState('');
  const [minResp, setMinResp] = useState('');
  const [aggregate, setAggregate] = useState<AggregateVisibility>('all_report_viewers');
  const [comparison, setComparison] = useState<Record<ComparisonKey, string>>({
    gapModerate: '', gapPronounced: '', consensusSdLow: '', consensusSdHigh: '', comparisonMinQuadrants: '',
  });
  const [saving, setSaving] = useState(false);
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    reportsApi
      .getFeedbackRules()
      .then((r) => {
        setRules(r);
        setTarget(String(r.targetScore));
        setMinResp(String(r.minResponsesToShow));
        setAggregate(r.aggregateVisibility);
        setComparison({
          gapModerate: String(r.gapModerate),
          gapPronounced: String(r.gapPronounced),
          consensusSdLow: String(r.consensusSdLow),
          consensusSdHigh: String(r.consensusSdHigh),
          comparisonMinQuadrants: String(r.comparisonMinQuadrants),
        });
      })
      .catch(() => setRules(null));
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const saved = await reportsApi.setFeedbackRules({
        targetScore: Number(target),
        minResponsesToShow: Number(minResp),
        aggregateVisibility: aggregate,
        gapModerate: Number(comparison.gapModerate),
        gapPronounced: Number(comparison.gapPronounced),
        consensusSdLow: Number(comparison.consensusSdLow),
        consensusSdHigh: Number(comparison.consensusSdHigh),
        comparisonMinQuadrants: Number(comparison.comparisonMinQuadrants),
      });
      setRules(saved);
      setTarget(String(saved.targetScore));
      setMinResp(String(saved.minResponsesToShow));
      setAggregate(saved.aggregateVisibility);
      setComparison({
        gapModerate: String(saved.gapModerate),
        gapPronounced: String(saved.gapPronounced),
        consensusSdLow: String(saved.consensusSdLow),
        consensusSdHigh: String(saved.consensusSdHigh),
        comparisonMinQuadrants: String(saved.comparisonMinQuadrants),
      });
      toast.success('Feedback rules updated.');
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setReadOnly(true);
        toast.error('You do not have permission to change these settings.');
      } else {
        toast.error(e instanceof ApiError ? e.message : 'Could not save the feedback rules.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (!rules) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid max-w-xl gap-4 py-2">
      <div className="grid gap-1.5">
        <Label htmlFor="minResponses" className="text-sm font-semibold">Anonymity threshold (minimum responses)</Label>
        <Input
          id="minResponses"
          type="number"
          min={2}
          max={20}
          value={minResp}
          onChange={(e) => setMinResp(e.target.value)}
          className="max-w-[140px]"
        />
        <p className="text-xs text-muted-foreground">
          A feedback source (peers, subordinates…) is hidden on reports until it has at least this many
          responses, so individual reviewers cannot be identified. Self-assessment is always shown.
          Default {rules.defaults.minResponsesToShow}.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="aggregateVisibility" className="text-sm font-semibold">Organisation-wide reports</Label>
        <select
          id="aggregateVisibility"
          value={aggregate}
          onChange={(e) => setAggregate(e.target.value as AggregateVisibility)}
          className="h-10 max-w-md rounded-md border border-input bg-card px-3 text-sm"
        >
          <option value="all_report_viewers">Anyone who can view reports</option>
          <option value="executives_only">Executive and HR users only</option>
        </select>
        <p className="text-xs text-muted-foreground">
          Controls who can open department and campus scorecards, trends and heatmaps. These contain no individual’s
          score, but some organisations treat “which department scored lowest” as management information. Individual
          reports and named lists are always restricted regardless of this setting.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="targetScore" className="text-sm font-semibold">Target score</Label>
        <Input
          id="targetScore"
          type="number"
          step="0.1"
          min={1}
          max={10}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="max-w-[140px]"
        />
        <p className="text-xs text-muted-foreground">
          The expected competency score. Drives readiness bands, competency gaps, at-risk lists and
          training needs across the dashboards. Default {rules.defaults.targetScore}.
        </p>
      </div>
      <div className="grid gap-3 border-t border-border pt-4">
        <div>
          <p className="text-sm font-semibold">Shared-competency comparison</p>
          <p className="text-xs text-muted-foreground">
            When two or more evaluator groups (peers, managers, subordinates…) answer questions on the same competency,
            reports compare their scores. These settings decide when a difference is worth reporting.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {COMPARISON_FIELDS.map((f) => (
            <div key={f.key} className="grid gap-1.5">
              <Label htmlFor={f.key} className="text-sm font-semibold">{f.label}</Label>
              <Input
                id={f.key}
                type="number"
                step={f.step}
                min={f.min}
                max={f.max}
                value={comparison[f.key]}
                onChange={(e) => setComparison((c) => ({ ...c, [f.key]: e.target.value }))}
                className="max-w-[140px]"
              />
              <p className="text-xs text-muted-foreground">{f.help} Default {rules.defaults[f.key]}.</p>
            </div>
          ))}
        </div>
      </div>
      <div>
        <Button onClick={save} disabled={saving || readOnly}>{saving ? 'Saving…' : 'Save feedback rules'}</Button>
      </div>
    </div>
  );
}

function FeatureFlagsPanel(): JSX.Element {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState('');

  const reload = useCallback(() => {
    setLoading(true);
    configApi
      .listFeatureFlags()
      .then(setFlags)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => reload(), [reload]);

  async function addFlag(): Promise<void> {
    if (!newKey.trim()) return;
    await configApi.createFeatureFlag({ key: newKey.trim() });
    setNewKey('');
    reload();
  }

  async function toggle(flag: FeatureFlag): Promise<void> {
    await configApi.updateFeatureFlag(flag.id, { isEnabled: !flag.isEnabled });
    reload();
  }

  async function remove(flag: FeatureFlag): Promise<void> {
    await configApi.deleteFeatureFlag(flag.id);
    reload();
  }

  return (
    <div className="grid gap-4">
      {/* Tell admins which keys actually change behaviour (F-H11). */}
      <div className="rounded-lg border border-border bg-muted/40 p-3">
        <p className="text-xs font-semibold">Flags recognised by the application</p>
        <ul className="mt-1 grid gap-1">
          {RECOGNISED_FLAGS.map((f) => (
            <li key={f.key} className="text-xs text-muted-foreground">
              <code className="rounded bg-card px-1 py-0.5 font-semibold text-foreground">{f.key}</code> — {f.description}
              {' '}Default: {f.defaultEnabled ? 'on' : 'off'}.
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Other keys are stored for your own integrations and do not change how this application behaves.
        </p>
      </div>
      <div className="flex gap-2">
        <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="feature.key.name" />
        <Button onClick={addFlag}>
          <Plus /> Add flag
        </Button>
      </div>
      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : flags.length === 0 ? (
        <EmptyState icon={<ToggleLeft className="size-8 text-muted-foreground" />} text="No feature flags yet." />
      ) : (
        <div className="grid gap-2">
          {flags.map((flag) => (
            <div
              key={flag.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4 shadow-card"
            >
              <div className="min-w-0">
                <p className="truncate font-semibold">{flag.key}</p>
                {flag.description ? (
                  <p className="truncate text-sm text-muted-foreground">{flag.description}</p>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={flag.isEnabled ? 'success' : 'neutral'}>{flag.isEnabled ? 'On' : 'Off'}</Badge>
                <Switch checked={flag.isEnabled} onCheckedChange={() => toggle(flag)} />
                <button
                  onClick={() => remove(flag)}
                  aria-label="Delete flag"
                  className="text-muted-foreground hover:text-red-600"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RatingScalesPanel(): JSX.Element {
  const [scales, setScales] = useState<RatingScale[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    configApi
      .listRatingScales()
      .then(setScales)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Skeleton className="h-24 w-full" />;
  if (scales.length === 0) {
    return <EmptyState icon={<Gauge className="size-8 text-muted-foreground" />} text="No rating scales yet." />;
  }

  return (
    <div className="grid gap-3">
      {scales.map((scale) => (
        <div key={scale.id} className="rounded-lg border border-border bg-card p-4 shadow-card">
          <div className="mb-2 flex items-center gap-2">
            <p className="font-semibold">{scale.name}</p>
            <Badge variant="info">{scale.scaleType}</Badge>
            <span className="text-xs text-muted-foreground">
              {scale.minValue}–{scale.maxValue}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {scale.levels.map((level) => (
              <Badge key={level.id} variant="brand">
                {level.value} · {level.label}
              </Badge>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, text }: { icon: JSX.Element; text: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-10 text-center">
      {icon}
      <p className="text-sm font-medium">{text}</p>
    </div>
  );
}
