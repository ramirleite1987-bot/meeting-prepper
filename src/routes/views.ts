import { Router, type Request, type Response, type NextFunction } from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queries } from '../db/index.js';
import { clientContextService, briefingService } from './api.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const viewsDir = join(__dirname, '..', 'views');

const router = Router();

function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

const templateCache = new Map<string, string>();

function loadTemplate(name: string): string {
  const cached = templateCache.get(name);
  if (cached) return cached;
  const content = readFileSync(join(viewsDir, `${name}.html`), 'utf-8');
  templateCache.set(name, content);
  return content;
}

function renderLayout(title: string, content: string): string {
  const layout = loadTemplate('layout');
  return layout.replace('{{title}}', title).replace('{{content}}', content);
}

function renderSimpleTemplate(template: string, data: Record<string, unknown>): string {
  let result = template;

  // Handle {{#if value}} ... {{else}} ... {{/if}}
  result = result.replace(
    /\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key: string, block: string) => {
      const val = resolveValue(data, key);
      const [ifBlock, elseBlock] = block.split('{{else}}');
      if (isTruthy(val)) {
        return ifBlock;
      }
      return elseBlock ?? '';
    },
  );

  // Handle {{#each items}} ... {{/each}}
  result = result.replace(
    /\{\{#each\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_match, key: string, block: string) => {
      const arr = resolveValue(data, key);
      if (!Array.isArray(arr)) return '';
      return arr
        .map((item: unknown) => {
          let rendered = block;
          if (typeof item === 'object' && item !== null) {
            const obj = item as Record<string, unknown>;
            rendered = rendered.replace(/\{\{this\.([\w]+)\}\}/g, (_m: string, prop: string) =>
              escapeHtml(String(obj[prop] ?? '')),
            );
          }
          rendered = rendered.replace(/\{\{this\}\}/g, escapeHtml(String(item)));
          return rendered;
        })
        .join('');
    },
  );

  // Handle {{key}} simple replacements
  result = result.replace(/\{\{([\w.]+)\}\}/g, (_match, key: string) => {
    const val = resolveValue(data, key);
    return val !== null && val !== undefined ? escapeHtml(String(val)) : '';
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
    const meeting = queries.getMeetingById().get(param(req, 'id')) as
      | Record<string, unknown>
      | undefined;
    if (!meeting) {
      res
        .status(404)
        .type('html')
        .send(renderLayout('Not Found', '<p class="text-gray-500">Meeting not found.</p>'));
      return;
    }

    let briefing = null;
    if (meeting.briefing) {
      try {
        briefing = JSON.parse(meeting.briefing as string);
      } catch {
        /* corrupted data */
      }
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
    const meeting = queries.getMeetingById().get(param(req, 'id')) as
      | Record<string, unknown>
      | undefined;
    if (!meeting) {
      res
        .status(404)
        .type('html')
        .send(renderLayout('Not Found', '<p class="text-gray-500">Meeting not found.</p>'));
      return;
    }

    const client = queries.getClientById().get(meeting.client_id as string) as
      | Record<string, unknown>
      | undefined;
    if (!client) {
      res
        .status(404)
        .type('html')
        .send(renderLayout('Error', '<p class="text-gray-500">Client not found.</p>'));
      return;
    }

    const clientName = client.name as string;
    const context = await clientContextService.getClientContext(clientName);
    await briefingService.generateBriefing(param(req, 'id'), clientName, context);

    logger.info('Briefing generated via web', { meetingId: param(req, 'id') });
    res.redirect(`/briefing/${param(req, 'id')}`);
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

    const client = queries.getClientById().get(meeting.client_id as string) as
      | Record<string, unknown>
      | undefined;
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

// ──────────────────────────────────────────────
// Client detail / timeline view
// ──────────────────────────────────────────────

router.get('/clients/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = queries.getClientById().get(param(req, 'id')) as
      | Record<string, unknown>
      | undefined;
    if (!client) {
      res
        .status(404)
        .type('html')
        .send(renderLayout('Not Found', '<p class="text-gray-500">Client not found.</p>'));
      return;
    }

    const timeline = clientContextService.getClientTimeline(param(req, 'id'));
    const events = timeline.map((evt) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(evt.event_data);
      } catch {
        /* skip */
      }
      return {
        ...evt,
        parsed_title: parsed.title || parsed.name || evt.event_type,
        parsed_description: parsed.description || parsed.summary || '',
        linear_issue_id: parsed.linear_issue_id || null,
        type_class:
          evt.event_type === 'meeting'
            ? 'bg-indigo-100 text-indigo-800'
            : evt.event_type === 'task_created'
              ? 'bg-green-100 text-green-800'
              : evt.event_type === 'task_updated'
                ? 'bg-yellow-100 text-yellow-800'
                : 'bg-gray-100 text-gray-800',
      };
    });

    const template = loadTemplate('client-detail');
    const content = renderSimpleTemplate(template, { client, events });
    const html = renderLayout(`${client.name} - Timeline`, content);

    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// Post-call review view
// ──────────────────────────────────────────────

router.get('/post-call/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const meeting = queries.getMeetingById().get(param(req, 'id')) as
      | Record<string, unknown>
      | undefined;
    if (!meeting) {
      res
        .status(404)
        .type('html')
        .send(renderLayout('Not Found', '<p class="text-gray-500">Meeting not found.</p>'));
      return;
    }

    let postCall = null;
    if (meeting.post_call_notes) {
      try {
        postCall = JSON.parse(meeting.post_call_notes as string);
      } catch {
        /* corrupted data */
      }
    }

    // Also gather consolidated data from meeting_sources
    if (!postCall) {
      const sources = queries.getMeetingSourcesByMeeting().all(param(req, 'id')) as Record<
        string,
        unknown
      >[];
      if (sources.length > 0) {
        const summaries: string[] = [];
        const decisions: string[] = [];
        const risks: string[] = [];
        for (const src of sources) {
          if (src.summary) summaries.push(src.summary as string);
          if (src.decisions) {
            try {
              decisions.push(...JSON.parse(src.decisions as string));
            } catch {
              /* skip */
            }
          }
          if (src.risks) {
            try {
              risks.push(...JSON.parse(src.risks as string));
            } catch {
              /* skip */
            }
          }
        }
        if (summaries.length > 0 || decisions.length > 0 || risks.length > 0) {
          postCall = {
            summary: summaries.join(' '),
            decisions,
            risks,
          };
        }
      }
    }

    const actionItems = (
      queries.getActionItemsByMeeting().all(param(req, 'id')) as Record<string, unknown>[]
    ).map((item) => ({
      ...item,
      priorityClass:
        item.priority === 'high'
          ? 'bg-red-100 text-red-800'
          : item.priority === 'low'
            ? 'bg-green-100 text-green-800'
            : 'bg-yellow-100 text-yellow-800',
    }));

    const template = loadTemplate('post-call');
    const content = renderSimpleTemplate(template, { meeting, postCall, actionItems });
    const html = renderLayout('Post-Call Review', content);

    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

export { router as viewRouter };
