import { Router, Request, Response, NextFunction } from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queries } from '../db/index.js';
import { clientContextService, briefingService } from './api.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const viewsDir = join(__dirname, '..', 'views');

const router = Router();

function loadTemplate(name: string): string {
  return readFileSync(join(viewsDir, `${name}.html`), 'utf-8');
}

function renderLayout(title: string, content: string): string {
  const layout = loadTemplate('layout');
  return layout.replace('{{title}}', title).replace('{{content}}', content);
}

function renderSimpleTemplate(template: string, data: Record<string, unknown>): string {
  let result = template;

  // Handle {{#if value}} ... {{else}} ... {{/if}}
  result = result.replace(/\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_match, key: string, block: string) => {
    const val = resolveValue(data, key);
    const [ifBlock, elseBlock] = block.split('{{else}}');
    if (isTruthy(val)) {
      return ifBlock;
    }
    return elseBlock ?? '';
  });

  // Handle {{#each items}} ... {{/each}}
  result = result.replace(/\{\{#each\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_match, key: string, block: string) => {
    const arr = resolveValue(data, key);
    if (!Array.isArray(arr)) return '';
    return arr.map((item: unknown) => {
      let rendered = block;
      if (typeof item === 'object' && item !== null) {
        const obj = item as Record<string, unknown>;
        rendered = rendered.replace(/\{\{this\.([\w]+)\}\}/g, (_m: string, prop: string) => escapeHtml(String(obj[prop] ?? '')));
      }
      rendered = rendered.replace(/\{\{this\}\}/g, escapeHtml(String(item)));
      return rendered;
    }).join('');
  });

  // Handle {{key}} simple replacements
  result = result.replace(/\{\{([\w.]+)\}\}/g, (_match, key: string) => {
    const val = resolveValue(data, key);
    return val != null ? escapeHtml(String(val)) : '';
  });

  return result;
}

function resolveValue(data: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => {
    if (obj && typeof obj === 'object') {
      return (obj as Record<string, unknown>)[key];
    }
    return undefined;
  }, data);
}

function isTruthy(val: unknown): boolean {
  if (Array.isArray(val)) return val.length > 0;
  return Boolean(val);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ──────────────────────────────────────────────
// Dashboard
// ──────────────────────────────────────────────

router.get('/', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const meetings = queries.getMeetingsByStatus().all('scheduled') as Record<string, unknown>[];
    const clients = queries.getAllClients().all() as Record<string, unknown>[];

    const template = loadTemplate('dashboard');
    const content = renderSimpleTemplate(template, { meetings, clients });
    const html = renderLayout('Dashboard', content);

    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// Briefing view
// ──────────────────────────────────────────────

router.get('/briefing/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const meeting = queries.getMeetingById().get(req.params.id) as Record<string, unknown> | undefined;
    if (!meeting) {
      res.status(404).type('html').send(renderLayout('Not Found', '<p class="text-gray-500">Meeting not found.</p>'));
      return;
    }

    let briefing = null;
    if (meeting.briefing) {
      briefing = JSON.parse(meeting.briefing as string);
    }

    const template = loadTemplate('briefing');
    const content = renderSimpleTemplate(template, { meeting, briefing });
    const html = renderLayout('Briefing', content);

    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// Prepare briefing (POST)
// ──────────────────────────────────────────────

router.post('/briefing/:id/prepare', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const meeting = queries.getMeetingById().get(req.params.id) as Record<string, unknown> | undefined;
    if (!meeting) {
      res.status(404).type('html').send(renderLayout('Not Found', '<p class="text-gray-500">Meeting not found.</p>'));
      return;
    }

    const client = queries.getClientById().get(meeting.client_id as string) as Record<string, unknown> | undefined;
    if (!client) {
      res.status(404).type('html').send(renderLayout('Error', '<p class="text-gray-500">Client not found.</p>'));
      return;
    }

    const clientName = client.name as string;
    const context = await clientContextService.getClientContext(clientName);
    await briefingService.generateBriefing(req.params.id, clientName, context);

    logger.info('Briefing generated via web', { meetingId: req.params.id });
    res.redirect(`/briefing/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/briefing/prepare', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { meetingId } = req.body as { meetingId?: string };
    if (!meetingId) {
      res.redirect('/');
      return;
    }

    const meeting = queries.getMeetingById().get(meetingId) as Record<string, unknown> | undefined;
    if (!meeting) {
      res.redirect('/');
      return;
    }

    const client = queries.getClientById().get(meeting.client_id as string) as Record<string, unknown> | undefined;
    if (!client) {
      res.redirect('/');
      return;
    }

    const clientName = client.name as string;
    const context = await clientContextService.getClientContext(clientName);
    await briefingService.generateBriefing(meetingId, clientName, context);

    logger.info('Briefing generated via web', { meetingId });
    res.redirect(`/briefing/${meetingId}`);
  } catch (err) {
    next(err);
  }
});

export { router as viewRouter };
