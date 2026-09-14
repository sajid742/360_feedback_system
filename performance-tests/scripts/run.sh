#!/usr/bin/env bash
#
# Runs one JMeter plan with resource monitoring, then analyses the result.
#
#   scripts/run.sh <plan> [users] [ramp] [duration]
#   scripts/run.sh load 50 60 600
#
# Plans: baseline load peak spike stress endurance
#
# SAFETY. This refuses to run against anything that looks like production. The check
# is deliberately conservative: performance tests write data (draft answers, sessions,
# audit rows) and generate enough load to degrade a live service.
set -euo pipefail
cd "$(dirname "$0")/.."

PLAN="${1:?usage: run.sh <plan> [users] [ramp] [duration]}"
USERS="${2:-}"; RAMP="${3:-}"; DURATION="${4:-}"
JMETER="${JMETER_HOME:-/home/claude/perf/jmeter}/bin/jmeter"
HOST="${PERF_HOST:-127.0.0.1}"; PORT="${PERF_PORT:-3000}"

[ -f "jmeter/${PLAN}.jmx" ] || { echo "no such plan: jmeter/${PLAN}.jmx"; exit 1; }

# ---- production guard ----------------------------------------------------------
case "$HOST" in
  127.0.0.1|localhost|::1|10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) ;;
  *) if [ "${PERF_ALLOW_REMOTE:-no}" != "yes" ]; then
       echo "REFUSING: host '$HOST' is not a loopback or private address."
       echo "Performance tests must never run against production. If '$HOST' really is"
       echo "a dedicated performance environment, re-run with PERF_ALLOW_REMOTE=yes."
       exit 2
     fi ;;
esac
if [ "${PERF_DB_NAME:-}" ] && ! echo "${PERF_DB_NAME}" | grep -qi perf; then
  echo "REFUSING: PERF_DB_NAME='${PERF_DB_NAME}' does not contain 'perf'."; exit 2
fi

# The target must be reachable and must be the API we think it is.
health=$(curl -fsS -m 10 "http://${HOST}:${PORT}/health" || true)
[ -n "$health" ] || { echo "target http://${HOST}:${PORT}/health did not respond"; exit 1; }
echo "target: http://${HOST}:${PORT}  ->  ${health}"

# Outbound messaging must be off, or a load test mails thousands of real people.
echo "reminder: verify Communication providers are disabled/mocked before a run that"
echo "          touches cycle activation, reminders or evaluation-link creation."

mkdir -p results
OVERRIDES=()
[ -n "$USERS" ]    && OVERRIDES+=("-Jusers=$USERS")
[ -n "$RAMP" ]     && OVERRIDES+=("-Jramp=$RAMP")
[ -n "$DURATION" ] && OVERRIDES+=("-Jduration=$DURATION")

# Reset query stats so the run's DB profile is attributable to this run alone.
psql -h "${PGHOST:-127.0.0.1}" -U "${PGUSER:-postgres}" -d "${PGDATABASE:-e360_perf}" \
     -qc "select pg_stat_statements_reset();" >/dev/null 2>&1 || true

MON_SECONDS=$(( ${DURATION:-600} + 60 ))
./scripts/monitor.sh "$PLAN" "$MON_SECONDS" >/dev/null 2>&1 &
MON=$!

export JVM_ARGS="${JVM_ARGS:--Xms1g -Xmx2g}"
"$JMETER" -n -t "jmeter/${PLAN}.jmx" -q config/perf.properties \
  -Jhost="$HOST" -Jport="$PORT" -JdataDir="$PWD/data" "${OVERRIDES[@]}" \
  -l "results/${PLAN}.jtl" -j "results/${PLAN}-jmeter.log" | grep -E '^summary' || true

wait "$MON" 2>/dev/null || true

echo
python3 scripts/analyse.py "results/${PLAN}.jtl"

echo
echo "top database time during this run:"
psql -h "${PGHOST:-127.0.0.1}" -U "${PGUSER:-postgres}" -d "${PGDATABASE:-e360_perf}" -tAc "
  select round(total_exec_time::numeric)||'ms total | '||calls||' calls | '
      || round(mean_exec_time::numeric,2)||'ms mean | '
      || left(regexp_replace(query,'\s+',' ','g'),90)
  from pg_stat_statements where calls > 1
  order by total_exec_time desc limit 5;" 2>/dev/null || echo "  (pg_stat_statements not available)"
