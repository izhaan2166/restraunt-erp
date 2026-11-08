# syntax=docker/dockerfile:1.7
# Build from the repository root:  docker build -f apps/api/Dockerfile -t restaurant-os-api .

FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @restaurant-os/api...
COPY apps/api apps/api
RUN pnpm --filter @restaurant-os/api exec prisma generate \
 && pnpm --filter @restaurant-os/api build \
 && pnpm --filter @restaurant-os/api deploy --prod --legacy /out \
 && cp -r apps/api/dist apps/api/dist-seed apps/api/prisma /out/ \
 && cd /out && npx prisma@6.19.3 generate --schema prisma/schema.prisma

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Local image storage (STORAGE_DRIVER=local); mount a volume here or use S3 in production.
RUN mkdir -p /app/uploads /app/uploads-private && chown node:node /app/uploads /app/uploads-private
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations run as a separate one-off step (see docker-compose `migrate` service / docs).
CMD ["node", "dist/main.js"]
