import { config } from '../config';
import { prisma } from '../db/client';
import { logger } from '../utils/logger';

/**
 * AI-generated failure analysis for DLQ entries — powered by OpenRouter.
 *
 * Uses the OpenAI-compatible chat completions endpoint over plain fetch,
 * so no vendor SDK is required. Works with any free-tier model
 * (configurable via OPENROUTER_MODEL, default: llama-3.3-70b-instruct:free).
 *
 * Strictly optional: when OPENROUTER_API_KEY is absent this resolves to null
 * and the platform functions fully without it. Never called on the critical
 * failure path — failJob() already created the DLQ entry before this runs.
 */
export async function generateFailureSummary(jobId: string, error: Error): Promise<string | null> {
  if (!config.openrouterApiKey) return null;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      executions: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        include: { logs: { orderBy: { timestamp: 'asc' }, take: 50 } },
      },
    },
  });
  if (!job) return null;

  const logs = job.executions[0]?.logs ?? [];
  const logText = logs.map((l) => `[${l.level}] ${l.message}`).join('\n') || '(no logs)';

  const prompt =
    `A background job failed permanently and needs analysis.\n\n` +
    `Job Type: ${job.type}\n` +
    `Payload: ${JSON.stringify(job.payload, null, 2).slice(0, 2000)}\n` +
    `Attempts: ${job.attemptCount}/${job.maxAttempts}\n` +
    `Final Error: ${error.message}\n\n` +
    `Execution Logs:\n${logText.slice(0, 3000)}\n\n` +
    `Provide a concise failure summary (2-3 sentences) explaining:\n` +
    `1. What likely caused the failure\n` +
    `2. Whether it's a transient or permanent issue\n` +
    `3. Recommended next action for the operator`;

  const response = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openrouterApiKey}`,
    },
    body: JSON.stringify({
      model: config.openrouterModel,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    logger.warn('OpenRouter request failed', {
      status: response.status,
      body: (await response.text()).slice(0, 300),
    });
    return null;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const summary = data.choices?.[0]?.message?.content?.trim() ?? null;
  if (!summary) return null;

  await prisma.deadLetterQueue.updateMany({
    where: { jobId },
    data: { aiSummary: summary },
  });
  logger.info('AI failure summary stored (openrouter)', { jobId, model: config.openrouterModel });

  return summary;
}
