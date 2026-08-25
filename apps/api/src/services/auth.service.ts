import bcrypt from 'bcryptjs';
import { prisma } from '../db/client';
import { signAccessToken, signRefreshToken } from '../api/middleware/auth';
import { UnauthorizedError, ConflictError } from '../utils/errors';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; name: string };
}

export async function register(email: string, password: string, name: string): Promise<AuthResult> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ConflictError('A user with this email already exists');

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { email, passwordHash, name } });
  return issueTokens(user.id, user.email, user.name);
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new UnauthorizedError('Invalid email or password');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new UnauthorizedError('Invalid email or password');

  return issueTokens(user.id, user.email, user.name);
}

export function issueTokens(id: string, email: string, name: string): AuthResult {
  return {
    accessToken: signAccessToken({ sub: id, email, name }),
    refreshToken: signRefreshToken({ sub: id, email, name }),
    user: { id, email, name },
  };
}
