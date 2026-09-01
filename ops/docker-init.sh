#!/usr/bin/env bash
#
# First-run initialisation for the Docker stack — and a safe no-op on every run after.
#
# This is what makes `docker compose up -d` a complete answer rather than a half one.
# It runs in the API image's `tools` stage (which unlike the runtime image still has
# node_modules, the seed scripts and the SQL), completes, and exits. The `api` service
# waits for it via `service_completed_successfully`.
#
# EVERY STEP IS IDEMPOTENT, and that is deliberate rather than incidental:
#   - the two SQL files use CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
#   - db:seed and db:seed-roles upsert
#   - db:bootstrap-tenant detects an existing org and only refreshes system roles
#   - db:sample checks for its "CARE Head Office" marker department
#   - db:demo checks for its "Mid-Year Review 2027" marker cycle
#   - the mock-sis seed checks for an existing campus
# So this script can run on every container start without ever destroying or
# re-seeding data. There is no separate "first time only" command to remember.
#
set -euo pipefail

say() { printf '\n\033[1;35m▸ %s\033[0m\n' "$1"; }
ok()  { printf '  \033[0;32m✓\033[0m %s\n' "$1"; }

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_USER:=postgres}"
: "${POSTGRES_PASSWORD:=postgres}"
: "${POSTGRES_DB:=enterprise360}"
: "${MOCK_SIS_DB:=mock_sis}"
: "${ORG_NAME:=CARE Pvt. Ltd.}"
: "${ORG_SLUG:=care}"
: "${ADMIN_EMAIL:=sajidq@carepvtltd.com}"
: "${ADMIN_PASSWORD:=Password123!}"
: "${SEED_DEMO_DATA:=true}"

export PGPASSWORD="$POSTGRES_PASSWORD"
PSQL=(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -v ON_ERROR_STOP=1 -q)

say "Waiting for PostgreSQL at ${POSTGRES_HOST}:${POSTGRES_PORT}"
for i in $(seq 1 60); do
  if pg_isready -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" >/dev/null 2>&1; then
    ok "PostgreSQL is accepting connections"
    break
  fi
  [ "$i" = "60" ] && { echo "PostgreSQL did not become ready in 60s"; exit 1; }
  sleep 1
done

# The postgres image creates POSTGRES_DB only. Mock SIS keeps its own database, on
# purpose: it is a stand-in for a third-party vendor system and must not share tables
# with the 360 schema.
say "Databases"
for db in "$POSTGRES_DB" "$MOCK_SIS_DB"; do
  if [ -z "$("${PSQL[@]}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'")" ]; then
    "${PSQL[@]}" -d postgres -c "CREATE DATABASE \"${db}\"" >/dev/null
    ok "created ${db}"
  else
    ok "${db} already exists"
  fi
done

export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
export MOCK_SIS_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${MOCK_SIS_DB}"

# Hand-maintained SQL, never Prisma Migrate: 000 creates a fresh schema, 001 is the
# idempotent reconcile that also stamps schema_migrations. The API's readiness probe
# compares the newest stamped version against EXPECTED_SCHEMA_VERSION, so applying
# 001 on every start is what keeps that check honest after an upgrade.
say "Schema"
"${PSQL[@]}" -d "$POSTGRES_DB" -f /app/database/000_initial_schema.sql >/dev/null 2>&1 || true
"${PSQL[@]}" -d "$POSTGRES_DB" -f /app/database/001_reconcile.sql >/dev/null
ok "applied 000_initial_schema.sql + 001_reconcile.sql"
ok "schema version: $("${PSQL[@]}" -d "$POSTGRES_DB" -tAc 'SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1')"

cd /app

say "Permission catalogue and system roles"
npm run db:seed --silent
npm run db:seed-roles --silent
ok "permissions and the five system roles are current"

# NOTE the `-w apps/api`. The ROOT db:bootstrap-tenant script is itself an `npm run`,
# and that second npm hop swallows everything after `--` as npm configuration — which
# silently creates the administrator with the DEFAULT password and makes every login
# fail. Calling the workspace script directly is the fix, and it must stay that way.
# ---------------------------------------------------------------------------
# NEW CLIENT MODE — runs INSTEAD of the demo path below, never alongside it.
#
# Turns this installation into a clean starting point for a new customer: the
# previous client's / demo data is removed and a fresh organisation is created with
# generic starter content (rating scale, 10 competencies, 3 questionnaires, default
# report settings). It sits here, after permissions and system roles exist and
# BEFORE any tenant or demo seeding, so nothing is seeded only to be deleted again.
#
# It never runs on a normal start. The only way to reach it:
#   docker compose run --rm -e NEW_CLIENT=true \
#     -e ORG_NAME="New Client Ltd" -e ORG_SLUG=newclient \
#     -e ADMIN_EMAIL=admin@newclient.com -e ADMIN_PASSWORD='StrongPass!' db-init
# Add -e NEW_CLIENT_DRY_RUN=true to preview without changing anything.
# ---------------------------------------------------------------------------
if [ "${NEW_CLIENT:-false}" = "true" ]; then
  say "NEW_CLIENT=true — preparing this database for a new customer"
  printf '  \033[0;33mThis removes the existing client/demo data. Take a backup first.\033[0m\n'
  if [ "${NEW_CLIENT_DRY_RUN:-false}" = "true" ]; then
    MODE=--dry-run
  else
    MODE=--force
  fi
  npm run -w apps/api db:new-client -- "$MODE" \
    --org "$ORG_NAME" --slug "$ORG_SLUG" \
    --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD"
  exit 0
fi

say "Tenant and administrator"
npm run -w apps/api db:bootstrap-tenant -- \
  --no-starter-content \
  --org "$ORG_NAME" \
  --slug "$ORG_SLUG" \
  --email "$ADMIN_EMAIL" \
  --password "$ADMIN_PASSWORD"

if [ "$SEED_DEMO_DATA" = "true" ]; then
  say "Demo data (SEED_DEMO_DATA=true)"
  npm run db:sample --silent
  # DEMO_RESEED=true regenerates demo content from the CURRENT code.
  #
  # This matters because db:demo stops the moment its marker cycle exists — which is
  # what makes restarting a stack safe, and also what makes a volume seeded by an
  # older build keep that older data for ever. Rebuilding the image does not help:
  # the guard fires before any seeding runs. A normal start never sets this, so the
  # only way to reach it is to ask:
  #     docker compose run --rm -e DEMO_RESEED=true db-init
  if [ "${DEMO_RESEED:-false}" = "true" ]; then
    say "DEMO_RESEED=true — regenerating demo content from the current code"
    npm run -w apps/api db:demo -- --force
  else
    npm run db:demo --silent
  fi
else
  say "Demo data skipped (SEED_DEMO_DATA=${SEED_DEMO_DATA})"
  ok "the tenant has its administrator, permissions and roles, and nothing else"
fi

say "Mock SIS roster"
npm run -w apps/mock-sis db:push --silent -- --skip-generate --accept-data-loss >/dev/null
npm run -w apps/mock-sis db:seed --silent
ok "mock-sis schema and roster ready"

say "Initialisation complete"
printf '  Sign in at the web URL with organisation \033[1m%s\033[0m / %s\n\n' "$ORG_SLUG" "$ADMIN_EMAIL"
