import type { ClientAliases, ClientKind, ClientRecord } from './google-context.types.js';

const EMPTY_ALIASES: ClientAliases = { domains: [], emails: [], keywords: [] };

export function normalizeAliasList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.map(String).map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

export function normalizeClientKind(kind: unknown): ClientKind {
  return kind === 'prospect' ? 'prospect' : 'client';
}

export function parseClientAliases(value: unknown): ClientAliases {
  if (!value) {
    return { ...EMPTY_ALIASES };
  }

  const parsed = typeof value === 'string' ? safeJson(value) : value;
  if (!parsed || typeof parsed !== 'object') {
    return { ...EMPTY_ALIASES };
  }

  const aliases = parsed as Record<string, unknown>;
  return {
    domains: normalizeAliasList(aliases.domains),
    emails: normalizeAliasList(aliases.emails),
    keywords: normalizeAliasList(aliases.keywords),
  };
}

export function serializeClientAliases(value: unknown): string {
  return JSON.stringify(parseClientAliases(value));
}

export function buildAliasTerms(client: ClientRecord): string[] {
  const aliases = parseClientAliases(client.aliases);
  return [
    client.name,
    client.project ?? '',
    ...aliases.domains,
    ...aliases.emails,
    ...aliases.keywords,
  ].map((term) => term.trim()).filter(Boolean);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

