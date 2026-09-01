# Enterprise 360 Web (SPA) — production image (F23). Multi-stage: build with Node,
# serve static assets with nginx. Build from the REPO ROOT:
#   docker build -f apps/web/Dockerfile -t e360-web .
# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mock-sis/package.json apps/mock-sis/
COPY packages/shared-types/package.json packages/shared-types/
RUN npm ci
COPY . .
# VITE_* values are substituted at BUILD time, so anything that must vary per
# deployment has to arrive as a build argument.
#
# VITE_API_BASE_URL is deliberately NOT one of them: it stays relative (/api/v1) and
# nginx proxies it to the api service. That is what makes the same image work on
# http://localhost:8080 and on http://<lan-ip>:8080 without a rebuild — the browser
# calls whatever origin served the page.
ARG VITE_DEFAULT_ORG_SLUG=care
ENV VITE_DEFAULT_ORG_SLUG=$VITE_DEFAULT_ORG_SLUG
RUN npm --workspace apps/web run build

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
