# Enterprise 360 — Performance Test Suite

JMeter test plans, test-data generators and analysis tooling for the Enterprise 360
Feedback System. This is an **additional** test layer: it does not replace or modify
`apps/api/test/*` (the API/e2e suite) or `apps/web/test/*` (the UI smoke test).

The question this suite exists to answer:

> Can the application support ~800 employees and ~8,000 students across multiple
> campuses, including realistic concurrent 360-feedback activity and peak periods?

---

## Layout

```
performance-tests/
  README.md              this file
  build-plans.py         generates jmeter/*.jmx from one definition of the journeys
  config/
    perf.properties      target, concurrency, timeouts — no secrets, no URLs in plans
  data/                  generated CSVs (gitignored; regenerate, never commit)
    users_hr.csv  users_mgr.csv  users_emp.csv
    employees.csv  students.csv  parent-tokens.csv
  jmeter/
    baseline.jmx  load.jmx  peak.jmx  spike.jmx  stress.jmx  endurance.jmx
  scripts/
    run.sh               run one plan with monitoring + analysis
    monitor.sh           1 Hz sampling of API / PostgreSQL / Redis
    analyse.py           .jtl -> per-transaction percentiles, throughput, errors
  results/               .jtl + -resources.csv per run (gitignored)
```

Data generators live with the app because they use its Prisma client and its API:

```
perf/
  seed-perf.mjs          scales a demo-seeded tenant to 800 employees
  gen-roster.mjs         emits the 8,000-student SIS roster CSV
  mint-links.mjs         mints parent evaluation tokens through the real API
```

---

## Prerequisites

- Java 17+ and Apache JMeter 5.6.3 (`JMETER_HOME`, or edit `scripts/run.sh`)
- Python 3.9+ (analysis and plan generation — no third-party packages)
- `psql` on PATH, pointing at the test database
- A **dedicated** performance environment. See Safety.

---

## Safety

Three independent guards, because a performance test writes data and generates enough
load to degrade a live service:

1. **`scripts/run.sh` refuses a non-private host.** Only loopback and RFC1918
   addresses run without `PERF_ALLOW_REMOTE=yes`.
2. **`perf/seed-perf.mjs` refuses a database whose name does not contain `perf`**, and
   requires `PERF_CONFIRM=yes`.
3. **Outbound messaging must be off.** Verify before any run that touches cycle
   activation, reminders or link creation:
   ```sql
   select module, key, value->>'enabled'
   from configurations where module='communication';
   ```
   No rows, or `enabled=false`, means no transport can dial out. `mint-links.mjs`
   always sends `send:false`; bulk generation is run with `notify:false`.

All generated data is synthetic. E-mails use the reserved `.test` TLD (RFC 2606) and
guardian numbers use the unassigned `+99` country code, so neither can reach a real
mailbox or handset.

---

## Building the test data

Order matters — each step depends on the previous one.

```bash
# 0. a throwaway database with the schema applied
createdb e360_perf
psql -d e360_perf -f database/000_initial_schema.sql
psql -d e360_perf -f database/001_reconcile.sql

# 1. the application's own seed chain (permissions, roles, org, demo structure)
npm run -w apps/api db:seed
npm run -w apps/api db:bootstrap-tenant -- --slug care \
  --email perfadmin@carepvtltd.test --password 'PerfTest!2026' --no-starter-content
npm run -w apps/api db:sample
npm run -w apps/api db:demo

# 2. scale employees 50 -> 800
PERF_CONFIRM=yes node perf/seed-perf.mjs 800

# 3. 8,000 students through the application's own import API
node perf/gen-roster.mjs > perf/data/roster.csv
#    POST it to /api/v1/sis-integration/import with entity=roster, confirm=true

# 4. an active cycle at scale, via the application's own bulk generation
#    POST /api/v1/appraisal/bulk/generate  {scopeType:"all", notify:false, ...}
#    POST /api/v1/appraisal/cycles/<id>/activate

# 5. parent tokens, minted through the real endpoint
PERF_CONFIRM=yes node perf/mint-links.mjs 300
```

Steps 3 and 4 deliberately use the **real API** rather than direct inserts: it means
the dataset is built the way a customer builds it, and the build itself is a measured
import/generation test.

---

## Running

```bash
scripts/run.sh baseline            # 5 users,  150s — uncontended reference
scripts/run.sh load                # 50 users, 600s — ordinary working day
scripts/run.sh peak                # 150 users      — cycle opening / deadline day
scripts/run.sh spike               # 20 -> 100 -> 300 -> 600, no ramp
scripts/run.sh stress 300 240 300  # ramp past capacity to find the knee
scripts/run.sh endurance 60 120 3600
```

**Change concurrency** with the second argument, or `users=` in
`config/perf.properties`. It is the *total* virtual users; each journey keeps a fixed
share, so the workload mix is identical at every level.

**Change duration** with the fourth argument (seconds).

Recommended order — never start with stress:

```
health -> baseline -> load -> peak -> spike -> stress -> endurance
```

---

## Workload model

