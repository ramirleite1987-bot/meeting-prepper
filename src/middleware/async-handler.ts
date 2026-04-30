import type { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown> | unknown;

/**
 * Wraps an async Express route handler so any rejected promise is forwarded
 * to the error-handling middleware instead of crashing the process.
 *
 * Usage:
 *   router.get('/x', asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
