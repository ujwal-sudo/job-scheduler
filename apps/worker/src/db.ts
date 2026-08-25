import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __workerPrisma: PrismaClient | undefined;
}

export const prisma =
  global.__workerPrisma ??
  new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });

if (process.env.NODE_ENV !== 'production') global.__workerPrisma = prisma;

export async function connectDb(): Promise<void> {
  await prisma.$connect();
}
