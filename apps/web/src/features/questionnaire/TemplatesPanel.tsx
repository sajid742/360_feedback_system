import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Copy, Plus, Rocket, Trash2 } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { questionnaireApi, type Question, type TemplateDetail, type TemplateSummary } from './api';

const STATUS: Record<string, BadgeVariant> = { draft: 'warning', published: 'success', archived: 'neutral' };

export function TemplatesPanel(): JSX.Element {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');

  const reload = useCallback(() => {
    questionnaireApi.listTemplates().then(setTemplates);
  }, []);
  useEffect(() => reload(), [reload]);

  async function create(): Promise<void> {
    if (!name.trim()) return;
    const created = await questionnaireApi.createTemplate({ name: name.trim() });
    setName('');
    reload();
    setSelected(created.id);
  }

  if (selected) {
    return (
      <TemplateBuilder
        templateId={selected}
        onBack={() => {
          setSelected(null);
          reload();
        }}
      />
    );
  }

  if (!templates) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="grid gap-4">
      <div className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New template name" />
        <Button onClick={create}>
          <Plus /> Create
        </Button>
      </div>
      <div className="grid gap-2">
        {templates.map((t) => (
          <button
            key={t.id}
            onClick={() => setSelected(t.id)}
            className="flex items-center justify-between rounded-lg border border-border bg-card p-4 text-left shadow-card transition-shadow hover:shadow-card-hover"
          >
            <div>
              <p className="font-semibold">{t.name}</p>
              <p className="text-xs text-muted-foreground">
                v{t.version} · {t.sections} sections
              </p>
            </div>
            <Badge variant={STATUS[t.status] ?? 'neutral'}>{t.status}</Badge>
          </button>
        ))}
        {templates.length === 0 ? <p className="text-sm text-muted-foreground">No templates yet.</p> : null}
      </div>
    </div>
  );
}

function TemplateBuilder({ templateId, onBack }: { templateId: string; onBack: () => void }): JSX.Element {
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [sectionTitle, setSectionTitle] = useState('');

  const load = useCallback(() => {
    questionnaireApi.getTemplate(templateId).then(setTemplate);
  }, [templateId]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    questionnaireApi.listQuestions('').then((r) => setQuestions(r.items));
  }, []);

  if (!template) return <Skeleton className="h-64 w-full" />;
  const editable = template.status === 'draft';

  async function addSection(): Promise<void> {
    if (!sectionTitle.trim()) return;
    setTemplate(await questionnaireApi.addSection(templateId, sectionTitle.trim()));
    setSectionTitle('');
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
        <h3 className="text-lg font-bold">{template.name}</h3>
        <Badge variant={STATUS[template.status] ?? 'neutral'}>{template.status}</Badge>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => questionnaireApi.clone(templateId).then(load)}>
            <Copy /> Clone
          </Button>
          {editable ? (
            <Button size="sm" onClick={() => questionnaireApi.publish(templateId).then(setTemplate)}>
              <Rocket /> Publish
            </Button>
          ) : null}
        </div>
      </div>

      {editable ? (
        <div className="flex gap-2">
          <Input value={sectionTitle} onChange={(e) => setSectionTitle(e.target.value)} placeholder="New section title" />
          <Button onClick={addSection}>
            <Plus /> Section
          </Button>
        </div>
      ) : null}

      <div className="grid gap-3">
        {template.sections.map((section) => (
          <div key={section.id} className="rounded-lg border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-semibold">{section.title}</p>
              {editable ? (
                <button
                  onClick={() => questionnaireApi.removeSection(templateId, section.id).then(setTemplate)}
                  aria-label="Remove section"
                  className="text-muted-foreground hover:text-red-600"
                >
                  <Trash2 className="size-4" />
                </button>
              ) : null}
            </div>
            <ul className="grid gap-1.5">
              {section.questions.map((q) => (
                <li key={q.id} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 text-sm">
                  <span>{q.text}</span>
                  {editable ? (
                    <button
                      onClick={() => questionnaireApi.removeSectionQuestion(templateId, q.id).then(setTemplate)}
                      aria-label="Remove question"
                      className="text-muted-foreground hover:text-red-600"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  ) : null}
                </li>
              ))}
              {section.questions.length === 0 ? (
                <li className="text-xs text-muted-foreground">No questions in this section.</li>
              ) : null}
            </ul>
            {editable ? (
              <select
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) questionnaireApi.addQuestion(templateId, section.id, e.target.value).then(setTemplate);
                  e.target.value = '';
                }}
                className="mt-2 h-9 w-full rounded-md border border-input bg-card px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">+ Add question from bank…</option>
                {questions.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.text.slice(0, 60)}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        ))}
        {template.sections.length === 0 ? <p className="text-sm text-muted-foreground">Add a section to get started.</p> : null}
      </div>
    </div>
  );
}
