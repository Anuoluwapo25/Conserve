#!/usr/bin/env bash
# Runs `conserve deploy`, restarting it whenever the wallet sync stalls.
#
# The wallet SDK stops re-establishing its indexer subscriptions after enough
# reconnects: the process stays alive with no network sockets and no further
# events applied, waiting on a synced state that can never arrive. Because the
# wallet now checkpoints as it syncs, a restart resumes from the last
# checkpoint rather than replaying from genesis -- so retrying across a stall
# makes progress cumulative, and the sync finishes across however many attempts
# it takes.
#
# Detects a stall as "the checkpoint stopped growing", which is the only
# progress signal visible from outside the process.
set -u

cd "$(dirname "${BASH_SOURCE[0]}")/.."

LOG="${DEPLOY_LOG:-deploy-supervised.log}"
STATE=".conserve-state/wallet-preprod.json"
STALL_CHECKS="${STALL_CHECKS:-3}" # consecutive 30s windows without growth
INTERVAL=30

size() { stat -f%z "$STATE" 2>/dev/null || echo 0; }
stamp() { date +%H:%M:%S; }

attempt=0
while true; do
  attempt=$((attempt + 1))
  echo "=== attempt $attempt started $(stamp) (checkpoint $(size) bytes) ===" >>"$LOG"

  node packages/cli/dist/main.js deploy >>"$LOG" 2>&1 &
  pid=$!

  last=$(size)
  stalls=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$INTERVAL"
    if grep -q "^contract:" "$LOG"; then break; fi

    now=$(size)
    if [ "$now" -eq "$last" ]; then
      stalls=$((stalls + 1))
      echo "    [$(stamp)] no growth ($stalls/$STALL_CHECKS) at $now bytes" >>"$LOG"
    else
      [ "$stalls" -gt 0 ] && echo "    [$(stamp)] resumed growing" >>"$LOG"
      stalls=0
    fi
    last=$now

    if [ "$stalls" -ge "$STALL_CHECKS" ]; then
      echo "    [$(stamp)] stalled, restarting from checkpoint" >>"$LOG"
      kill "$pid" 2>/dev/null
      sleep 5
      kill -9 "$pid" 2>/dev/null
      break
    fi
  done

  wait "$pid" 2>/dev/null
  if grep -q "^contract:" "$LOG"; then
    echo "=== deployed on attempt $attempt at $(stamp) ===" >>"$LOG"
    grep -E "^(deployed to|contract:|organizer:)" "$LOG"
    exit 0
  fi

  sleep 5
done
