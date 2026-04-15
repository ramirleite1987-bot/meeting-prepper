import { Router, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { queries } from '../db/index.js';
import { BriefingService } from '../services/briefing.service.js';
import { ClientContextService } from '../services/client-context.service.js';
import { ExtractionService } from '../services/extraction.service.js';
import { SyncService } from '../services/sync.service.js';
import { search as runSearch } from '../services/search.service.js';
import {
  listActionItems,
  listOwners,
  updateStatus as updateActionItemStatus,
  isValidStatus,
} from '../services/action-items.service.js';
import { buildAgenda } from '../services/agenda.service.js';
import { formatBriefingAsMarkdown } from '../services/briefing-export.service.js';
import { buildStats } from '../services/stats.service.js';
import { logger } from '../utils/logger.js';
import type { AppError } from '../middleware/error-handler.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { notificationService } from '../services/notification.service.js';

const router = Router();

// Shared service instances
const clientContextService = new ClientContextService();
const briefingService = new BriefingService();
const extractionService = new ExtractionService();
const syncService = new SyncService();

function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

function createError(message: string, statusCode: number): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  return err;
}

// ──────────────────────────────────────────────
// Clients
// ──────────────────────────────────────────────

router.get(
  '/clients',
  asyncHandler((_req, res) => {
    const clients = queries.getAllClients().all();
    res.json(clients);
  }),
);

router.post(
  '/clients',
  asyncHandler((req, res) => {
    const { name, project } = req.body as { name?: string; project?: string };
    if (!name) {
      throw createError('name is required', 400);
    }

    const id = randomUUID();
    queries.insertClient().run({ id, name, project: project ?? null });
    const client = queries.getClientById().get(id);
    res.status(201).json(client);
  }),
);

router.get(
  '/clients/:id',
  asyncHandler((req, res) => {
    const client = queries.getClientById().get(param(req, 'id'));
    if (!client) {
      throw createError('Client not found', 404);
    }
    res.json(client);
  }),
);

router.get(
  '/clients/:id/timeline',
  asyncHandler((req, res) => {
    const client = queries.getClientById().get(param(req, 'id'));
    if (!client) {
      throw createError('Client not found', 404);
    }
    const history = queries.getClientHistory().all(param(req, 'id'));
    res.json(history);
  }),
);

// ──────────────────────────────────────────────
// Meetings
// ──────────────────────────────────────────────

router.get(
  '/meetings',
  asyncHandler((req, res) => {
    const { status, clientId } = req.query as { status?: string; clientId?: string };
    let meetings;
    if (status) {
      meetings = queries.getMeetingsByStatus().all(status);
    } else if (clientId) {
      meetings = queries.getMeetingsByClient().all(clientId);
    } else {
      // Return all meetings ordered by scheduled_at desc
      meetings = queries.getAllMeetings().all();
    }
    res.json(meetings);
  }),
);

router.post(
  '/meetings',
  asyncHandler((req, res) => {
    const { clientId, title, scheduledAt } = req.body as {
      clientId?: string;
      title?: string;
      scheduledAt?: string;
    };

    if (!clientId || !title) {
      throw createError('clientId and title are required', 400);
    }

    const client = queries.getClientById().get(clientId);
    if (!client) {
      throw createError('Client not found', 404);
    }

    const id = randomUUID();
    queries.insertMeeting().run({
      id,
      clientId,
      title,
      scheduledAt: scheduledAt ?? new Date().toISOString(),
      status: 'scheduled',
    });

    const meeting = queries.getMeetingById().get(id);
    res.status(201).json(meeting);
  }),
);

router.get(
  '/meetings/:id',
  asyncHandler((req, res) => {
    const meeting = queries.getMeetingById().get(param(req, 'id'));
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }
    res.json(meeting);
  }),
);

router.post(
  '/meetings/:id/prepare',
  asyncHandler(async (req, res) => {
    const meeting = queries.getMeetingById().get(param(req, 'id')) as
      | Record<string, unknown>
      | undefined;
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const client = queries.getClientById().get(meeting.client_id as string) as
      | Record<string, unknown>
      | undefined;
    if (!client) {
      throw createError('Client not found for this meeting', 404);
    }

    const clientName = client.name as string;
    const context = await clientContextService.getClientContext(clientName);
    const briefing = await briefingService.generateBriefing(param(req, 'id'), clientName, context);

    logger.info('Briefing generated', { meetingId: param(req, 'id'), traceId: req.traceId });
    await notificationService.notify(
      'briefing_generated',
      `Briefing generated for ${clientName}`,
      `Meeting briefing ready with ${Object.keys(briefing.sections).length} sections`,
      { meetingId: param(req, 'id'), clientName },
    );
    res.json(briefing);
  }),
);

router.get(
  '/meetings/:id/briefing',
  asyncHandler((req, res) => {
    const meeting = queries.getMeetingById().get(param(req, 'id')) as
      | Record<string, unknown>
      | undefined;
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const briefing = meeting.briefing;
    if (!briefing) {
      throw createError('No briefing generated yet', 404);
    }

    try {
      res.json(JSON.parse(briefing as string));
    } catch {
      throw createError('Briefing data is corrupted', 500);
    }
  }),
);

