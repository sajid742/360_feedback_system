# Enterprise 360 Mock SIS — production image (F23). Multi-stage.
# Build from the REPO ROOT:  docker build -f apps/mock-sis/Dockerfile -t e360-mock-sis .
# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mock-sis/package.json apps/mock-sis/
COPY packages/shared-types/package.json packages/shared-types/
RUN npm ci
COPY . .
RUN npm --workspace apps/mock-sis run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/mock-sis/dist ./apps/mock-sis/dist
COPY --from=build /app/apps/mock-sis/package.json ./apps/mock-sis/package.json
# Mock SIS generates its Prisma client to apps/mock-sis/generated/client (a private
# output path, so it never collides with the API's client in the hoisted
# node_modules) and imports it as '../generated/client'. Without this the runtime
# image starts and immediately dies with MODULE_NOT_FOUND on prisma.service.js.
COPY --from=build /app/apps/mock-sis/generated ./apps/mock-sis/generated
# The Prisma schema is read at runtime by the query engine.
COPY --from=build /app/apps/mock-sis/prisma ./apps/mock-sis/prisma
EXPOSE 3100
WORKDIR /app/apps/mock-sis
CMD ["node", "dist/main.js"]
