import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { queries } from '../db/index.js';
import { BriefingService } from '../services/briefing.service.js';
import { ClientContextService } from '../services/client-context.service.js';
import { ExtractionService } from '../services/extraction.service.js';
import { SyncService } from '../services/sync.service.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../middleware/error-handler.js';

const router = Router();

// Shared service instances
const clientContextService = new ClientContextService();
const briefingService = new BriefingService();
const extractionService = new ExtractionService();
const syncService = new SyncService();

function createError(message: string, statusCode: number): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  return err;
}

// ──────────────────────────────────────────────
// Clients
// ──────────────────────────────────────────────

router.get('/clients', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const clients = queries.getAllClients().all();
    res.json(clients);
  } catch (err) {
    next(err);
  }
});

router.post('/clients', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, project } = req.body as { name?: string; project?: string };
    if (!name) {
      throw createError('name is required', 400);
    }

    const id = randomUUID();
    queries.insertClient().run({ id, name, project: project ?? null });
    const client = queries.getClientById().get(id);
    res.status(201).json(client);
  } catch (err) {
    next(err);
  }
});

router.get('/clients/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = queries.getClientById().get(req.params.id);
    if (!client) {
      throw createError('Client not found', 404);
    }
    res.json(client);
  } catch (err) {
    next(err);
  }
});

router.get('/clients/:id/timeline', (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = queries.getClientById().get(req.params.id);
    if (!client) {
      throw createError('Client not found', 404);
    }
    const history = queries.getClientHistory().all(req.params.id);
    res.json(history);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// Meetings
// ──────────────────────────────────────────────

router.get('/meetings', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, clientId } = req.query as { status?: string; clientId?: string };
    let meetings;
    if (status) {
      meetings = queries.getMeetingsByStatus().all(status);
    } else if (clientId) {
      meetings = queries.getMeetingsByClient().all(clientId);
    } else {
      // Return all meetings ordered by scheduled_at desc
      meetings = queries.getMeetingsByStatus().all('scheduled');
    }
    res.json(meetings);
  } catch (err) {
    next(err);
  }
});

router.post('/meetings', (req: Request, res: Response, next: NextFunction) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

router.get('/meetings/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const meeting = queries.getMeetingById().get(req.params.id);
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }
    res.json(meeting);
  } catch (err) {
    next(err);
  }
});

router.post('/meetings/:id/prepare', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const meeting = queries.getMeetingById().get(req.params.id) as Record<string, unknown> | undefined;
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const client = queries.getClientById().get(meeting.client_id as string) as Record<string, unknown> | undefined;
    if (!client) {
      throw createError('Client not found for this meeting', 404);
    }

    const clientName = client.name as string;
    const context = await clientContextService.getClientContext(clientName);
    const briefing = await briefingService.generateBriefing(req.params.id, clientName, context);

    logger.info('Briefing generated', { meetingId: req.params.id });
    res.json(briefing);
  } catch (err) {
    next(err);
  }
});

router.get('/meetings/:id/briefing', (req: Request, res: Response, next: NextFunction) => {
  try {
    const meeting = queries.getMeetingById().get(req.params.id) as Record<string, unknown> | undefined;
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const briefing = meeting.briefing;
    if (!briefing) {
      throw createError('No briefing generated yet', 404);
    }

    res.json(JSON.parse(briefing as string));
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// Post-Call Extraction
// ──────────────────────────────────────────────

router.post('/meetings/:id/extract', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const meeting = queries.getMeetingById().get(req.params.id);
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const result = await extractionService.extract(req.params.id);

    logger.info('Extraction completed', { meetingId: req.params.id, sources: result.sources.length });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/meetings/:id/post-call', (req: Request, res: Response, next: NextFunction) => {
  try {
    const meeting = queries.getMeetingById().get(req.params.id) as Record<string, unknown> | undefined;
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const postCallNotes = meeting.post_call_notes;
    if (!postCallNotes) {
      throw createError('No post-call data available yet', 404);
    }

    res.json(JSON.parse(postCallNotes as string));
  } catch (err) {
    next(err);
  }
});

router.get('/meetings/:id/action-items', (req: Request, res: Response, next: NextFunction) => {
  try {
    const meeting = queries.getMeetingById().get(req.params.id);
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const actionItems = queries.getActionItemsByMeeting().all(req.params.id);
    res.json(actionItems);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// Linear Sync
// ──────────────────────────────────────────────

router.post('/meetings/:id/action-items/:itemId/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const meeting = queries.getMeetingById().get(req.params.id);
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const result = await syncService.syncActionItem(req.params.id, req.params.itemId);

    logger.info('Action item synced', { meetingId: req.params.id, actionItemId: req.params.itemId });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/meetings/:id/sync-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const meeting = queries.getMeetingById().get(req.params.id);
    if (!meeting) {
      throw createError('Meeting not found', 404);
    }

    const result = await syncService.syncAllActionItems(req.params.id);

    logger.info('All action items synced', { meetingId: req.params.id, synced: result.results.length });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export { router as apiRouter, clientContextService, briefingService, extractionService, syncService };
