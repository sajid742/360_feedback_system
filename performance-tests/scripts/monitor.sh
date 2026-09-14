#!/usr/bin/env bash
# Samples API, PostgreSQL and Redis resource use once a second for the life of a test
# run, writing one CSV. Start it before the JMeter run and stop it after; the CSV
# lines up with the .jtl by wall-clock timestamp.
#
#   scripts/monitor.sh <label> <seconds> [apiPid]
#
# Columns: ts, api_cpu%, api_rss_mb, api_threads, pg_cpu%, pg_rss_mb, pg_conns,
#          pg_active, pg_idle_in_txn, pg_waiting, redis_mb, load1
set -u
LABEL="${1:-run}"; SECONDS_TO_RUN="${2:-300}"; API_PID="${3:-$(cat /tmp/api.pid 2>/dev/null || echo 0)}"
OUT="$(dirname "$0")/../results/${LABEL}-resources.csv"
PSQL=(psql -h "${PGHOST:-127.0.0.1}" -U "${PGUSER:-postgres}" -d "${PGDATABASE:-e360_perf}" -tAc)

echo "ts,api_cpu_pct,api_rss_mb,api_threads,pg_cpu_pct,pg_rss_mb,pg_conns,pg_active,pg_idle_in_txn,pg_waiting,redis_mb,load1" > "$OUT"

# CPU% is computed from /proc deltas rather than `ps`, which reports an average over
# the whole process lifetime and would flatten exactly the spikes we are looking for.
read_jiffies() { awk '{print $14+$15}' "/proc/$1/stat" 2>/dev/null || echo 0; }
total_jiffies() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8}' /proc/stat; }
NCPU=$(nproc)

pg_pid() { pgrep -f "postgres.*-D /home/claude/perf/pgdata" | head -1; }
PGPID=$(pg_pid)

prev_api=$(read_jiffies "$API_PID"); prev_pg=$(read_jiffies "${PGPID:-0}"); prev_tot=$(total_jiffies)

for ((i = 0; i < SECONDS_TO_RUN; i++)); do
  sleep 1
  now_api=$(read_jiffies "$API_PID"); now_pg=$(read_jiffies "${PGPID:-0}"); now_tot=$(total_jiffies)
  dt=$(( now_tot - prev_tot )); [ "$dt" -le 0 ] && dt=1
  api_cpu=$(awk -v a="$((now_api - prev_api))" -v d="$dt" -v n="$NCPU" 'BEGIN{printf "%.1f", a*100*n/d}')
  pg_cpu=$(awk -v a="$((now_pg - prev_pg))" -v d="$dt" -v n="$NCPU" 'BEGIN{printf "%.1f", a*100*n/d}')
  prev_api=$now_api; prev_pg=$now_pg; prev_tot=$now_tot

  api_rss=$(awk '/VmRSS/{printf "%.0f", $2/1024}' "/proc/$API_PID/status" 2>/dev/null || echo 0)
  api_thr=$(awk '/Threads/{print $2}' "/proc/$API_PID/status" 2>/dev/null || echo 0)
  # PostgreSQL is multi-process: sum the RSS of every backend, not just the postmaster.
  pg_rss=$(ps -o rss= -C postgres 2>/dev/null | awk '{s+=$1} END{printf "%.0f", s/1024}')

  stats=$("${PSQL[@]}" "select count(*)||','||count(*) filter (where state='active')||','||count(*) filter (where state='idle in transaction')||','||count(*) filter (where wait_event_type='Lock') from pg_stat_activity where datname='${PGDATABASE:-e360_perf}';" 2>/dev/null || echo "0,0,0,0")
  redis_mb=$(redis-cli info memory 2>/dev/null | awk -F: '/used_memory:/{printf "%.1f", $2/1048576}')
  load1=$(awk '{print $1}' /proc/loadavg)

  echo "$(date +%s),$api_cpu,$api_rss,$api_thr,$pg_cpu,${pg_rss:-0},$stats,${redis_mb:-0},$load1" >> "$OUT"
done
echo "wrote $OUT"