Five journeys, weighted to the population rather than to the number of endpoints.

| # | Journey | Share | Why |
|---|---|---|---|
| A | HR/Admin — dashboards, cycle list, employee search, heatmap, institutional | 6% | ~15 of 800 staff hold `HR/Admin`; they are few but run the most expensive reads |
| B | Manager — my-reviews, my-team, individual, radar, employee-360 | 14% | ~100 managers with a span of ~8 |
| C | Employee — my-reviews, open form, save draft, notifications | 50% | the bulk of 800 employees during a cycle |
| D | Parent — branding, open tokenised link | 25% | 8,000 students; the WhatsApp burst is the largest single arrival |
| E | SIS browse — student search, detail, guardians | 5% | administrative lookup |

**Concurrency assumptions — change these if your usage differs.** 8,800 people are
*not* 8,800 concurrent users:

| Scenario | Concurrent | Derivation |
|---|---|---|
| Normal | 50 | ~5% of 800 staff active at once, plus a trickle of parents |
| Busy | 100 | month-end / mid-cycle |
| Peak | 150 | cycle opening or deadline day: ~25% of staff plus a parent burst |
| Stress | 300+ | beyond any modelled scenario; used to locate the knee |

The parent share deserves the most scrutiny. 8,000 students at ~1.5 guardians is
~12,000 recipients. A single WhatsApp send to all of them, with a 20% open rate in
the first 10 minutes, is ~2,400 sessions in 600 s ≈ **4 opens/second** — well inside
what the spike plan models. If you send in one blast to every guardian and expect a
60% immediate open, re-run `spike` with `-Jusers=900`.

---

## Interpreting results

`scripts/analyse.py` prints per-transaction avg/p50/p90/p95/p99/max, throughput and
error rate, then the resource envelope the run was measured under.

Percentiles are computed over **transaction** rows only. A `.jtl` contains both a row
per HTTP sampler and a row per transaction controller; counting both double-counts.

### Is it the app or the tool?

The single most common way to get a performance test wrong is to measure the load
generator. Before believing any degradation:

| Symptom | Reading |
|---|---|
| `load1` > vCPU count | the **box** is saturated. If JMeter shares it with the app, results past this point are contention, not capacity |
| Failures are `java.net.SocketException` / `Connection reset` with **no** 5xx | **load generator** — client sockets, not server errors |
| HTTP 500/503 with API CPU < 80% | **application or database** |
| `pg_conns` at the pool ceiling, `idle_in_transaction` climbing | **database pool** |
| API RSS growing monotonically across an endurance run | **memory leak** |
| p95 rises but p50 flat | queueing behind a slow minority of requests |

Run JMeter on a **separate machine** from the application for any result you intend
to quote as capacity.

---

## Pass/fail criteria

Targets are per class of operation, because a dashboard aggregating six cycles is not
the same kind of work as fetching a notification list.

| Class | p95 | p99 | Rationale |
|---|---|---|---|
| Interactive reads (`my-reviews`, `notifications`, `cycles`, employee search) | < 500 ms | < 1 s | below the ~1 s threshold where an interface stops feeling responsive |
| Login | < 1 s | < 2 s | bcrypt is deliberately expensive; one per session |
| Evaluation submit / save draft | < 1 s | < 2 s | a write the user waits on, once per form |
| Dashboards & reports (`executive`, `hr`, `heatmap`, `individual`, `radar`) | < 2 s | < 4 s | aggregation over a cycle; users accept a beat |
| Parent link open | < 1 s | < 2 s | first impression, often on mobile data |
| SIS browse | < 1 s | < 2 s | administrative, but currently the worst performer — see the report |
| Bulk generation / SIS import | not latency-bound | — | measure wall time and report progress; see below |

Reliability, all tests:

- HTTP 5xx rate **< 0.1%**; any 5xx is investigated, not averaged away
- No database connection-pool exhaustion (`pg_conns` < 80% of `connection_limit`)
- No container restart, no unhandled rejection in the API log
- No monotonic memory growth across the endurance run (compare first and last decile)

Long-running operations are judged on wall time and on **not blocking**: cycle
activation must return promptly and fan out asynchronously; a bulk generation of the
whole organisation should complete within a maintenance window and report progress.

---

## Parent flow

`D-Parent-Evaluation` opens a tokenised link but does **not** submit by default. A
one-time link can be submitted once; repeated submits would measure 4xx handling, not
the write path. To load-test submission, mint tokens with `oneTime:false`
(`mint-links.mjs` already does) and add the submit step in `build-plans.py`.

Tokens are real tokens minted by `POST /api/v1/external-evaluation`. Nothing about the
token security model is bypassed: no rows are inserted directly and no hashes forged.

---

## Regenerating the plans

```bash
python3 build-plans.py
```

Edit `JOURNEYS` (endpoints, order, correlation, think time) or `PLANS` (thread
schedule) and re-run. The emitted `.jmx` files are ordinary JMeter 5.6 files — they
open in the GUI and run with plain `jmeter -n -t`, with no dependency on the script.
