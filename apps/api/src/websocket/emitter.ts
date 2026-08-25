import type { Server } from 'socket.io';
import { JobStatus } from '@prisma/client';

// Global io reference — set once by setupWebSocket(). Services import these
// emitters so every state change fans out to subscribed dashboard clients.
let io: Server | null = null;

export function setIo(server: Server): void {
  io = server;
}

export function getIo(): Server | null {
  return io;
}

function emitSafe(room: string, event: string, payload: unknown): void {
  try {
    io?.to(room).emit(event, payload);
  } catch {
    // socket emission must never break business logic
  }
}

export function emitJobUpdate(queueId: string, jobId: string, status: JobStatus | string): void {
  emitSafe(`queue:${queueId}`, 'job:update', { queueId, jobId, status, at: new Date().toISOString() });
}

export function emitWorkerPulse(worker: {
  id: string;
  queueId: string | null;
  status: string;
  jobsRunning?: number;
  memoryMb?: number | null;
}): void {
  emitSafe('workers', 'worker:pulse', { ...worker, at: new Date().toISOString() });
}

export function emitQueueStats(queueId: string, stats: Record<string, unknown>): void {
  emitSafe(`queue:${queueId}`, 'queue:stats', { queueId, ...stats });
}

export function emitDlqAlert(queueId: string, jobId: string): void {
  emitSafe(`queue:${queueId}`, 'dlq:alert', { queueId, jobId, at: new Date().toISOString() });
}

export function emitBatchUpdate(queueId: string, batchId: string): void {
  emitSafe(`queue:${queueId}`, 'batch:update', { queueId, batchId, at: new Date().toISOString() });
}
