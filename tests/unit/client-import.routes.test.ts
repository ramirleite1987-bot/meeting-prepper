import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockBuildTemplate = vi.hoisted(() => vi.fn());
const mockImportClients = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/client-import.service.js', () => ({
  buildClientImportTemplateCsv: mockBuildTemplate,
  importClientsFromSource: mockImportClients,
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    error: vi.fn(),
  },
}));

const { clientImportRouter } = await import('../../src/routes/client-import.js');
const { errorHandler } = await import('../../src/middleware/error-handler.js');

function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', clientImportRouter);
  app.use(errorHandler);
  return app;
}

describe('client import routes', () => {
  beforeEach(() => {
    mockBuildTemplate.mockReset().mockReturnValue('name,project,kind,domains,emails,keywords\n');
    mockImportClients.mockReset().mockResolvedValue({
      created: 1,
      updated: 0,
      skipped: 0,
      totalRows: 1,
      errors: [],
    });
  });

  it('downloads the CSV import template', async () => {
    const res = await request(createApp()).get('/api/clients/import-template.csv').expect(200);

    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/clients-import-template\.csv/);
    expect(res.text).toBe('name,project,kind,domains,emails,keywords\n');
  });

  it('imports clients from a JSON file payload', async () => {
    const payload = {
      filename: 'clients.csv',
      content: 'name,project\nAcme,Retainer\n',
    };

    const res = await request(createApp()).post('/api/clients/import').send(payload).expect(200);

    expect(res.body).toMatchObject({ created: 1, updated: 0, skipped: 0 });
    expect(mockImportClients).toHaveBeenCalledWith(payload);
  });

  it('imports clients from a Google Sheets URL', async () => {
    await request(createApp())
      .post('/api/clients/import')
      .send({ googleSheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-id/edit#gid=0' })
      .expect(200);

    expect(mockImportClients).toHaveBeenCalledWith({
      googleSheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-id/edit#gid=0',
    });
  });

  it('validates that an import source is present', async () => {
    const res = await request(createApp()).post('/api/clients/import').send({}).expect(400);

    expect(res.body.error).toMatch(/provide a file or google sheets url/i);
    expect(mockImportClients).not.toHaveBeenCalled();
  });
});
