#!/usr/bin/env bash
# Run a heavy local command (browser suite, full unit run, build, compile, benchmark) only when
# the machine has room for it: waits until the 1-minute load average is under a share of the
# cores, then runs the command. Several agents or terminals can all use it; whoever finds the
# machine busy waits. Usage: scripts/when-idle.sh pnpm test:browsers
#   WHEN_IDLE_SHARE  share of the cores that may already be busy (default 1.0: load below the core count)
#   WHEN_IDLE_MAX    seconds to wait before running anyway (default 1800)
set -euo pipefail
[[ $# -gt 0 ]] || { echo "usage: $0 <command> [args...]" >&2; exit 2; }

cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
share="${WHEN_IDLE_SHARE:-1.0}"
max="${WHEN_IDLE_MAX:-1800}"
load() { uptime | sed -E 's/.*load averages?: *([0-9.]+).*/\1/'; }
busy() { awk -v l="$(load)" -v c="$cores" -v s="$share" 'BEGIN { exit !(l > c * s) }'; }

# The load average lags by about a minute, so two callers arriving together would both see an
# idle machine: stagger them, and look again after the stagger.
sleep "$(( (RANDOM % 20) + 1 ))"
waited=0
while busy && (( waited < max )); do
  (( waited % 120 == 0 )) && echo "when-idle: load $(load) on $cores cores, waiting" >&2
  sleep 15
  waited=$(( waited + 15 ))
done
echo "when-idle: load $(load) on $cores cores, starting after ${waited}s: $*" >&2
exec "$@"
