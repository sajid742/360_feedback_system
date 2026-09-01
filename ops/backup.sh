#!/usr/bin/env bash
#
# Enterprise 360 — database + secrets backup (F21).
#
# Produces a single timestamped, self-contained archive containing:
#   - db.dump        : pg_dump custom-format dump of the application database
#   - env.backup     : a copy of apps/api/.env  (CONTAINS MFA_ENCRYPTION_KEY)
#   - MANIFEST.txt   : what/when/versions, for the restore runbook
#
# IMPORTANT: MFA_ENCRYPTION_KEY (in apps/api/.env) encrypts stored provider
# secrets (HR/SIS connections) and MFA seeds. A database restored WITHOUT the
# matching key cannot decrypt those secrets. That is why the key is backed up
# alongside the data — keep this archive somewhere secure.
#
# Usage:
#   ops/backup.sh [BACKUP_DIR]
# Environment overrides:
#   DATABASE_URL     postgres connection string (else read from apps/api/.env)
#   BACKUP_DIR       output directory (default: ./backups)
#   RETENTION_DAYS   prune archives older than N days (default: 14; 0 = keep all)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/apps/api/.env"
BACKUP_DIR="${1:-${BACKUP_DIR:-$ROOT_DIR/backups}}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

# --- resolve DATABASE_URL -----------------------------------------------------
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f "$ENV_FILE" ]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' )"
  fi
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set and not found in $ENV_FILE" >&2
  exit 1
fi

# --- parse the URL (postgresql://user:pass@host:port/db) -----------------------
proto_removed="${DATABASE_URL#*://}"
creds="${proto_removed%%@*}"
hostportdb="${proto_removed#*@}"
DB_USER="${creds%%:*}"
DB_PASS="${creds#*:}"
hostport="${hostportdb%%/*}"
DB_HOST="${hostport%%:*}"
DB_PORT="${hostport#*:}"; [ "$DB_PORT" = "$DB_HOST" ] && DB_PORT=5432
DB_NAME="${hostportdb#*/}"; DB_NAME="${DB_NAME%%\?*}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$BACKUP_DIR"

echo "Backing up database '$DB_NAME' on $DB_HOST:$DB_PORT ..."
PGPASSWORD="$DB_PASS" pg_dump -Fc -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$WORK/db.dump"

if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$WORK/env.backup"
  echo "Included apps/api/.env (contains MFA_ENCRYPTION_KEY)."
else
  echo "WARNING: $ENV_FILE not found — MFA_ENCRYPTION_KEY is NOT in this backup." >&2
fi

{
  echo "Enterprise 360 backup"
  echo "created_utc = ${STAMP}"
  echo "database    = ${DB_NAME}"
  echo "host        = ${DB_HOST}:${DB_PORT}"
  echo "pg_dump     = $(pg_dump --version | head -1)"
  echo "format      = custom (pg_restore)"
  echo "includes    = db.dump, env.backup(MFA_ENCRYPTION_KEY), MANIFEST.txt"
} > "$WORK/MANIFEST.txt"

ARCHIVE="$BACKUP_DIR/e360-backup-${STAMP}.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK" .
echo "Backup written: $ARCHIVE"
echo "Size: $(du -h "$ARCHIVE" | cut -f1)"

# --- retention ----------------------------------------------------------------
if [ "$RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  find "$BACKUP_DIR" -name 'e360-backup-*.tar.gz' -type f -mtime "+$RETENTION_DAYS" -print -delete \
    | sed 's/^/Pruned old backup: /' || true
fi

echo "Done."
