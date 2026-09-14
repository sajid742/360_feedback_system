#!/usr/bin/env python3
"""
Turns a .jtl (and its matching -resources.csv) into the numbers a performance report
needs: per-transaction percentiles, throughput, error rate, and the resource envelope
the run was measured under.

    python3 scripts/analyse.py results/load.jtl [...]

Percentiles are computed over TRANSACTION rows only (JMeter writes both a row per
sampler and a row per transaction controller; counting both would double-count and
flatter the numbers).
"""
import csv
import os
import statistics as st
import sys


def pct(sorted_vals, p):
    if not sorted_vals:
        return 0
    k = (len(sorted_vals) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def load(path):
    tx, samplers = [], []
    with open(path, newline='') as f:
        for r in csv.DictReader(f):
            # A transaction-controller row carries this synthetic message; a sampler
            # row does not. That is the only reliable discriminator in a .jtl.
            (tx if 'number of failing' in (r.get('responseMessage') or '') else samplers).append(r)
    return tx, samplers


def summarise(path):
    tx, samplers = load(path)
    if not tx:
        print(f'{path}: no transaction rows'); return
    name = os.path.basename(path).replace('.jtl', '')
    ts = [int(r['timeStamp']) for r in tx]
    wall = (max(ts) - min(ts)) / 1000 or 1
    ok = sum(1 for r in tx if r['success'] == 'true')

    print(f'\n{"="*112}\n{name.upper()}   transactions={len(tx)}  samplers={len(samplers)}  '
          f'wall={wall:.0f}s  throughput={len(tx)/wall:.1f} tx/s  '
          f'errors={len(tx)-ok} ({(len(tx)-ok)*100/len(tx):.2f}%)\n{"="*112}')
    print(f'{"transaction":38} {"n":>6} {"err":>5} {"avg":>7} {"p50":>7} {"p90":>7} {"p95":>7} {"p99":>7} {"max":>8}')
    print('-' * 112)

    by = {}
    for r in tx:
        by.setdefault(r['label'], []).append(r)
    for label in sorted(by):
        rows = by[label]
        vals = sorted(int(r['elapsed']) for r in rows)
        errs = sum(1 for r in rows if r['success'] != 'true')
        print(f'{label:38} {len(rows):6} {errs:5} {st.mean(vals):7.0f} '
              f'{pct(vals,50):7.0f} {pct(vals,90):7.0f} {pct(vals,95):7.0f} {pct(vals,99):7.0f} {max(vals):8}')

    codes = {}
    for r in tx:
        if r['success'] != 'true':
            codes[r['responseCode']] = codes.get(r['responseCode'], 0) + 1
    if codes:
        print('\nfailure codes:', ', '.join(f'{k}x{v}' for k, v in sorted(codes.items(), key=lambda x: -x[1])))

    res = path.replace('.jtl', '-resources.csv')
    if os.path.exists(res):
        with open(res, newline='') as f:
            rr = list(csv.DictReader(f))
        if rr:
            def col(c, fn=max):
                try: return fn(float(x[c]) for x in rr if x.get(c))
                except (ValueError, TypeError): return 0
            print(f'\nresources   api cpu peak {col("api_cpu_pct"):.0f}%  rss peak {col("api_rss_mb"):.0f}MB '
                  f'(start {float(rr[0]["api_rss_mb"]):.0f}MB, end {float(rr[-1]["api_rss_mb"]):.0f}MB)  '
                  f'threads peak {col("api_threads"):.0f}')
            print(f'            pg  cpu peak {col("pg_cpu_pct"):.0f}%  rss peak {col("pg_rss_mb"):.0f}MB  '
                  f'conns peak {col("pg_conns"):.0f}  active peak {col("pg_active"):.0f}  '
                  f'idle-in-txn peak {col("pg_idle_in_txn"):.0f}  lock-waits peak {col("pg_waiting"):.0f}')
            print(f'            redis peak {col("redis_mb"):.1f}MB   load1 peak {col("load1"):.2f} '
                  f'(on {os.cpu_count()} vCPU — >{os.cpu_count()} means the BOX is saturated, '
                  f'which includes the load generator)')


if __name__ == '__main__':
    for p in sys.argv[1:]:
        summarise(p)
