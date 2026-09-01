import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BehaviourIndicatorsEditor } from '../components/BehaviourIndicatorsEditor';
import { CategoriesPanel } from '../components/CategoriesPanel';
import { CompetencyLibrary } from '../components/CompetencyLibrary';
import { CompetencyStatsRow } from '../components/CompetencyStatsRow';
import type { Competency, CompetencyVersion } from '../types';

type TabKey = 'library' | 'categories' | 'indicators';

/**
 * Competency module landing page (Session 3 restyle). Gradient stats row above
 * a card-panel wrapper with tabbed sub-modules. Clicking "Indicators" on a card
 * deep-links into the Indicators tab with that competency's version selected.
 */
export function CompetencyPage(): JSX.Element {
  const [tab, setTab] = useState<TabKey>('library');
  const [selected, setSelected] = useState<{ version: CompetencyVersion; name: string } | null>(null);
  const [statsToken, setStatsToken] = useState(0);

  function viewIndicators(competency: Competency): void {
    // Prefer a pending draft over the active version: a draft is the only version whose
    // indicators can be edited, so opening the active one instead would land the user on
    // a read-only screen telling them to create the draft they already have.
    const draft = competency.latestVersion?.status === 'draft' ? competency.latestVersion : null;
    // Same guard as the card: a competency with no live version has no indicators to
    // show, and following the deep-link would crash the Indicators tab.
    const version = draft ?? competency.activeVersion ?? competency.latestVersion;
    if (!version) return;
    setSelected({ version, name: competency.name });
    setTab('indicators');
  }

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Competency Management</h1>
        <p className="text-sm text-muted-foreground">
          Define competencies, organize them into categories, and maintain versioned behaviour indicators.
        </p>
      </div>

      <CompetencyStatsRow refreshToken={statsToken} />

      <Card className="p-4 sm:p-5">
        <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)}>
          <TabsList>
            <TabsTrigger value="library">Library</TabsTrigger>
            <TabsTrigger value="categories">Categories</TabsTrigger>
            <TabsTrigger value="indicators">Behaviour Indicators</TabsTrigger>
          </TabsList>

          <TabsContent value="library">
            <CompetencyLibrary
              onViewIndicators={viewIndicators}
              onChanged={(competencyId) => {
                setStatsToken((n) => n + 1);
                // The deep-linked version may have just been retired or replaced; a stale
                // one would render a draft badge on an already-active version and every
                // edit would come back 409 "Only draft versions can be edited."
                if (competencyId && selected?.version.competencyId === competencyId) setSelected(null);
              }}
            />
          </TabsContent>

          <TabsContent value="categories">
            <CategoriesPanel />
          </TabsContent>

          <TabsContent value="indicators">
            <BehaviourIndicatorsEditor
              version={selected?.version ?? null}
              competencyName={selected?.name}
            />
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}
