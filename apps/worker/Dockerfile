# ── Worker process ────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @js/worker...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared/
COPY apps/worker apps/worker
COPY apps/api/prisma/schema.prisma apps/worker/prisma/schema.prisma
RUN pnpm --filter @js/shared build \
    && pnpm --filter @js/worker exec prisma generate --schema=./prisma/schema.prisma \
    && rm -rf apps/worker/prisma \
    && pnpm --filter @js/worker build

FROM base AS development
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY tsconfig.base.json pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared packages/shared/
COPY apps/api/prisma apps/api/prisma
COPY apps/worker apps/worker
WORKDIR /app/apps/worker
CMD ["pnpm", "dev"]

FROM base AS production
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
WORKDIR /app/apps/worker
CMD ["node", "dist/worker.js"]
