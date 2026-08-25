import { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';

/**
 * Interpolate `{{event.path.to.field}}` placeholders in a trigger's payload
 * template using the fired event's payload. Non-matching placeholders are
 * left as-is; unknown paths resolve to null.
 */
export function interpolateTemplate(
  template: unknown,
  eventPayload: Record<string, unknown>,
): unknown {
  const lookup = (path: string): unknown =>
    path.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, { event: eventPayload });

  if (typeof template === 'string') {
    // Whole-string single placeholder keeps the original type (numbers etc.)
    const full = template.match(/^\{\{\s*event\.([\w.]+)\s*\}\}$/);
    if (full) return lookup(full[1]) ?? null;
    return template.replace(/\{\{\s*event\.([\w.]+)\s*\}\}/g, (_, path) => String(lookup(path) ?? ''));
  }
  if (Array.isArray(template)) return template.map((t) => interpolateTemplate(t, eventPayload));
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = interpolateTemplate(v, eventPayload);
    }
    return out;
  }
  return template;
}

/**
 * Event flow: STORE → MATCH TRIGGERS → INTERPOLATE → CREATE JOBS → RECORD IDS.
 * Each triggered job is created transactionally together with the event
 * update so a crash can't orphan the mapping.
 */
export async function processEvent(name: string, payload: unknown, source?: string) {
  const event = await prisma.event.create({
    data: { name, payload: payload as Prisma.InputJsonValue, source },
  });

  const triggers = await prisma.eventTrigger.findMany({
    where: { eventName: name, isActive: true },
  });

  const triggeredJobIds: string[] = [];

  for (const trigger of triggers) {
    try {
      const jobPayload = interpolateTemplate(trigger.jobPayloadTmpl, (payload ?? {}) as Record<string, unknown>);
      const job = await prisma.job.create({
        data: {
          queueId: trigger.queueId,
          type: trigger.jobType,
          payload: jobPayload as Prisma.InputJsonValue,
          priority: trigger.jobPriority,
          status: 'PENDING',
        },
      });
      triggeredJobIds.push(job.id);
    } catch (err) {
      logger.error('Event trigger job creation failed', {
        eventId: event.id,
        triggerId: trigger.id,
        message: (err as Error).message,
      });
    }
  }

  const updated = await prisma.event.update({
    where: { id: event.id },
    data: { processedAt: new Date(), triggeredJobIds },
  });

  logger.info('Event processed', { eventId: updated.id, name, triggered: triggeredJobIds.length });
  return { event: updated, triggeredJobIds };
}
