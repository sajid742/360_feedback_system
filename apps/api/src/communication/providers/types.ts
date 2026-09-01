export type Channel = 'email' | 'sms' | 'whatsapp';

export interface MessagePayload {
  recipient: string;
  subject?: string | null;
  body: string;
}

export interface SendResult {
  provider: string;
  providerMessageId: string | null;
}

/** A channel transport. Implementations read their credentials from per-org config. */
export interface ChannelProvider {
  send(payload: MessagePayload): Promise<SendResult>;
}