router.get(
  '/meetings/:id/briefing.md',
  asyncHandler((req, res) => {
    const meeting = queries.getMeetingById().get(param(req, 'id')) as
      | Record<string, unknown>
      | undefined;
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }
    if (!meeting.briefing) {
      throw createError('No briefing generated yet', 404);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(meeting.briefing as string);
    } catch {
      throw createError('Briefing data is corrupted', 500);
    }

    const client = queries.getClientById().get(meeting.client_id as string) as
      | { name?: string }
      | undefined;

    const md = formatBriefingAsMarkdown(
      {
        id: meeting.id as string,
        title: meeting.title as string,
        client_name: client?.name ?? null,
        scheduled_at: (meeting.scheduled_at as string | null) ?? null,
        status: (meeting.status as string) ?? 'scheduled',
      },
      parsed,
    );

    const safeTitle = (meeting.title as string)
      .replace(/[^a-zA-Z0-9-_ ]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase();
    const filename = `briefing-${safeTitle || meeting.id}.md`;
    const inline = req.query.inline === '1';

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
    );
    res.send(md);
  }),
);

// ──────────────────────────────────────────────
// Post-Call Extraction
// ──────────────────────────────────────────────

router.post(
  '/meetings/:id/extract',
  asyncHandler(async (req, res) => {
    const meeting = queries.getMeetingById().get(param(req, 'id'));
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const result = await extractionService.extract(param(req, 'id'));

    logger.info('Extraction completed', {
      meetingId: param(req, 'id'),
      sources: result.sources.length,
      traceId: req.traceId,
    });
    await notificationService.notify(
      'extraction_completed',
      'Post-call extraction completed',
      `${result.actionItems.length} action items extracted from ${result.sources.length} source(s)`,
      { meetingId: param(req, 'id'), sources: result.sources.map((s) => s.source) },
    );
    res.json(result);
  }),
);

router.get(
  '/meetings/:id/post-call',
  asyncHandler((req, res) => {
    const meeting = queries.getMeetingById().get(param(req, 'id')) as
      | Record<string, unknown>
      | undefined;
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const postCallNotes = meeting.post_call_notes;
    if (!postCallNotes) {
      throw createError('No post-call data available yet', 404);
    }

    try {
      res.json(JSON.parse(postCallNotes as string));
    } catch {
      throw createError('Post-call data is corrupted', 500);
    }
  }),
);

router.get(
  '/meetings/:id/action-items',
  asyncHandler((req, res) => {
    const meeting = queries.getMeetingById().get(param(req, 'id'));
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const actionItems = queries.getActionItemsByMeeting().all(param(req, 'id'));
    res.json(actionItems);
  }),
);

// ──────────────────────────────────────────────
// Linear Sync
// ──────────────────────────────────────────────

router.post(
  '/meetings/:id/action-items/:itemId/sync',
  asyncHandler(async (req, res) => {
    const meeting = queries.getMeetingById().get(param(req, 'id'));
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const result = await syncService.syncActionItem(param(req, 'id'), param(req, 'itemId'));

    logger.info('Action item synced', {
      meetingId: param(req, 'id'),
      actionItemId: param(req, 'itemId'),
      traceId: req.traceId,
    });
    await notificationService.notify(
      'action_item_synced',
      'Action item synced to Linear',
      `Issue ${result.linearIssueId} ${result.status}`,
      {
        meetingId: param(req, 'id'),
        actionItemId: param(req, 'itemId'),
        linearIssueId: result.linearIssueId,
      },
    );
    res.json(result);
  }),
);

router.post(
  '/meetings/:id/sync-all',
  asyncHandler(async (req, res) => {
    const meeting = queries.getMeetingById().get(param(req, 'id'));
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const result = await syncService.syncAllActionItems(param(req, 'id'));

    logger.info('All action items synced', {
      meetingId: param(req, 'id'),
      synced: result.results.length,
      traceId: req.traceId,
    });
    res.json(result);
  }),
);

// ──────────────────────────────────────────────
// Notifications
// ──────────────────────────────────────────────

router.get(
  '/notifications',
  asyncHandler((_req, res) => {
    const notifications = notificationService.getRecentNotifications();
    res.json(notifications);
  }),
);

// ──────────────────────────────────────────────
// Stats
// ──────────────────────────────────────────────

router.get(
  '/stats',
  asyncHandler((_req, res) => {
    res.json(buildStats());
  }),
);

// ──────────────────────────────────────────────
// Agenda
// ──────────────────────────────────────────────

router.get(
  '/agenda',
  asyncHandler((_req, res) => {
    res.json(buildAgenda());
  }),
);

// ──────────────────────────────────────────────
// Action items (global)
// ──────────────────────────────────────────────

router.get(
  '/action-items',
  asyncHandler((req, res) => {
    const { status, priority, owner, clientId, q } = req.query as {
      status?: string;
      priority?: string;
      owner?: string;
      clientId?: string;
      q?: string;
    };
    const items = listActionItems({ status, priority, owner, clientId, q });
    res.json({
      total: items.length,
      filters: { status, priority, owner, clientId, q },
      items,
    });
  }),
);

router.get(
  '/action-items/owners',
  asyncHandler((_req, res) => {
    res.json({ owners: listOwners() });
  }),
);

router.patch(
  '/action-items/:id/status',
  asyncHandler((req, res) => {
    const { status } = req.body as { status?: string };
    if (!status || !isValidStatus(status)) {
      throw createError("status must be one of 'pending', 'synced', 'completed'", 400);
    }
    const updated = updateActionItemStatus(param(req, 'id'), status);
    if (!updated) {
      throw createError('Action item not found', 404);
    }
    res.json(updated);
  }),
);

// ──────────────────────────────────────────────
// Search
// ──────────────────────────────────────────────

router.get(
  '/search',
  asyncHandler((req, res) => {
    const q = (req.query.q as string | undefined) ?? '';
    const result = runSearch(q);
    res.json(result);
  }),
);

router.get('/notifications/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const unsubscribe = notificationService.subscribe((notification) => {
    res.write(`data: ${JSON.stringify(notification)}\n\n`);
  });

  req.on('close', () => {
    unsubscribe();
  });
});

export {
  router as apiRouter,
  clientContextService,
  briefingService,
  extractionService,
  syncService,
};
