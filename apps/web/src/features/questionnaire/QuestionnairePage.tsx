import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { QuestionBankPanel } from './QuestionBankPanel';
import { TemplatesPanel } from './TemplatesPanel';

export function QuestionnairePage(): JSX.Element {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Questionnaires</h1>
        <p className="text-sm text-muted-foreground">Build reusable question banks and questionnaire templates.</p>
      </div>
      <Card className="p-4 sm:p-5">
        <Tabs defaultValue="bank">
          <TabsList>
            <TabsTrigger value="bank">Question Bank</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
          </TabsList>
          <TabsContent value="bank">
            <QuestionBankPanel />
          </TabsContent>
          <TabsContent value="templates">
            <TemplatesPanel />
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}
