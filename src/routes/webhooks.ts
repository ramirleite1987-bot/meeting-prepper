import { Router, type Request, type Response } from 'express';
import { webhookVerify } from '../middleware/webhook-verify.js';
import { SyncService } from '../services/sync.service.js';
import { logger } from '../utils/logger.js';
import { notificationService } from '../services/notification.service.js';
import { mapLinearStateToTaskStatus } from '../adapters/linear-status.js';

const router = Router();
const syncService = new SyncService();

interface LinearWebhookPayload {
  type: string;
  action: string;
  updatedAt?: string;
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

    const statusName = payload.data.state?.name ?? 'Todo';

    const mappedStatus = mapLinearStateToTaskStatus(statusName);

    syncService
      .handleLinearUpdate({
        linearIssueId: payload.data.id,
        status: mappedStatus,
        updatedAt: payload.updatedAt ?? new Date().toISOString(),
      })
      .then(() => {
        notificationService
          .notify(
            'linear_status_change',
            `Linear issue status changed to ${statusName}`,
            `Issue ${payload.data.id} moved to ${mappedStatus}`,
            { linearIssueId: payload.data.id, status: mappedStatus },
          )
          .catch(() => {
            /* notification is best-effort */
          });
      })
      .catch((err: unknown) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Error processing Linear webhook', {
          issueId: payload.data.id,
          error: errorMsg,
        });
        notificationService
          .notify('sync_error', 'Linear webhook processing failed', errorMsg, {
            linearIssueId: payload.data.id,
          })
          .catch(() => {
            /* notification is best-effort */
          });
      });
  });
});

export default router;
