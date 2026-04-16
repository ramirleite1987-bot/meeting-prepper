import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export function webhookVerify(req: Request, res: Response, next: NextFunction): void {
  const secret = config.linearWebhookSecret;
  if (!secret) {
    logger.error('LINEAR_WEBHOOK_SECRET not configured');
    res.status(500).json({ error: 'Webhook secret not configured' });
    return;
  }

  const signature = req.headers['linear-signature'] as string | undefined;
  if (!signature) {
    res.status(401).json({ error: 'Missing signature' });
    return;
  }

  const body = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');

  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    logger.warn('Webhook signature verification failed');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  next();
}
