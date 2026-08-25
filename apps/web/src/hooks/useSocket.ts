import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../store/auth';

let socket: Socket | null = null;

export function getSocket(): Socket | null {
  const token = useAuthStore.getState().accessToken;
  if (!token) return null;
  if (!socket) {
    socket = io('/', { auth: { token }, transports: ['websocket', 'polling'] });
  }
  return socket;
}

/**
 * Live-update hook: subscribes to a queue room (or 'workers') and folds
 * server pushes into local state via the reducer.
 */
export function useLive<T>(
  room: { type: 'queue'; id: string } | { type: 'workers' },
  reducer: (state: T, event: { event: string; payload: any }) => T,
): T | undefined {
  const [state, setState] = useState<T | undefined>(undefined);
  const reducerRef = useRef(reducer);
  reducerRef.current = reducer;

  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const roomName = room.type === 'queue' ? `queue:${room.id}` : 'workers';

    s.emit(room.type === 'queue' ? 'subscribe:queue' : 'subscribe:workers', room.type === 'queue' ? room.id : undefined);
    s.on('connect', () => {
      s.emit(room.type === 'queue' ? 'subscribe:queue' : 'subscribe:workers', room.type === 'queue' ? room.id : undefined);
      s.emit('refresh', roomName);
    });

    const handler = (event: string) => (payload: unknown) => {
      setState((prev) => (prev === undefined ? prev : reducerRef.current(prev, { event, payload })));
    };
    const events = ['job:update', 'worker:pulse', 'queue:stats', 'dlq:alert', 'batch:update'];
    events.forEach((e) => s.on(e, handler(e)));

    return () => {
      events.forEach((e) => s.off(e));
      s.emit(room.type === 'queue' ? 'unsubscribe:queue' : 'unsubscribe:workers', room.type === 'queue' ? (room as { id: string }).id : undefined);
    };
  }, [room.type, room.type === 'queue' ? room.id : '']);

  return state;
}
