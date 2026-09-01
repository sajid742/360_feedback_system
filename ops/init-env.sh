#!/usr/bin/env bash
#
# Creates the Docker stack's .env from .env.docker.example and fills in the two
# required secrets. Safe to re-run — it never overwrites a secret you have already
# set, so it cannot silently invalidate the key that encrypts your HR and SIS
# provider secrets.
#
#   ./ops/init-env.sh
#   docker compose up -d
#
# --force regenerates both. A new MFA_ENCRYPTION_KEY makes previously encrypted
# provider secrets unreadable; only use it on a database you can re-configure.
#
set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$ROOT/.env.docker.example"
ENVFILE="$ROOT/.env"

[ -f "$TEMPLATE" ] || { echo "Cannot find .env.docker.example in $ROOT"; exit 1; }

if [ ! -f "$ENVFILE" ]; then
  cp "$TEMPLATE" "$ENVFILE"
  echo "Created .env from .env.docker.example"
else
  echo ".env already exists — leaving it in place"
fi

hexkey() { openssl rand -hex 32; }

# Not set = missing, empty, all zeros, or still the change-me placeholder.
needs_value() {
  local v="$1"
  [ "$FORCE" = "1" ] && return 0
  [ -z "$v" ] && return 0
  case "$v" in change-me*) return 0 ;; esac
  [[ "$v" =~ ^0+$ ]] && return 0
  return 1
}

# WAHA_DASHBOARD_PASSWORD is basic auth for WAHA's /dashboard page — NOT the API key.
# Unset, WAHA generates a new random one on every start and prints it only to its log.
changed=()
for name in JWT_ACCESS_SECRET MFA_ENCRYPTION_KEY WAHA_API_KEY WAHA_DASHBOARD_PASSWORD; do
  current="$(sed -n "s/^[[:space:]]*${name}[[:space:]]*=//p" "$ENVFILE" | head -1 | tr -d '[:space:]')"
  if needs_value "$current"; then
    key="$(hexkey)"                       # 64 hex chars — what MFA_ENCRYPTION_KEY requires
    if grep -qE "^[[:space:]]*${name}[[:space:]]*=" "$ENVFILE"; then
      # A temp file keeps this safe on macOS, where sed -i needs an argument.
      sed "s|^[[:space:]]*${name}[[:space:]]*=.*|${name}=${key}|" "$ENVFILE" > "$ENVFILE.tmp"
      mv "$ENVFILE.tmp" "$ENVFILE"
    else
      printf '%s=%s\n' "$name" "$key" >> "$ENVFILE"
    fi
    changed+=("$name")
  fi
done

if [ ${#changed[@]} -gt 0 ]; then
  echo "Generated: ${changed[*]}"
else
  echo "Both secrets are already set — nothing to change"
fi

envvalue() { sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$ENVFILE" | head -1 | tr -d '[:space:]'; }

cat <<EOF

WAHA dashboard login (http://localhost:3001/dashboard):
  user      $(envvalue WAHA_DASHBOARD_USERNAME)
  password  $(envvalue WAHA_DASHBOARD_PASSWORD)
  This is NOT the API key. The API key is what you type into the application at
  Communication > WhatsApp:
  api key   $(envvalue WAHA_API_KEY)
EOF

cat <<'EOF'

Back up MFA_ENCRYPTION_KEY with your database dumps: it also encrypts HR and SIS
provider secrets, which are unrecoverable without it.

Next:  docker compose up -d
Then:  http://localhost:8080   (org care / sajidq@carepvtltd.com / Password123!)
EOF
