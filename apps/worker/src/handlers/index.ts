import { createHash, randomUUID } from 'crypto';
import type { JobLogger } from '../jobLogger';
import { logger } from '../logger';

export type { JobLogger };

export interface HandlerContext {
  jobId: string;
  executionId: string;
  attempt: number;
  logger: JobLogger;
  signal: AbortSignal;
}

export type HandlerFn = (payload: unknown, ctx: HandlerContext) => Promise<unknown>;

const registry = new Map<string, HandlerFn>();

/** Register a job handler by type. Extensible — new types plug in here. */
export function registerHandler(type: string, fn: HandlerFn): void {
  registry.set(type, fn);
}

export function getHandler(type: string): HandlerFn | undefined {
  return registry.get(type);
}

export function listHandlers(): string[] {
  return [...registry.keys()];
}

// ── Demo handlers (PRD: email / report / webhook) ────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simulated email send. Fails when payload.forceFail is set (for retry/DLQ demos). */
registerHandler('email', async (payload, ctx) => {
  const p = payload as { to?: string; subject?: string; forceFail?: boolean; failUntilAttempt?: number };
  await ctx.logger.info(`Sending email to ${p.to ?? 'unknown'}`, { subject: p.subject });
  await sleep(200 + Math.random() * 300);
  if (p.forceFail || (p.failUntilAttempt !== undefined && ctx.attempt <= p.failUntilAttempt)) {
    throw new Error(`Simulated email delivery failure (attempt ${ctx.attempt})`);
  }
  await ctx.logger.info('Email delivered');
  return { delivered: true, to: p.to };
});

/** Simulated report generation. */
registerHandler('report', async (payload, ctx) => {
  const p = payload as { name?: string; rows?: number };
  await ctx.logger.info(`Generating report "${p.name ?? 'untitled'}"`);
  const rows = p.rows ?? 1000;
  await sleep(300 + Math.random() * 500);
  const checksum = createHash('sha256').update(`${randomUUID()}`).digest('hex').slice(0, 16);
  await ctx.logger.info(`Report generated with ${rows} rows`, { checksum });
  return { checksum, rows };
});

/** Simulated webhook call. */
registerHandler('webhook', async (payload, ctx) => {
  const p = payload as { url?: string; forceFail?: boolean };
  await ctx.logger.info(`Calling webhook ${p.url ?? 'https://example.com/hook'}`);
  await sleep(150 + Math.random() * 250);
  if (p.forceFail) throw new Error('Webhook endpoint returned 500');
  return { status: 200 };
});

/** Idempotent demo-handler registration (called once at worker boot). */
export function registerHandlers(): void {
  logger.debug('Handlers registered', { types: listHandlers() });
}
