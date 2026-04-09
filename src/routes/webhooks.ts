import { Router, Request, Response } from 'express';
import { webhookVerify } from '../middleware/webhook-verify.js';
import { SyncService } from '../services/sync.service.js';
import { logger } from '../utils/logger.js';

const router = Router();
const syncService = new SyncService();

interface LinearWebhookPayload {
  type: string;
  action: string;
  data: {
    id: string;
    state?: { name: string };
    [key: string]: unknown;
  };
}

router.post('/linear', webhookVerify, (req: Request, res: Response) => {
  res.sendStatus(200);

  setImmediate(() => {
    const payload = req.body as LinearWebhookPayload;

    if (payload.type !== 'Issue') {
      logger.debug('Ignoring non-Issue webhook', { type: payload.type });
      return;
    }

    const statusName = payload.data.state?.name ?? 'Unknown';

    syncService
      .handleLinearUpdate({
        linearIssueId: payload.data.id,
        status: statusName,
      })
      .catch((err: unknown) => {
        logger.error('Error processing Linear webhook', {
          issueId: payload.data.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });
});

export default router;
