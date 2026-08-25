import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/client';
import { register as registerUser, login as loginUser } from '../../services/auth.service';
import { registerSchema, loginSchema, refreshSchema } from '../../validators/auth.validators';
import { verifyAuth, verifyRefreshToken, signAccessToken, signRefreshToken } from '../middleware/auth';
import { UnauthorizedError } from '../../utils/errors';

export const authRouter = Router();

authRouter.post('/register', async (req: Request, res: Response) => {
  const { email, password, name } = registerSchema.parse(req.body);
  const result = await registerUser(email, password, name);
  res.status(201).json({ success: true, data: result });
});

authRouter.post('/login', async (req: Request, res: Response) => {
  const { email, password } = loginSchema.parse(req.body);
  const result = await loginUser(email, password);
  res.json({ success: true, data: result });
});

// Refresh-token rotation: verify old refresh token, issue a fresh pair.
authRouter.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const payload = verifyRefreshToken(refreshToken);
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, email: true, name: true } });
    if (!user) throw new UnauthorizedError('User no longer exists');
    res.json({
      success: true,
      data: {
        accessToken: signAccessToken({ sub: user.id, email: user.email, name: user.name }),
        refreshToken: signRefreshToken({ sub: user.id, email: user.email, name: user.name }),
        user,
      },
    });
  } catch (err) {
    next(err instanceof UnauthorizedError ? err : new UnauthorizedError('Invalid refresh token'));
  }
});

authRouter.get('/me', verifyAuth, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.sub },
    select: { id: true, email: true, name: true, createdAt: true },
  });
  res.json({ success: true, data: user });
});

// Stateless JWT logout — client discards tokens. Provided for API completeness.
authRouter.post('/logout', verifyAuth, (_req: Request, res: Response) => {
  res.json({ success: true, data: { message: 'Logged out' } });
});
