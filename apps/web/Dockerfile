# syntax=docker/dockerfile:1.7
# Build from the repository root:  docker build -f apps/web/Dockerfile -t restaurant-os-web .
#
# API_ORIGIN is where this app's server forwards /api, /realtime and /uploads. It is fixed at build
# time. In the production stack Caddy sends those paths straight to the API, so this only matters
# when the web container is reached directly.

FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @restaurant-os/web...
COPY apps/web apps/web
ARG API_ORIGIN=http://api:4000
ENV API_ORIGIN=$API_ORIGIN
RUN pnpm --filter @restaurant-os/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# Next's standalone output: a minimal server plus only the node_modules it traced.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
