import type { Request, Response, NextFunction } from 'express';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Reject mutating requests whose Origin host does not match Host.
 * Missing Origin is allowed so curl, MCP-adjacent tools, and tests keep working.
 * Linear webhooks authenticate with HMAC and are skipped.
 */
export function csrfOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING.has(req.method)) {
    next();
    return;
  }

  if (req.path.startsWith('/webhooks')) {
    next();
    return;
  }

  const origin = req.get('origin');
  if (!origin) {
    next();
    return;
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    res.status(403).json({ error: 'Invalid Origin' });
    return;
  }

  const host = req.get('host');
  if (host && originHost.toLowerCase() === host.toLowerCase()) {
    next();
    return;
  }

  res.status(403).json({ error: 'Cross-origin request blocked' });
}
