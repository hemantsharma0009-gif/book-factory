#!/usr/bin/env bash
#
# The command cron runs. Safe to fire every hour: it exits quietly unless a run
# is actually due and within the configured guards.
#
#   0 * * * * /path/to/engine/scripts/run-scheduled.sh
#
# Does four things cron does not do for you:
#   - loads the API key from engine/.env (cron has almost no environment)
#   - takes a lock, so a slow run can never overlap the next tick
#   - gates on `should-run`, which enforces the backlog and budget caps
#   - appends to a log you can actually read afterwards

set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${BOOK_FACTORY_LOG_DIR:-$ENGINE_DIR/logs}"
LOG_FILE="$LOG_DIR/scheduled.log"
LOCK_FILE="${TMPDIR:-/tmp}/book-factory-scheduled.lock"

mkdir -p "$LOG_DIR"
say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"; }

# cron runs with a near-empty environment, so the key comes from a file.
if [[ -f "$ENGINE_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENGINE_DIR/.env"
  set +a
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  say "SKIP  ANTHROPIC_API_KEY is not set (put it in $ENGINE_DIR/.env)"
  exit 1
fi

cd "$ENGINE_DIR"

# A generation can take many minutes; without a lock an hourly cron could start
# a second one on top of the first and pay for both.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  say "SKIP  another run is already in progress"
  exit 0
fi

VERDICT="$(node src/cli.js should-run 2>&1)" && DUE=0 || DUE=$?

if [[ $DUE -ne 0 ]]; then
  say "SKIP  $VERDICT"
  exit 0
fi

say "START $VERDICT"

if OUTPUT="$(node src/cli.js generate 2>&1)"; then
  TITLE="$(printf '%s' "$OUTPUT" | sed -n 's/^Done\. \(.*\) — awaiting.*/\1/p')"
  COST="$(printf '%s' "$OUTPUT" | sed -n 's/.*Estimated cost \(\$[0-9.]*\).*/\1/p')"
  say "DONE  ${TITLE:-a book} ${COST:+($COST)} — awaiting your approval"
  printf '%s\n' "$OUTPUT" | sed 's/^/        /' >> "$LOG_FILE"
else
  say "FAIL  generation failed:"
  printf '%s\n' "$OUTPUT" | sed 's/^/        /' >> "$LOG_FILE"
  exit 1
fi
