# Enterprise 360 API — production image (F23). Multi-stage.
# Build context is the REPO ROOT (npm-workspaces monorepo):
#   docker build -f apps/api/Dockerfile -t e360-api .
# syntax=docker/dockerfile:1

# ---- build stage ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
# openssl is required by Prisma's query engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Install deps against the workspace manifests first for better layer caching.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mock-sis/package.json apps/mock-sis/
COPY packages/shared-types/package.json packages/shared-types/
RUN npm ci
# Copy source and build the API (generates the Prisma client, then nest build).
COPY . .
RUN npm --workspace apps/api run db:generate \
    && npm --workspace apps/api run build

# ---- tools stage ----
# The runtime image below deliberately ships only `dist`, so it cannot run the
# first-run seed chain: db:seed, db:seed-roles, db:bootstrap-tenant, db:sample and
# db:demo are ts-node scripts under apps/api/scripts and apps/api/prisma. Without
# this stage a Docker install could not initialise its own database, which is the
# one thing that makes "docker compose up -d" a complete answer.
#
# It carries the full node_modules (with the generated Prisma client), the scripts,
# the SQL, and the mock-sis Prisma schema so its roster can be seeded too. It is a
# one-shot container: it runs, initialises, and exits.
FROM node:20-bookworm-slim AS tools
WORKDIR /app
ENV NODE_ENV=development
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/mock-sis ./apps/mock-sis
COPY --from=build /app/database ./database
COPY --from=build /app/ops ./ops
CMD ["bash", "ops/docker-init.sh"]

# ---- runtime stage ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Hoisted node_modules carries the generated Prisma client.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
# SQL schema/reconcile shipped for first-run DB init (see ops/README).
COPY --from=build /app/database ./database
EXPOSE 3000
WORKDIR /app/apps/api
CMD ["node", "dist/main.js"]
