import { Router, type Request, type Response, type NextFunction } from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queries } from '../db/index.js';
import { clientContextService, briefingService } from './api.js';
import { search as runSearch } from '../services/search.service.js';
import {
  listActionItems,
  listOwners,
  isValidStatus,
  updateStatus as updateActionItemStatusFn,
} from '../services/action-items.service.js';
import { buildAgenda } from '../services/agenda.service.js';
import { buildStats } from '../services/stats.service.js';
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
// Stats view
// ──────────────────────────────────────────────

router.get('/stats', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = buildStats();
    const data = {
      ...stats,
      hasTopClients: stats.topClients.length > 0,
      hasTopOwners: stats.topOwners.length > 0,
      avgDisplay:
        stats.averages.actionItemsPerCompletedMeeting === null
          ? '—'
          : String(stats.averages.actionItemsPerCompletedMeeting),
    };
    const template = loadTemplate('stats');
    const content = renderSimpleTemplate(template, data);
    const html = renderLayout('Stats', content);
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// Agenda view
// ──────────────────────────────────────────────

function formatStartsIn(minutes: number | null): string {
  if (minutes === null) return '';
  const abs = Math.abs(minutes);
  const sign = minutes < 0 ? 'ago' : '';
  if (abs < 60) return `in ${minutes} min`.replace('in -', `${abs} min ${sign} `).trim();
  const hours = Math.round(abs / 60);
  if (hours < 24) return minutes < 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return minutes < 0 ? `${days}d ago` : `in ${days}d`;
}

function bucketColor(bucket: string): string {
  switch (bucket) {
    case 'overdue':
      return 'bg-red-50 border-red-200';
    case 'today':
      return 'bg-indigo-50 border-indigo-200';
    case 'tomorrow':
      return 'bg-blue-50 border-blue-200';
    case 'this_week':
      return 'bg-white border-gray-200';
    case 'later':
      return 'bg-white border-gray-200';
    default:
      return 'bg-gray-50 border-gray-200';
  }
}

router.get('/agenda', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const agenda = buildAgenda();

    const next = agenda.next
      ? {
          ...agenda.next,
          starts_in_label: formatStartsIn(agenda.next.starts_in_minutes),
          scheduled_label: agenda.next.scheduled_at
            ? new Date(agenda.next.scheduled_at).toLocaleString()
            : 'Unscheduled',
          client_name: agenda.next.client_name ?? '—',
        }
      : null;

    const buckets = agenda.buckets.map((b) => ({
      ...b,
      colorClass: bucketColor(b.bucket),
      meetings: b.meetings.map((m) => ({
        ...m,
        scheduled_label: m.scheduled_at ? new Date(m.scheduled_at).toLocaleString() : 'Unscheduled',
        starts_in_label: formatStartsIn(m.starts_in_minutes),
        client_name: m.client_name ?? '—',
        is_completed: m.status === 'completed',
        needs_briefing: !m.has_briefing && m.status !== 'completed',
        needs_post_call: m.status === 'completed' && !m.has_post_call,
      })),
    }));

    const data = {
      hasNext: next !== null,
      next,
      hasBuckets: buckets.length > 0,
      buckets,
    };

    const template = loadTemplate('agenda');
    const content = renderSimpleTemplate(template, data);
    const html = renderLayout('Agenda', content);
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// Action items inbox view
// ──────────────────────────────────────────────

function priorityClass(priority: string | null | undefined): string {
  if (priority === 'high') return 'bg-red-100 text-red-800';
  if (priority === 'low') return 'bg-green-100 text-green-800';
  return 'bg-yellow-100 text-yellow-800';
}

function statusClass(status: string | null | undefined): string {
  if (status === 'completed') return 'bg-green-100 text-green-800';
  if (status === 'synced') return 'bg-blue-100 text-blue-800';
  return 'bg-gray-100 text-gray-700';
}

router.get('/action-items', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = {
      status: (req.query.status as string | undefined) ?? '',
      priority: (req.query.priority as string | undefined) ?? '',
      owner: (req.query.owner as string | undefined) ?? '',
      clientId: (req.query.clientId as string | undefined) ?? '',
      q: ((req.query.q as string | undefined) ?? '').slice(0, 200),
    };

    const items = listActionItems(filters).map((item) => ({
      ...item,
      owner: item.owner ?? 'Unassigned',
      description: item.description ?? '',
      meeting_title: item.meeting_title ?? 'Unknown meeting',
      client_name: item.client_name ?? '—',
      deadline_display: item.deadline ? new Date(item.deadline).toLocaleDateString() : '',
      priorityClass: priorityClass(item.priority),
      statusClass: statusClass(item.status),
      isCompleted: item.status === 'completed',
      nextStatus: item.status === 'completed' ? 'pending' : 'completed',
      nextStatusLabel: item.status === 'completed' ? 'Reopen' : 'Mark done',
    }));

    const owners = listOwners();
    const counts = {
      total: items.length,
      pending: items.filter((i) => i.status === 'pending').length,
      synced: items.filter((i) => i.status === 'synced').length,
      completed: items.filter((i) => i.status === 'completed').length,
      high: items.filter((i) => i.priority === 'high').length,
    };

    const data = {
      filters,
      items,
      owners: owners.map((o) => ({ value: o, selected: o === filters.owner })),
      counts,
      hasItems: items.length > 0,
      isStatusPending: filters.status === 'pending',
      isStatusSynced: filters.status === 'synced',
      isStatusCompleted: filters.status === 'completed',
      isStatusAll: !filters.status,
      isPriorityHigh: filters.priority === 'high',
      isPriorityMedium: filters.priority === 'medium',
      isPriorityLow: filters.priority === 'low',
      isPriorityAll: !filters.priority,
    };

    const template = loadTemplate('action-items');
    const content = renderSimpleTemplate(template, data);
    const html = renderLayout('Action items', content);
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

router.post('/action-items/:id/status', (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = (req.body as { status?: string }).status;
    if (!status || !isValidStatus(status)) {
      res.redirect('/action-items');
      return;
    }
    updateActionItemStatusFn(param(req, 'id'), status);
    const back = (req.body as { redirect?: string }).redirect ?? '/action-items';
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// Search view
// ──────────────────────────────────────────────

router.get('/search', (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = ((req.query.q as string | undefined) ?? '').slice(0, 200);
    const data = runSearch(q);

    const grouped = {
      query: data.query,
      total: data.total,
      hasQuery: data.query.length > 0,
      hasResults: data.total > 0,
      counts: data.counts,
      clients: data.results
        .filter((r) => r.type === 'client')
        .map((r) => ({ ...r, snippet: r.snippet })),
      meetings: data.results
        .filter((r) => r.type === 'meeting')
        .map((r) => ({
          ...r,
          status: (r.meta as { status?: string }).status ?? '',
          clientName: (r.meta as { clientName?: string | null }).clientName ?? '—',
        })),
      actionItems: data.results
        .filter((r) => r.type === 'action_item')
        .map((r) => {
          const meta = r.meta as {
            owner?: string | null;
            priority?: string;
            status?: string;
            clientName?: string | null;
            meetingTitle?: string | null;
          };
          return {
            ...r,
            owner: meta.owner ?? 'Unassigned',
            priority: meta.priority ?? 'medium',
            status: meta.status ?? 'pending',
            clientName: meta.clientName ?? '—',
            meetingTitle: meta.meetingTitle ?? '',
            priorityClass:
              meta.priority === 'high'
                ? 'bg-red-100 text-red-800'
                : meta.priority === 'low'
                  ? 'bg-green-100 text-green-800'
                  : 'bg-yellow-100 text-yellow-800',
          };
        }),
    };

    const template = loadTemplate('search');
    const content = renderSimpleTemplate(template, grouped);
    const html = renderLayout(`Search${data.query ? ` — ${data.query}` : ''}`, content);

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
