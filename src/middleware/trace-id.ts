import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const TRACE_HEADER = 'x-trace-id';

declare module 'express-serve-static-core' {
  interface Request {
    traceId: string;
  }
}

/**
 * Assigns each request a stable trace ID — taken from the inbound `x-trace-id`
 * header when present, otherwise generated. The same ID is echoed back in the
 * response header and exposed on `req.traceId` for downstream loggers.
 */
export function traceId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(TRACE_HEADER);
  const id = incoming && incoming.length <= 128 ? incoming : randomUUID();
  req.traceId = id;
  res.setHeader(TRACE_HEADER, id);
  next();
}
