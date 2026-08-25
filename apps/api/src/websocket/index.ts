import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../utils/logger';
import { setIo } from './emitter';

/**
 * Socket.io setup.
 *
 * Connections are JWT-authenticated during the handshake; clients then join
 * rooms: `queue:<id>` for per-queue streams and `workers` for the fleet view.
 * Emits (see emitter.ts): job:update, worker:pulse, queue:stats, dlq:alert.
 */
export function setupWebSocket(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, methods: ['GET', 'POST'] },
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token ?? socket.handshake.query?.token;
      if (!token || typeof token !== 'string') return next(new Error('Authentication required'));
      const payload = jwt.verify(token, config.jwtSecret) as { sub?: string };
      if (!payload.sub) return next(new Error('Invalid token'));
      socket.data.userId = payload.sub;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    logger.debug('WS client connected', { userId: socket.data.userId });

    socket.on('subscribe:queue', (queueId: string) => {
      if (typeof queueId === 'string' && queueId.length < 64) socket.join(`queue:${queueId}`);
    });
    socket.on('unsubscribe:queue', (queueId: string) => socket.leave(`queue:${queueId}`));
    socket.on('subscribe:workers', () => socket.join('workers'));
    socket.on('disconnecting', () => logger.debug('WS client disconnected'));
  });

  setIo(io);
  logger.info('WebSocket server ready');
  return io;
}
