import { Request, Response, NextFunction } from 'express';
import { AnyZodObject } from 'zod';

/**
 * Generic Zod validation middleware.
 * Validates body / query / params against the given schema and returns a
 * 400 with field-level details on failure. Parsed (and coerced) values
 * replace the originals so handlers get typed, clean input.
 */
export function validate(schema: {
  body?: AnyZodObject;
  query?: AnyZodObject;
  params?: AnyZodObject;
}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schema.body) req.body = schema.body.parse(req.body);
      if (schema.query) req.query = schema.query.parse(req.query) as never;
      if (schema.params) req.params = schema.params.parse(req.params) as never;
      next();
    } catch (err) {
      next(err); // ZodError mapped to 400 VALIDATION_ERROR by global handler
    }
  };
}
