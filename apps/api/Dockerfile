# ── API server ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @js/api...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared/
COPY apps/api apps/api
RUN pnpm --filter @js/shared build \
    && pnpm --filter @js/api db:generate \
    && pnpm --filter @js/api build

FROM base AS development
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY tsconfig.base.json pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared packages/shared/
COPY apps/api apps/api
WORKDIR /app/apps/api
CMD ["pnpm", "dev"]

FROM base AS production
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
WORKDIR /app/apps/api
EXPOSE 4000
# Run migrations then start the API
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/index.js"]
