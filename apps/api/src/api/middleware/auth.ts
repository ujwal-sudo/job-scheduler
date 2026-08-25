import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config';
import { UnauthorizedError } from '../../utils/errors';

export interface JwtPayload {
  sub: string; // user id
  email: string;
  name: string;
  type: 'access' | 'refresh';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function signAccessToken(payload: Omit<JwtPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'access' }, config.jwtSecret, {
    expiresIn: config.accessTokenTtl,
  } as jwt.SignOptions);
}

export function signRefreshToken(payload: Omit<JwtPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'refresh' }, config.jwtRefreshSecret, {
    expiresIn: config.refreshTokenTtl,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwtSecret) as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  const payload = jwt.verify(token, config.jwtRefreshSecret) as JwtPayload;
  if (payload.type !== 'refresh') throw new UnauthorizedError('Invalid token type');
  return payload;
}

/** Extract Bearer token and attach decoded payload to req.user. */
export function verifyAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('Missing Authorization header');
    const payload = verifyAccessToken(header.slice(7));
    if (payload.type !== 'access') throw new UnauthorizedError('Invalid token type');
    req.user = payload;
    next();
  } catch (err) {
    next(err instanceof UnauthorizedError ? err : new UnauthorizedError('Invalid or expired token'));
  }
}
