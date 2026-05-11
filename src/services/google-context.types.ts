export interface ClientAliases {
  domains: string[];
  emails: string[];
  keywords: string[];
}

export type ClientKind = 'client' | 'prospect';

export interface ClientRecord {
  id: string;
  name: string;
  kind: ClientKind;
  project: string | null;
  aliases: string;
}

export interface ExternalContextRecord {
  id: string;
  client_id: string;
  source: string;
  external_id: string;
  title: string;
  content: string;
  occurred_at: string;
  metadata: string;
}

export interface GoogleContextItem {
  clientId: string;
  source: 'gmail' | 'calendar';
  externalId: string;
  title: string;
  content: string;
  occurredAt: Date;
  metadata: Record<string, unknown>;
}

export interface GoogleSyncResult {
  imported: number;
  clientsChecked: number;
  errors: Array<{ source: string; message: string; clientId?: string }>;
}

