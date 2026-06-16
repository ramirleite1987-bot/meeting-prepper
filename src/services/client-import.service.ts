import { randomUUID } from 'node:crypto';
import { read, utils } from 'xlsx';
import { getDb, queries } from '../db/index.js';
import { normalizeClientKind, serializeClientAliases } from './client-aliases.js';
import type { ClientAliases, ClientKind } from './google-context.types.js';

export interface ClientImportSource {
  filename?: string;
  content?: string;
  contentBase64?: string;
  googleSheetUrl?: string;
}

export interface ClientImportRowError {
  row: number;
  message: string;
}

export interface ClientImportResult {
  created: number;
  updated: number;
  skipped: number;
  totalRows: number;
  errors: ClientImportRowError[];
}

interface RawClientImportRow {
  rowNumber: number;
  values: Partial<Record<ClientImportColumn, string>>;
}

interface ParsedClientImportRow {
  rowNumber: number;
  name: string;
  project: string | null;
  kind: ClientKind;
  aliases: ClientAliases;
}

interface ExistingClient {
  id: string;
}

type ClientImportColumn = 'name' | 'project' | 'kind' | 'domains' | 'emails' | 'keywords';

const TEMPLATE_COLUMNS: ClientImportColumn[] = [
  'name',
  'project',
  'kind',
  'domains',
  'emails',
  'keywords',
];

const HEADER_ALIASES: Record<string, ClientImportColumn> = {
  client: 'name',
  client_name: 'name',
  company: 'name',
  domains: 'domains',
  dominios: 'domains',
  emails: 'emails',
  kind: 'kind',
  keywords: 'keywords',
  name: 'name',
  nome: 'name',
  palavras_chave: 'keywords',
  project: 'project',
  projeto: 'project',
  tipo: 'kind',
};

export class ClientImportValidationError extends Error {
  statusCode = 400;
}

export function buildClientImportTemplateCsv(): string {
  return `${TEMPLATE_COLUMNS.join(',')}\n`;
}

export async function importClientsFromSource(
  source: ClientImportSource,
): Promise<ClientImportResult> {
  if (source.googleSheetUrl) {
    const response = await fetch(googleSheetCsvUrl(source.googleSheetUrl));
    if (!response.ok) {
      throw new ClientImportValidationError(`Google Sheets export failed: ${response.status}`);
    }
    return importParsedRows(rowsFromCsv(await response.text()));
  }

  return importParsedRows(parseClientImportRows(source));
}

export function googleSheetCsvUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClientImportValidationError('googleSheetUrl must be a valid URL');
  }

  if (url.hostname !== 'docs.google.com' || !url.pathname.includes('/spreadsheets/')) {
    throw new ClientImportValidationError('googleSheetUrl must be a Google Sheets URL');
  }

  if (url.searchParams.get('format') === 'csv' || url.searchParams.get('output') === 'csv') {
    return url.toString();
  }

  const publishedMatch = url.pathname.match(/\/spreadsheets\/d\/e\/([^/]+)\/pub/);
  if (publishedMatch) {
    url.searchParams.set('output', 'csv');
    return url.toString();
  }

  const sheetMatch = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  const sheetId = sheetMatch?.[1];
  if (!sheetId) {
    throw new ClientImportValidationError('googleSheetUrl must include a spreadsheet id');
  }

  const gid =
    url.searchParams.get('gid') ?? new URLSearchParams(url.hash.slice(1)).get('gid') ?? '0';
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

function importParsedRows(rows: RawClientImportRow[]): ClientImportResult {
  const result: ClientImportResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    totalRows: rows.length,
    errors: [],
  };

  const getClientByName = queries.getClientByName();
  const insertClient = queries.insertClient();
  const updateClient = queries.updateClient();

  const runImport = getDb().transaction(() => {
    for (const row of rows) {
      const parsed = parseClientImportRow(row, result);
      if (!parsed) {
        continue;
      }

      const existing = getClientByName.get(parsed.name) as ExistingClient | undefined;
      const payload = {
        id: existing?.id ?? randomUUID(),
        name: parsed.name,
        kind: parsed.kind,
        project: parsed.project,
        aliases: serializeClientAliases(parsed.aliases),
      };

      if (existing) {
        updateClient.run(payload);
        result.updated += 1;
      } else {
        insertClient.run(payload);
        result.created += 1;
      }
    }
  });

  runImport();
  return result;
}

function parseClientImportRow(
  row: RawClientImportRow,
  result: ClientImportResult,
): ParsedClientImportRow | null {
  const name = cleanCell(row.values.name);
  if (!name) {
    result.skipped += 1;
    result.errors.push({ row: row.rowNumber, message: 'name is required' });
    return null;
  }

  return {
    rowNumber: row.rowNumber,
    name,
    project: cleanCell(row.values.project) || null,
    kind: normalizeClientKind(row.values.kind),
    aliases: {
      domains: splitAliasCell(row.values.domains),
      emails: splitAliasCell(row.values.emails),
      keywords: splitAliasCell(row.values.keywords),
    },
  };
}

function parseClientImportRows(source: ClientImportSource): RawClientImportRow[] {
  const filename = source.filename ?? 'clients.csv';
  const extension = filename.split('.').pop()?.toLowerCase();

  if (extension === 'xls' || extension === 'xlsx') {
    return rowsFromWorkbook(decodeBinaryContent(source));
  }

  return rowsFromCsv(decodeTextContent(source));
}

function rowsFromWorkbook(content: Buffer): RawClientImportRow[] {
  const workbook = read(content, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new ClientImportValidationError('Spreadsheet must include at least one worksheet');
  }

  const sheet = workbook.Sheets[firstSheetName];
  return rowsFromMatrix(
    utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as string[][],
  );
}

function rowsFromCsv(content: string): RawClientImportRow[] {
  return rowsFromMatrix(parseCsv(content));
}

function rowsFromMatrix(matrix: string[][]): RawClientImportRow[] {
  const [headerRow, ...dataRows] = matrix.filter((row) => row.some((cell) => cleanCell(cell)));
  if (!headerRow) {
    throw new ClientImportValidationError('Import file must include a header row');
  }

  const columns = headerRow.map(normalizeHeader);
  if (!columns.includes('name')) {
    throw new ClientImportValidationError('Import file must include a name column');
  }

  return dataRows.map((cells, index) => ({
    rowNumber: index + 2,
    values: cells.reduce<Partial<Record<ClientImportColumn, string>>>((values, cell, cellIndex) => {
      const column = columns[cellIndex];
      if (column) {
        values[column] = cleanCell(cell);
      }
      return values;
    }, {}),
  }));
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function normalizeHeader(value: string): ClientImportColumn | undefined {
  const key = cleanCell(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s-]+/g, '_');

  return HEADER_ALIASES[key];
}

function decodeTextContent(source: ClientImportSource): string {
  if (source.content !== undefined) {
    return stripBom(source.content);
  }

  if (source.contentBase64) {
    return stripBom(Buffer.from(source.contentBase64, 'base64').toString('utf8'));
  }

  throw new ClientImportValidationError('Import content is required');
}

function decodeBinaryContent(source: ClientImportSource): Buffer {
  if (source.contentBase64) {
    return Buffer.from(source.contentBase64, 'base64');
  }

  if (source.content !== undefined) {
    return Buffer.from(source.content, 'utf8');
  }

  throw new ClientImportValidationError('Import content is required');
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, '');
}

function cleanCell(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function splitAliasCell(value: unknown): string[] {
  return cleanCell(value)
    .split(/[;,|]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
