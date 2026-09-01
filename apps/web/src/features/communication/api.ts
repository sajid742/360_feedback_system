import { apiClient } from '@/lib/api-client';

export type Channel = 'email' | 'sms' | 'whatsapp';

export interface Notification {
  id: string;
  channel: Channel;
  recipient: string;
  subject: string | null;
  status: string;
  provider: string | null;
  error: string | null;
  createdAt: string;
}

export interface ShortLink {
  id: string;
  code: string;
  targetUrl: string;
  clicks: number;
  shortUrl?: string;
}

export interface Campaign {
  id: string;
  name: string;
  channel: Channel;
  status: string;
  recipients: number;
  createdAt: string;
}

export type CommEvent =
  | 'cycle_started'
  | 'feedback_reminder'
  | 'final_reminder'
  | 'feedback_submitted'
  | 'cycle_closed'
  | 'admin_message';

export interface Template {
  event: CommEvent;
  channel: Channel;
  subject: string;
  body: string;
  isActive: boolean;
  isCustom: boolean;
}

export interface CommMeta {
  events: { event: CommEvent; label: string; description: string }[];
  placeholders: { token: string; label: string }[];
  channels: Channel[];
}

export interface Branding {
  organizationName: string;
  logoUrl: string;
  primaryColor: string;
  supportEmail: string;
  footer: string;
}

export interface EmailProviderSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  auth: boolean;
  user: string;
  senderName: string;
  from: string;
  connectionTimeout: number;
  /** Explicit opt-out of TLS certificate verification — see the Providers tab. */
  allowUntrustedCertificate?: boolean;
  hasPass: boolean;
}
export interface SmsProviderSettings {
  enabled: boolean;
  provider: 'twilio' | 'generic';
  senderId: string;
  accountSid: string;
  endpoint: string;
  httpMethod: 'POST' | 'GET';
  bodyFormat: 'json' | 'form';
  authType: 'none' | 'apikey' | 'basic' | 'bearer' | 'oauth2';
  apiKeyHeader: string;
  username: string;
  oauthTokenUrl: string;
  oauthClientId: string;
  toParam: string;
  messageParam: string;
  fromParam: string;
  retryMaxAttempts: number;
  retryBackoffMs: number;
  hasAuthToken: boolean;
  hasApiKey: boolean;
  hasPassword: boolean;
  hasOauthClientSecret: boolean;
}
export interface WhatsappProviderSettings {
  enabled: boolean;
  provider: 'meta' | 'twilio' | 'waha' | 'mock';
  baseUrl: string;
  phoneNumberId: string;
  accountSid: string;
  session: string;
  businessNumber: string;
  webhookUrl: string;
  hasAccessToken: boolean;
  hasAuthToken: boolean;
  hasApiKey: boolean;
  mock: boolean;
}

export interface CommSettings {
  providers: {
    email: EmailProviderSettings;
    sms: SmsProviderSettings;
    whatsapp: WhatsappProviderSettings;
    general: {
      /** Effective URL links are built from (tenant override -> PUBLIC_APP_URL -> dev default). */
      publicBaseUrl: string;
      /** What was explicitly saved here; blank means inherit from PUBLIC_APP_URL. */
      publicBaseUrlConfigured?: string;
      publicBaseUrlSource?: 'database' | 'environment' | 'default';
      publicBaseUrlUsable?: boolean;
      hasWebhookSecret: boolean;
    };
  };
  branding: Branding;
  defaults: { channels: Channel[] };
}

export const commApi = {
  send: (input: { channel: Channel; recipient: string; subject?: string; body: string }): Promise<{ id: string }> =>
    apiClient.post('/communication/send', input),
  listNotifications: (): Promise<Notification[]> => apiClient.get('/communication/notifications'),

  createShortLink: (targetUrl: string): Promise<ShortLink> =>
    apiClient.post('/communication/short-links', { targetUrl }),
  listShortLinks: (): Promise<ShortLink[]> => apiClient.get('/communication/short-links'),

  listCampaigns: (): Promise<Campaign[]> => apiClient.get('/communication/campaigns'),
  createCampaign: (input: {
    name: string;
    channel: Channel;
    subject?: string;
    body: string;
    audience: { type: 'explicit' | 'all_employees'; recipients?: string[] };
  }): Promise<{ id: string; recipients: number }> => apiClient.post('/communication/campaigns', input),

  // v2: templates, providers, branding & channels
  meta: (): Promise<CommMeta> => apiClient.get('/communication/meta'),
  listTemplates: (): Promise<Template[]> => apiClient.get('/communication/templates'),
  saveTemplate: (input: { event: CommEvent; channel: Channel; subject: string; body: string; isActive: boolean }): Promise<Template> =>
    apiClient.post('/communication/templates', input),
  resetTemplate: (input: { event: CommEvent; channel: Channel }): Promise<Template> =>
    apiClient.post('/communication/templates/reset', input),

  getSettings: (): Promise<CommSettings> => apiClient.get('/communication/settings'),
  saveProviders: (input: Record<string, unknown>): Promise<CommSettings['providers']> =>
    apiClient.post('/communication/settings/providers', input),
  saveBranding: (input: Branding): Promise<Branding> => apiClient.post('/communication/settings/branding', input),
  saveDefaults: (channels: Channel[]): Promise<{ channels: Channel[] }> =>
    apiClient.post('/communication/settings/defaults', { value: { channels } }),
  testSend: (input: { channel: Channel; recipient: string }): Promise<{ id: string; status?: string; error?: string | null }> =>
    apiClient.post('/communication/settings/test', input),
};
