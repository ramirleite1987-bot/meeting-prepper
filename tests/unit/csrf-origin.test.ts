import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { csrfOrigin } from '../../src/middleware/csrf-origin.js';

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(csrfOrigin);
  app.post('/api/clients', (_req, res) => {
    res.status(201).json({ ok: true });
  });
  app.post('/webhooks/linear', (_req, res) => {
    res.sendStatus(200);
  });
  return app;
}

describe('csrfOrigin', () => {
  const app = createApp();

  it('allows mutating requests with no Origin header', async () => {
    await request(app).post('/api/clients').send({ name: 'Acme' }).expect(201);
  });

  it('allows mutating requests whose Origin host matches Host', async () => {
    await request(app)
      .post('/api/clients')
      .set('Origin', 'http://127.0.0.1:3000')
      .set('Host', '127.0.0.1:3000')
      .send({ name: 'Acme' })
      .expect(201);
  });

  it('rejects mutating requests from a foreign Origin', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set('Origin', 'http://evil.test')
      .set('Host', '127.0.0.1:3000')
      .send({ name: 'Acme' })
      .expect(403);
    expect(res.body.error).toMatch(/cross-origin/i);
  });

  it('does not apply the Origin check to Linear webhooks', async () => {
    await request(app)
      .post('/webhooks/linear')
      .set('Origin', 'https://linear.app')
      .set('Host', '127.0.0.1:3000')
      .send({ type: 'Issue' })
      .expect(200);
  });
});
