#!/usr/bin/env bash
# Memory monitor for diagnosing integration-test memory pressure.
#
# Samples process state every 5s while running, writes one JSONL record per
# sample to $OUT. Keeps running until Ctrl-C. Safe to run alongside anything.
#
# Usage:
#   scripts/memory-monitor.sh                    # defaults: 5s interval, ./mem-monitor.jsonl
#   INTERVAL=2 OUT=/tmp/mem.jsonl scripts/memory-monitor.sh
#
# After the leak reproduces (or before rebooting), analyze:
#   scripts/memory-monitor.sh --report ./mem-monitor.jsonl
#
# Captures per sample:
#   - timestamp
#   - system: total/avail/used MB, swap used MB, %pressure
#   - top 20 processes by RSS (pid, rss_mb, cmd_short)
#   - counts: node, vitest, stripe, claude, bwrap, pnpm processes
#   - totals: summed RSS of {node,vitest,stripe,claude} process groups
#
# This intentionally does NOT touch the system under test — read-only ps/free.

set -euo pipefail

# --repro: run a single integration test file N times back-to-back, with the
# monitor sampling alongside. Exposes two distinct leak signatures:
#   - Within-process heap growth: vitest RSS climbs over the run
#   - Cross-process residue: node/bwrap counts don't return to baseline between
#     runs, meaning teardown is leaving something behind
# Runs each invocation with singleFork so there is exactly one vitest worker,
# which matches what a well-behaved `run-tasks` shard should look like. If even
# this minimal shape leaks, the leak is in-server (hooks), not orchestration.
#
# Usage:
#   scripts/memory-monitor.sh --repro                   # cart, 10 loops
#   scripts/memory-monitor.sh --repro <file> <loops>
if [[ "${1:-}" == "--repro" ]]; then
  FILE="${2:-src/cart.integration.test.ts}"
  LOOPS="${3:-10}"
  REPRO_OUT="${OUT:-./mem-repro-$(date +%Y%m%d-%H%M%S).jsonl}"
  API_DIR="$(cd "$(dirname "$0")/.." && pwd)/api"

  [[ -f "$API_DIR/$FILE" ]] || { echo "no such test file: $API_DIR/$FILE" >&2; exit 1; }

  echo "repro: $FILE x$LOOPS sequential runs (singleFork each)" >&2
  echo "monitor -> $REPRO_OUT (2s interval)" >&2

  # Export root .env so vitest can see DATABASE_URL, SUPERTOKENS_CONNECTION_URI,
  # etc. Integration tests require these; the nix devshell alone does not
  # load them.
  ROOT_ENV="$(cd "$(dirname "$0")/.." && pwd)/.env"
  if [[ -f "$ROOT_ENV" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ROOT_ENV"
    set +a
    echo "loaded env from $ROOT_ENV" >&2
  else
    echo "warn: no $ROOT_ENV — tests may fail with missing DATABASE_URL" >&2
  fi

  # Start monitor in background. Its SIGTERM handler appends a stop-marker.
  OUT="$REPRO_OUT" INTERVAL=2 "$0" &
  MON_PID=$!

  cleanup_repro() {
    kill -TERM "$MON_PID" 2>/dev/null || true
    wait "$MON_PID" 2>/dev/null || true
  }
  trap cleanup_repro EXIT INT TERM

  # Loop the vitest invocation. Each loop is one full process lifecycle:
  # spawn -> setup -> run tests -> teardown -> exit. If RSS grows across
  # loops (not within a loop), something survives exit — e.g. postgres
  # sockets held open, orphan bwrap, or a shared service (supertokens JVM)
  # that our tests are poisoning. Useful signal either way.
  set +e
  VITEST_RC=0
  for i in $(seq 1 "$LOOPS"); do
    echo "--- repro loop $i/$LOOPS ---" >&2
    (
      cd "$API_DIR"
      pnpm exec vitest run "$FILE" \
        --no-file-parallelism \
        --pool=forks \
        --poolOptions.forks.singleFork=true \
        --reporter=default 2>&1 | tail -5
    )
    rc=$?
    [[ $rc -ne 0 ]] && VITEST_RC=$rc
  done
  set -e

  sleep 3
  cleanup_repro
  trap - EXIT INT TERM

  echo "" >&2
  echo "=== repro complete (last vitest exit=$VITEST_RC) ===" >&2
  echo "" >&2
  "$0" --report "$REPRO_OUT"
  exit "$VITEST_RC"
fi

if [[ "${1:-}" == "--report" ]]; then
  FILE="${2:?usage: --report <jsonl file>}"
  [[ -f "$FILE" ]] || { echo "no such file: $FILE" >&2; exit 1; }

  # Report: first/last/peak system memory, peak per-group RSS, leak signatures.
  python3 - "$FILE" <<'PY'
import json, sys
from collections import defaultdict

path = sys.argv[1]
samples = []
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try: samples.append(json.loads(line))
        except: pass

if not samples:
    print("no samples"); sys.exit(1)

print(f"samples: {len(samples)}  span: {samples[0]['ts']} -> {samples[-1]['ts']}")
print()

# System memory trajectory
print("system memory (MB):")
print(f"  {'time':<20} {'used':>8} {'avail':>8} {'swap':>8}  %used")
for s in (samples[0], samples[len(samples)//2], samples[-1]):
    sys_ = s['sys']
    pct = 100 * sys_['used_mb'] / sys_['total_mb']
    print(f"  {s['ts']:<20} {sys_['used_mb']:>8} {sys_['avail_mb']:>8} {sys_['swap_used_mb']:>8}  {pct:5.1f}%")

peak = max(samples, key=lambda s: s['sys']['used_mb'])
peak_pct = 100 * peak['sys']['used_mb'] / peak['sys']['total_mb']
print(f"  PEAK at {peak['ts']}: used={peak['sys']['used_mb']}MB ({peak_pct:.1f}%), swap={peak['sys']['swap_used_mb']}MB")
print()

# Per-group totals over time
print("process group RSS over time (MB):")
hdr = f"  {'time':<20} {'node':>6} {'vitest':>7} {'stripe':>7} {'claude':>7} {'bwrap':>6} {'pg':>6} {'java':>6}"
print(hdr)
# Show more points — trend matters more than just start/mid/end when diagnosing drift.
step = max(1, len(samples) // 6)
for s in samples[::step] + [samples[-1]]:
    g = s['groups']
    print(f"  {s['ts']:<20} {g.get('node_rss_mb',0):>6} {g.get('vitest_rss_mb',0):>7} {g.get('stripe_rss_mb',0):>7} {g.get('claude_rss_mb',0):>7} {g.get('bwrap_rss_mb',0):>6} {g.get('pg_rss_mb',0):>6} {g.get('java_rss_mb',0):>6}")
print()

# Process counts
print("process counts over time:")
print(hdr)
for s in samples[::step] + [samples[-1]]:
    c = s['counts']
    print(f"  {s['ts']:<20} {c.get('node',0):>6} {c.get('vitest',0):>7} {c.get('stripe',0):>7} {c.get('claude',0):>7} {c.get('bwrap',0):>6} {c.get('pg',0):>6} {c.get('java',0):>6}")
print()

# Leak signatures
print("=" * 60)
print("LEAK SIGNATURES")
print("=" * 60)

# Signature 1: Baseline explosion (many workers, each steady)
peak_node_count = max(s['counts'].get('node', 0) for s in samples)
peak_node_rss = max(s['groups'].get('node_rss_mb', 0) for s in samples)
avg_rss_per_node = peak_node_rss / peak_node_count if peak_node_count else 0
print(f"  peak node process count : {peak_node_count}")
print(f"  peak summed node RSS    : {peak_node_rss} MB")
print(f"  avg RSS per node at peak: {avg_rss_per_node:.0f} MB")
if peak_node_count > 12:
    print(f"  -> SIGNATURE A (worker explosion): {peak_node_count} node procs")
    print(f"     Fix: cap vitest maxForks + cap parallel_runner max_parallel")

# Signature 2: Unbounded growth in a stable process set
# Look at the top-RSS node process across samples and see if it climbs
max_single_rss = defaultdict(int)
for s in samples:
    for p in s['top']:
        if 'node' in p['cmd']:
            max_single_rss[p['pid']] = max(max_single_rss[p['pid']], p['rss_mb'])
climbing = [(pid, rss) for pid, rss in max_single_rss.items() if rss > 800]
if climbing:
    print(f"  -> SIGNATURE B (heap leak): {len(climbing)} node procs exceeded 800MB")
    for pid, rss in sorted(climbing, key=lambda x: -x[1])[:5]:
        print(f"     pid {pid}: peak RSS {rss} MB")
    print(f"     Fix: shutdown-hook audit (per-worker leak)")

# Signature 3: Orphan sidecars accumulating
stripe_counts = [s['counts'].get('stripe', 0) for s in samples]
if max(stripe_counts) > 1 or (len(stripe_counts) > 1 and stripe_counts[-1] > stripe_counts[0]):
    print(f"  -> SIGNATURE C (orphan sidecars): stripe count {stripe_counts[0]} -> {stripe_counts[-1]} (peak {max(stripe_counts)})")
    print(f"     Fix: unconditional cleanup in parallel_runner finally block")

# Post-run residue: if final counts >> initial counts after monitor end
first_node = samples[0]['counts'].get('node', 0)
last_node = samples[-1]['counts'].get('node', 0)
if last_node > first_node + 2:
    print(f"  -> POST-RUN RESIDUE: node count {first_node} -> {last_node}")
    print(f"     Some process tree was not reaped on agent exit")

# Signature D: Cross-run baseline drift (useful mostly for --repro mode, where
# vitest comes and goes repeatedly). Look at samples where vitest_count == 0
# and find the MIN used-memory in that subset across the whole run. If that
# minimum climbs over time, test invocations are leaving state behind
# (orphan procs, held sockets, shared-service bloat).
idle_samples = [s for s in samples if s['counts'].get('vitest', 0) == 0]
if len(idle_samples) >= 3:
    idle_first = idle_samples[0]
    idle_last = idle_samples[-1]
    drift_mb = idle_last['sys']['used_mb'] - idle_first['sys']['used_mb']
    print(f"  idle-state system RSS: {idle_first['sys']['used_mb']} MB -> {idle_last['sys']['used_mb']} MB (drift {drift_mb:+d} MB)")
    if drift_mb > 200:
        print(f"  -> SIGNATURE D (cross-run residue): baseline drifted {drift_mb}MB upward")
        print(f"     Each vitest run is leaving ~{drift_mb // max(1, len(idle_samples)-1)}MB behind")
        print(f"     Candidates: orphan bwrap/node, postgres page cache, supertokens JVM growth")
PY
  exit 0
fi

INTERVAL="${INTERVAL:-5}"
OUT="${OUT:-./mem-monitor.jsonl}"

echo "memory-monitor: writing to $OUT every ${INTERVAL}s. Ctrl-C to stop." >&2
echo "  analyze with: $0 --report $OUT" >&2

# Header line for humans
echo "# started $(date -Iseconds)  interval=${INTERVAL}s" >> "$OUT"

sample() {
  local ts mem_total mem_avail mem_used swap_used
  ts="$(date -Iseconds)"

  # free -m: lines are "Mem:" and "Swap:"; cols: total used free shared buff/cache available
  read -r mem_total mem_used _ _ _ mem_avail < <(free -m | awk '/^Mem:/ {print $2, $3, $4, $5, $6, $7}')
  read -r _ swap_used _ < <(free -m | awk '/^Swap:/ {print $2, $3, $4}')

  # Top 20 processes by RSS (kB -> MB)
  # Columns: pid rss(kB) comm args
  local top_json
  top_json="$(ps -eo pid,rss,comm,args --sort=-rss --no-headers 2>/dev/null | head -20 | awk '
    BEGIN { printf "[" }
    {
      pid=$1; rss=int($2/1024); comm=$3;
      # rebuild rest as cmdline, truncate
      cmd=""; for (i=4; i<=NF; i++) cmd=cmd " " $i;
      gsub(/"/, "\\\"", cmd); gsub(/\\/, "\\\\", cmd);
      if (length(cmd) > 120) cmd=substr(cmd, 1, 120);
      if (NR>1) printf ",";
      printf "{\"pid\":%s,\"rss_mb\":%d,\"cmd\":\"%s\"}", pid, rss, comm cmd
    }
    END { print "]" }
  ')"

  # Per-group counts + summed RSS
  # groups: node (not vitest), vitest, stripe, claude, pnpm, bwrap
  local groups_json
  # Classify by comm (process name) primarily. comm is the basename of the
  # binary, so it is precise — avoids false positives from substring matches
  # against cmdline args (e.g. scripts that mention "stripe" or "pnpm").
  groups_json="$(ps -eo rss,comm,args --no-headers 2>/dev/null | awk '
    {
      rss=int($1/1024); comm=$2; cmdline=""
      for (i=3; i<=NF; i++) cmdline=cmdline " " $i

      # node processes: comm is literally "node". Classify further by cmdline.
      if (comm == "node") {
        if (cmdline ~ /vitest/) { vitest_c++; vitest_r += rss }
        else                    { node_c++;   node_r   += rss }
      }
      # stripe CLI listener
      else if (comm == "stripe") { stripe_c++; stripe_r += rss }
      # Claude Code CLI: comm is "claude"
      else if (comm == "claude") { claude_c++; claude_r += rss }
      # pnpm is a node script, comm is "node"; we only count it if the node
      # branch sees " pnpm" in argv[1..]. Simpler: skip pnpm class here — any
      # pnpm invocation will show as "node" anyway, captured above.
      else if (comm == "bwrap") { bwrap_c++; bwrap_r += rss }
      # postgres backend processes (the main postmaster + per-connection
      # workers). Classify by comm so we do NOT double-count the entire
      # cluster — each process is one entry. Covers "postgres" (main) and
      # "postmaster" on some distros.
      else if (comm == "postgres" || comm == "postmaster") { pg_c++; pg_r += rss }
      # SuperTokens is a Java process — comm is "java"
      else if (comm == "java") { java_c++; java_r += rss }
    }
    END {
      printf "{\"node\":%d,\"vitest\":%d,\"stripe\":%d,\"claude\":%d,\"bwrap\":%d,\"pg\":%d,\"java\":%d,",
        node_c+0, vitest_c+0, stripe_c+0, claude_c+0, bwrap_c+0, pg_c+0, java_c+0
      printf "\"node_rss_mb\":%d,\"vitest_rss_mb\":%d,\"stripe_rss_mb\":%d,\"claude_rss_mb\":%d,\"bwrap_rss_mb\":%d,\"pg_rss_mb\":%d,\"java_rss_mb\":%d}",
        node_r+0, vitest_r+0, stripe_r+0, claude_r+0, bwrap_r+0, pg_r+0, java_r+0
    }
  ')"

  # Split the combined groups_json into counts vs rss_mb
  # Easier: emit them as two keys derived from the same awk blob
  local counts rss_totals
  counts="$(echo "$groups_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({k:v for k,v in d.items() if not k.endswith("_rss_mb")}))')"
  rss_totals="$(echo "$groups_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({k:v for k,v in d.items() if k.endswith("_rss_mb")}))')"

  printf '{"ts":"%s","sys":{"total_mb":%s,"used_mb":%s,"avail_mb":%s,"swap_used_mb":%s},"counts":%s,"groups":%s,"top":%s}\n' \
    "$ts" "$mem_total" "$mem_used" "$mem_avail" "$swap_used" \
    "$counts" "$rss_totals" "$top_json" >> "$OUT"
}

trap 'echo "# stopped $(date -Iseconds)" >> "$OUT"; echo "memory-monitor: stopped. report: $0 --report $OUT" >&2; exit 0' INT TERM

while true; do
  sample
  sleep "$INTERVAL"
done
