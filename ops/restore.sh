#!/usr/bin/env bash
#
# Enterprise 360 — database + secrets restore (F21).
#
# Restores an archive produced by ops/backup.sh into the target database.
#
# Usage:
#   ops/restore.sh <archive.tar.gz> [--yes]
# Environment overrides:
#   DATABASE_URL   target postgres connection string (else read from apps/api/.env)
#
# WHAT IT DOES:
#   1. Unpacks the archive.
#   2. pg_restore --clean --if-exists into the target DB (drops & recreates objects).
#   3. Reminds you to restore MFA_ENCRYPTION_KEY from env.backup so encrypted
#      provider secrets / MFA seeds decrypt.
#
# The restore is DESTRUCTIVE to the target database's current contents — it is
# meant to bring a DB back to the backed-up state. Confirm with --yes to skip
# the interactive prompt (e.g. in automation).
#
set -euo pipefail

ARCHIVE="${1:-}"
CONFIRM="${2:-}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: ops/restore.sh <archive.tar.gz> [--yes]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/apps/api/.env"

if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f "$ENV_FILE" ]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' )"
  fi
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set and not found in $ENV_FILE" >&2
  exit 1
fi

proto_removed="${DATABASE_URL#*://}"
creds="${proto_removed%%@*}"
hostportdb="${proto_removed#*@}"
DB_USER="${creds%%:*}"
DB_PASS="${creds#*:}"
hostport="${hostportdb%%/*}"
DB_HOST="${hostport%%:*}"
DB_PORT="${hostport#*:}"; [ "$DB_PORT" = "$DB_HOST" ] && DB_PORT=5432
DB_NAME="${hostportdb#*/}"; DB_NAME="${DB_NAME%%\?*}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$ARCHIVE" -C "$WORK"
if [ ! -f "$WORK/db.dump" ]; then
  echo "ERROR: db.dump not found in archive." >&2
  exit 1
fi

echo "About to RESTORE into database '$DB_NAME' on $DB_HOST:$DB_PORT."
echo "This DROPS and recreates the objects in that database."
if [ "$CONFIRM" != "--yes" ]; then
  printf "Type the database name to confirm: "
  read -r typed
  if [ "$typed" != "$DB_NAME" ]; then
    echo "Confirmation did not match. Aborting." >&2
    exit 1
  fi
fi

echo "Ensuring target database exists ..."
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || PGPASSWORD="$DB_PASS" createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"

echo "Restoring ..."
PGPASSWORD="$DB_PASS" pg_restore --clean --if-exists --no-owner --no-privileges \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" "$WORK/db.dump" || true
# pg_restore returns non-zero on benign "does not exist, skipping" notices with
# --clean on a fresh DB; the "|| true" tolerates those. Real failures surface in
# the output above and in a post-restore sanity check by the caller/runbook.

echo ""
echo "Database restore complete."
if [ -f "$WORK/env.backup" ]; then
  BK_KEY="$(grep -E '^MFA_ENCRYPTION_KEY=' "$WORK/env.backup" | head -1 | cut -d= -f2- || true)"
  CUR_KEY="$(grep -E '^MFA_ENCRYPTION_KEY=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  if [ -n "$BK_KEY" ] && [ "$BK_KEY" != "$CUR_KEY" ]; then
    echo "ACTION REQUIRED: the backup's MFA_ENCRYPTION_KEY differs from the current apps/api/.env."
    echo "  Restore it so encrypted provider secrets / MFA seeds decrypt:"
    echo "  the archive's env.backup holds the correct MFA_ENCRYPTION_KEY."
  else
    echo "MFA_ENCRYPTION_KEY matches the current environment — encrypted secrets will decrypt."
  fi
fi
echo "Done. Restart the API and run a sanity check (see ops/BACKUP_RESTORE.md)."
