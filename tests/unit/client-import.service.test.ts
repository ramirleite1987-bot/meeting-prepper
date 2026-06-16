import { beforeEach, describe, expect, it, vi } from 'vitest';
import { utils, write } from 'xlsx';

const mockAllClients = vi.hoisted(() => vi.fn());
const mockGetClientByName = vi.hoisted(() => vi.fn());
const mockInsertClient = vi.hoisted(() => vi.fn());
const mockUpdateClient = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() => vi.fn((fn: () => unknown) => fn));

vi.mock('../../src/db/index.js', () => ({
  getDb: () => ({ transaction: mockTransaction }),
  queries: {
    getAllClients: () => ({ all: mockAllClients }),
    getClientByName: () => ({ get: mockGetClientByName }),
    insertClient: () => ({ run: mockInsertClient }),
    updateClient: () => ({ run: mockUpdateClient }),
  },
}));

const { buildClientImportTemplateCsv, importClientsFromSource, googleSheetCsvUrl } =
  await import('../../src/services/client-import.service.js');

describe('client import service', () => {
  beforeEach(() => {
    mockAllClients.mockReset();
    mockGetClientByName.mockReset();
    mockInsertClient.mockReset();
    mockUpdateClient.mockReset();
    mockTransaction.mockClear();
  });

  it('exports the expected CSV template columns', () => {
    expect(buildClientImportTemplateCsv()).toBe('name,project,kind,domains,emails,keywords\n');
  });

  it('creates and updates clients from CSV rows', async () => {
    mockGetClientByName.mockImplementation((name: string) =>
      name.toLowerCase() === 'acme' ? { id: 'client-1', name: 'Acme' } : undefined,
    );

    const result = await importClientsFromSource({
      filename: 'clients.csv',
      content:
        'name,project,kind,domains,emails,keywords\n' +
        'Acme,Retainer,prospect,acme.com;app.acme.com,ops@acme.com,apollo\n' +
        'Globex,Launch,client,globex.com,team@globex.com,launch\n',
    });

    expect(result).toMatchObject({ created: 1, updated: 1, skipped: 0, totalRows: 2 });
    expect(mockUpdateClient).toHaveBeenCalledWith({
      id: 'client-1',
      name: 'Acme',
      kind: 'prospect',
      project: 'Retainer',
      aliases: JSON.stringify({
        domains: ['acme.com', 'app.acme.com'],
        emails: ['ops@acme.com'],
        keywords: ['apollo'],
      }),
    });
    expect(mockInsertClient).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Globex',
        kind: 'client',
        project: 'Launch',
      }),
    );
  });

  it('imports the first worksheet from an XLSX payload', async () => {
    mockGetClientByName.mockReturnValue(undefined);
    const worksheet = utils.json_to_sheet([
      { name: 'Initech', project: 'Payroll', kind: 'client' },
    ]);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, 'Clients');
    const contentBase64 = Buffer.from(
      write(workbook, { type: 'buffer', bookType: 'xlsx' }),
    ).toString('base64');

    const result = await importClientsFromSource({ filename: 'clients.xlsx', contentBase64 });

    expect(result).toMatchObject({ created: 1, updated: 0, skipped: 0, totalRows: 1 });
    expect(mockInsertClient).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Initech', project: 'Payroll' }),
    );
  });

  it('reports row errors without aborting the whole import', async () => {
    mockGetClientByName.mockReturnValue(undefined);

    const result = await importClientsFromSource({
      filename: 'clients.csv',
      content: 'name,project\n,Missing name\nValid,Works\n',
    });

    expect(result).toMatchObject({ created: 1, updated: 0, skipped: 1, totalRows: 2 });
    expect(result.errors).toEqual([{ row: 2, message: 'name is required' }]);
  });

  it('builds a CSV export URL from a Google Sheets edit link', () => {
    expect(googleSheetCsvUrl('https://docs.google.com/spreadsheets/d/sheet-id/edit#gid=123')).toBe(
      'https://docs.google.com/spreadsheets/d/sheet-id/export?format=csv&gid=123',
    );
  });

  it('imports clients from a Google Sheets CSV export', async () => {
    mockGetClientByName.mockReturnValue(undefined);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('name,project\nUmbrella,Research\n'));

    const result = await importClientsFromSource({
      googleSheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-id/edit#gid=7',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://docs.google.com/spreadsheets/d/sheet-id/export?format=csv&gid=7',
    );
    expect(result).toMatchObject({ created: 1, updated: 0, skipped: 0, totalRows: 1 });
    expect(mockInsertClient).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Umbrella', project: 'Research' }),
    );

    fetchMock.mockRestore();
  });
});
