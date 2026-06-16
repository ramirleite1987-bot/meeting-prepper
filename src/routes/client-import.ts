import { Router, text, type Request, type Router as ExpressRouter } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/async-handler.js';
import type { AppError } from '../middleware/error-handler.js';
import {
  buildClientImportTemplateCsv,
  importClientsFromSource,
  type ClientImportSource,
} from '../services/client-import.service.js';

const importRequestSchema = z
  .object({
    filename: z.string().trim().min(1).optional(),
    content: z.string().optional(),
    contentBase64: z.string().optional(),
    googleSheetUrl: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => value.content || value.contentBase64 || value.googleSheetUrl, {
    message: 'Provide a file or Google Sheets URL',
  });

export const clientImportRouter: ExpressRouter = Router();

clientImportRouter.get(
  '/clients/import-template.csv',
  asyncHandler((_req, res) => {
    res
      .type('text/csv')
      .attachment('clients-import-template.csv')
      .send(buildClientImportTemplateCsv());
  }),
);

clientImportRouter.post(
  '/clients/import',
  text({ type: ['text/csv', 'text/plain'], limit: '5mb' }),
  asyncHandler(async (req, res) => {
    const result = await importClientsFromSource(parseImportSource(req));
    res.json(result);
  }),
);

function parseImportSource(req: Request): ClientImportSource {
  if (typeof req.body === 'string') {
    const content = req.body.trim();
    if (!content) {
      throw createError('Provide a file or Google Sheets URL', 400);
    }
    return {
      filename: headerValue(req, 'x-filename') ?? 'clients.csv',
      content,
    };
  }

  const parsed = importRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw createError(parsed.error.issues[0]?.message ?? 'Invalid import payload', 400);
  }

  return parsed.data;
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.header(name);
  return value && value.trim() ? value.trim() : undefined;
}

function createError(message: string, statusCode: number): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  return err;
}
