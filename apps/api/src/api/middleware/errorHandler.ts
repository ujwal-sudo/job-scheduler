import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${_req.method} ${_req.path} not found` },
  });
}

/** Global error handler — maps errors to the standard error envelope. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      },
    });
    return;
  }

  // Prisma known errors → friendly responses
  const anyErr = err as { code?: string; meta?: { target?: string[] }; message?: string };
  if (anyErr?.code === 'P2002') {
    const target = anyErr.meta?.target?.join(', ') ?? 'field';
    res.status(409).json({
      success: false,
      error: { code: 'CONFLICT', message: `Unique constraint violation on ${target}` },
    });
    return;
  }
  if (anyErr?.code === 'P2025') {
    res
      .status(404)
      .json({ success: false, error: { code: 'NOT_FOUND', message: 'Record not found' } });
    return;
  }

  logger.error('Unhandled error', {
    path: req.path,
    method: req.method,
    message: (err as Error)?.message,
    stack: (err as Error)?.stack,
  });

  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
  });
}
