import winston, { format } from 'winston';

const { combine, timestamp, printf, colorize, errors, json } = format;

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format:
    process.env.NODE_ENV === 'production'
      ? combine(timestamp(), errors({ stack: true }), json())
      : combine(
          colorize(),
          timestamp({ format: 'HH:mm:ss.SSS' }),
          errors({ stack: true }),
          printf(({ level, message, timestamp: ts, stack, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
            return `${ts} [${level}]${stack ? `\n${stack}` : ''} ${message}${metaStr}`;
          }),
        ),
  defaultMeta: { service: 'worker' },
  transports: [new winston.transports.Console()],
});
