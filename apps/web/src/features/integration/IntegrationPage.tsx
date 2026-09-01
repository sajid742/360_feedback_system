import { Plug } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiKeysTab } from './ApiKeysTab';
import { ExternalApiDocsTab } from './ExternalApiDocsTab';
import { WebhooksTab } from './WebhooksTab';

export function IntegrationPage(): JSX.Element {
  return (
    <div className="grid gap-6">
      <div>
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Plug className="size-4" />
          </span>
          <h1 className="text-2xl font-extrabold tracking-tight">Integration</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Programmatic API keys and outbound webhooks for connecting this application to external systems.
        </p>
      </div>

      <Card className="p-4 sm:p-5">
        <Tabs defaultValue="api-keys">
          <TabsList>
            <TabsTrigger value="api-keys">API Keys</TabsTrigger>
            <TabsTrigger value="external-api">External API</TabsTrigger>
            <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          </TabsList>
          <TabsContent value="api-keys"><ApiKeysTab /></TabsContent>
          <TabsContent value="external-api"><ExternalApiDocsTab /></TabsContent>
          <TabsContent value="webhooks"><WebhooksTab /></TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}
