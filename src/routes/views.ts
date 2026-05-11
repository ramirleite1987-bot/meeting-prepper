import { Router, type Request, type Response, type NextFunction } from 'express';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { queries } from '../db/index.js';
import {
  clientContextService,
  briefingService,
  meetingContextService,
} from './api.js';
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

  // Handle {{#each items}} ... {{/each}} first – this expands items & processes inner templates per-item
  result = result.replace(/\{\{#each\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_match, key: string, block: string) => {
    const arr = resolveValue(data, key);
    if (!Array.isArray(arr) || arr.length === 0) return '';
    return arr.map((item: unknown) => {
      let rendered = block;
      if (typeof item === 'object' && item !== null) {
        const obj = item as Record<string, unknown>;
        // Process inner {{#if this.prop}} blocks with item context
        rendered = rendered.replace(/\{\{#if\s+this\.([\w]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m: string, prop: string, innerBlock: string) => {
          const val = obj[prop];
          const [ifBlock, elseBlock] = innerBlock.split('{{else}}');
          return isTruthy(val) ? ifBlock : (elseBlock ?? '');
        });
        // Process inner {{#each this.prop}} blocks with item context
        rendered = rendered.replace(/\{\{#each\s+this\.([\w]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_m: string, prop: string, innerBlock: string) => {
          const innerArr = obj[prop];
          if (!Array.isArray(innerArr)) return '';
          return innerArr.map((innerItem: unknown) => {
            let innerRendered = innerBlock;
            if (typeof innerItem === 'object' && innerItem !== null) {
              const innerObj = innerItem as Record<string, unknown>;
              innerRendered = innerRendered.replace(/\{\{this\.([\w]+)\}\}/g, (_m2: string, p: string) => escapeHtml(String(innerObj[p] ?? '')));
            }
            innerRendered = innerRendered.replace(/\{\{this\}\}/g, escapeHtml(String(innerItem)));
            return innerRendered;
          }).join('');
        });
        // Replace {{this.prop}} values
        rendered = rendered.replace(/\{\{this\.([\w]+)\}\}/g, (_m: string, prop: string) => escapeHtml(String(obj[prop] ?? '')));
      }
      rendered = rendered.replace(/\{\{this\}\}/g, escapeHtml(String(item)));
      return rendered;
    }).join('');
  });

  // Handle {{#if value}} ... {{else}} ... {{/if}} (top-level only now, inner ones handled in each)
  result = result.replace(/\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_match, key: string, block: string) => {
    const val = resolveValue(data, key);
    const [ifBlock, elseBlock] = block.split('{{else}}');
    if (isTruthy(val)) {
      return ifBlock;
    }
    return elseBlock ?? '';
  });

  // Handle {{{key}}} raw HTML replacements FIRST (triple braces for unescaped output)
  result = result.replace(/\{\{\{([\w.]+)\}\}\}/g, (_match, key: string) => {
    const val = resolveValue(data, key);
    return val !== null && val !== undefined ? String(val) : '';
  });

  // Handle {{key}} simple replacements (double braces, escaped)
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
    const meetings = queries.getMeetingsWithClient().all('scheduled') as Record<string, unknown>[];
    const completedMeetings = queries.getMeetingsWithClient().all('completed') as Record<string, unknown>[];
    const allMeetings = [...meetings, ...completedMeetings].map(m => ({
      ...m,
      status_class: m.status === 'completed' ? 'bg-green-100 text-green-800' :
                     m.status === 'in_progress' ? 'bg-yellow-100 text-yellow-800' :
                     'bg-blue-100 text-blue-800',
    }));
    const clients = queries.getAllClients().all() as Record<string, unknown>[];

    const template = loadTemplate('dashboard');
    const content = renderSimpleTemplate(template, { meetings: allMeetings, clients });
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
    const meeting = queries.getMeetingWithClient().get(param(req, 'id')) as Record<string, unknown> | undefined;
    if (!meeting) {
      res.status(404).type('html').send(renderLayout('Not Found', '<p class="text-gray-500">Meeting not found.</p>'));
      return;
    }

    let briefing = null;
    const briefingSections: Array<{ title: string; items: string[] }> = [];
    let hasNoBriefing = true;
    let briefingHtml = '';
    if (meeting.briefing) {
      try {
        briefing = JSON.parse(meeting.briefing as string);
        hasNoBriefing = false;
        // Flatten sections into a simple array for template rendering
        if (briefing && briefing.sections) {
          const s = briefing.sections;
          const sectionOrder: Array<{ key: string; title: string }> = [
            { key: 'lastDeliveries', title: 'Last Deliveries' },
            { key: 'openItemsAndRisks', title: 'Open Items & Risks' },
            { key: 'recentAgreements', title: 'Recent Agreements' },
            { key: 'suggestedNextSteps', title: 'Suggested Next Steps' },
            { key: 'recommendedQuestions', title: 'Recommended Questions' },
          ];
          for (const { key, title } of sectionOrder) {
            if (s[key] && s[key].items && s[key].items.length > 0) {
              briefingSections.push({ title, items: s[key].items.map(String) });
              const itemsHtml = s[key].items.map((i: unknown) => `<li>${escapeHtml(String(i))}</li>`).join('');
              briefingHtml += `<section class="bg-white shadow rounded-lg p-6"><h2 class="text-lg font-semibold text-gray-800 mb-3">${escapeHtml(title)}</h2><ul class="list-disc list-inside space-y-1 text-gray-700">${itemsHtml}</ul></section>`;
            }
          }
        }
      } catch { /* corrupted data */ }
    }

    const template = loadTemplate('briefing');
    const content = renderSimpleTemplate(template, { meeting, briefingHtml, hasNoBriefing });
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
    const meeting = queries.getMeetingWithClient().get(param(req, 'id')) as Record<string, unknown> | undefined;
    if (!meeting) {
      res.status(404).type('html').send(renderLayout('Not Found', '<p class="text-gray-500">Meeting not found.</p>'));
      return;
    }

    const clientName = meeting.client_name as string;
    if (!clientName) {
      res.status(404).type('html').send(renderLayout('Error', '<p class="text-gray-500">Client not found.</p>'));
      return;
    }

    const context = [
      ...(await clientContextService.getClientContext(clientName)),
      ...meetingContextService.getAttachedContextEntries(param(req, 'id')),
    ];
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

    const meeting = queries.getMeetingWithClient().get(meetingId) as Record<string, unknown> | undefined;
    if (!meeting) {
      res.redirect('/');
      return;
    }

    const clientName = meeting.client_name as string;
    if (!clientName) {
      res.redirect('/');
      return;
    }

    const context = [
      ...(await clientContextService.getClientContext(clientName)),
      ...meetingContextService.getAttachedContextEntries(meetingId),
    ];
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
    const client = queries.getClientById().get(param(req, 'id')) as Record<string, unknown> | undefined;
    if (!client) {
      res.status(404).type('html').send(renderLayout('Not Found', '<p class="text-gray-500">Client not found.</p>'));
      return;
    }

    const timeline = clientContextService.getClientTimeline(param(req, 'id'));
    const events = timeline.map((evt) => {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(evt.event_data); } catch { /* skip */ }

      // Precompute the inline link HTML so the template can inject it via
      // {{{linksHtml}}} without nested {{#if}} blocks (the simple template
      // engine's outer regex consumed the inner {{/if}} closer).
      const links: string[] = [];
      if (evt.meeting_id) {
        links.push(
          `<a href="/briefing/${escapeHtml(evt.meeting_id)}" class="text-indigo-600 hover:text-indigo-800">View Meeting</a>`,
        );
      }
      if (parsed.linear_issue_id) {
        links.push(
          `<span class="text-gray-500">Linear: ${escapeHtml(String(parsed.linear_issue_id))}</span>`,
        );
      }

      return {
        ...evt,
        parsed_title: parsed.title || parsed.name || evt.event_type,
        parsed_description: parsed.description || parsed.summary || '',
        linear_issue_id: parsed.linear_issue_id || null,
        linksHtml: links.join(''),
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
    const content = renderSimpleTemplate(template, {
      client,
      events,
      hasEvents: events.length > 0,
      noEvents: events.length === 0,
    });
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
    const meeting = queries.getMeetingWithClient().get(param(req, 'id')) as Record<string, unknown> | undefined;
    if (!meeting) {
      res.status(404).type('html').send(renderLayout('Not Found', '<p class="text-gray-500">Meeting not found.</p>'));
      return;
    }

    let postCall: Record<string, unknown> | null = null;
    if (meeting.post_call_notes) {
      try { postCall = JSON.parse(meeting.post_call_notes as string); } catch { /* corrupted data */ }
    }

    // Also gather consolidated data from meeting_sources
    if (!postCall) {
      const sources = queries.getMeetingSourcesByMeeting().all(param(req, 'id')) as Record<string, unknown>[];
      if (sources.length > 0) {
        const summaries: string[] = [];
        const decisions: string[] = [];
        const risks: string[] = [];
        for (const src of sources) {
          if (src.summary) summaries.push(src.summary as string);
          if (src.decisions) {
            try { decisions.push(...JSON.parse(src.decisions as string)); } catch { /* skip */ }
          }
          if (src.risks) {
            try { risks.push(...JSON.parse(src.risks as string)); } catch { /* skip */ }
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

    // Flatten postCall data into sections for template rendering
    let postCallSectionsHtml = '';
    let postCallSummary = '';
    let hasPostCallSummary = false;
    if (postCall) {
      if (postCall.summary && String(postCall.summary).trim()) {
        postCallSummary = String(postCall.summary);
        hasPostCallSummary = true;
      }
      if (Array.isArray(postCall.decisions) && postCall.decisions.length > 0) {
        const items = postCall.decisions.map(String);
        const itemsHtml = items.map(i => `<li>${escapeHtml(i)}</li>`).join('');
        postCallSectionsHtml += `<section class="bg-white shadow rounded-lg p-6"><h2 class="text-lg font-semibold text-gray-800 mb-3">Decisions</h2><ul class="list-disc list-inside space-y-1 text-gray-700">${itemsHtml}</ul></section>`;
      }
      if (Array.isArray(postCall.risks) && postCall.risks.length > 0) {
        const items = postCall.risks.map(String);
        const itemsHtml = items.map(i => `<li>${escapeHtml(i)}</li>`).join('');
        postCallSectionsHtml += `<section class="bg-white shadow rounded-lg p-6"><h2 class="text-lg font-semibold text-gray-800 mb-3">Risks &amp; Concerns</h2><ul class="list-disc list-inside space-y-1 text-gray-700">${itemsHtml}</ul></section>`;
      }
    }
    const noPostCall = !postCall ? true : false;

    const actionItems = (queries.getActionItemsByMeeting().all(param(req, 'id')) as Record<string, unknown>[]).map(item => ({
      ...item,
      priorityClass: item.priority === 'high' ? 'bg-red-100 text-red-800' :
                     item.priority === 'low' ? 'bg-green-100 text-green-800' :
                     'bg-yellow-100 text-yellow-800',
    }));

    const template = loadTemplate('post-call');
    const content = renderSimpleTemplate(template, {
      meeting,
      postCallSectionsHtml,
      postCallSummary,
      hasPostCallSummary,
      actionItems,
      noPostCall,
    });
    const html = renderLayout('Post-Call Review', content);

    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// Create Client (POST)
// ──────────────────────────────────────────────

router.post('/clients', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, project } = req.body as { name?: string; project?: string };
    if (!name) {
      res.redirect('/');
      return;
    }

    const id = randomUUID();
    queries.insertClient().run({ id, name, project: project ?? null });

    logger.info('Client created via web', { clientId: id, name });
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// Create Meeting (POST)
// ──────────────────────────────────────────────

router.post('/meetings', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientId, title, scheduledAt } = req.body as {
      clientId?: string;
      title?: string;
      scheduledAt?: string;
    };

    if (!clientId || !title) {
      res.redirect('/');
      return;
    }

    const client = queries.getClientById().get(clientId);
    if (!client) {
      res.redirect('/');
      return;
    }

    const id = randomUUID();
    queries.insertMeeting().run({
      id,
      clientId,
      title,
      scheduledAt: scheduledAt ?? new Date().toISOString(),
      status: 'scheduled',
    });

    queries.insertClientHistory().run({
      id: randomUUID(),
      clientId,
      meetingId: id,
      eventType: 'meeting',
      eventData: JSON.stringify({ title, scheduledAt: scheduledAt ?? new Date().toISOString() }),
    });

    logger.info('Meeting created via web', { meetingId: id, clientId });
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

export { router as viewRouter };
