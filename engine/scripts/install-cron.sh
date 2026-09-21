#!/usr/bin/env bash
#
# Installs (or removes) the hourly crontab entry that drives scheduled runs.
# Idempotent: re-running replaces the existing entry rather than adding another.
#
#   ./scripts/install-cron.sh            install
#   ./scripts/install-cron.sh --remove   uninstall
#   ./scripts/install-cron.sh --show     print what would be installed

set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$ENGINE_DIR/scripts/run-scheduled.sh"
MARKER="# book-factory scheduled runs"
ENTRY="0 * * * * $RUNNER  $MARKER"

case "${1:-install}" in
  --show)
    printf '%s\n' "$ENTRY"
    exit 0
    ;;
  --remove)
    crontab -l 2>/dev/null | grep -vF "$MARKER" | crontab - || true
    echo "Removed the book-factory cron entry."
    exit 0
    ;;
esac

if [[ ! -x "$RUNNER" ]]; then
  chmod +x "$RUNNER"
fi

if [[ ! -f "$ENGINE_DIR/.env" ]]; then
  cat >&2 <<WARN
No $ENGINE_DIR/.env found. cron runs with almost no environment, so the key
must live in a file. Create it first:

  echo 'ANTHROPIC_API_KEY=sk-ant-...' > $ENGINE_DIR/.env
  chmod 600 $ENGINE_DIR/.env

WARN
fi

# Replace any previous entry, then append the current one.
( crontab -l 2>/dev/null | grep -vF "$MARKER" || true; printf '%s\n' "$ENTRY" ) | crontab -

echo "Installed:"
echo "  $ENTRY"
echo
echo "It runs hourly and does nothing unless a run is due and within your guards."
echo "Current settings:"
( cd "$ENGINE_DIR" && node src/cli.js status | tail -4 )
echo
echo "Log: $ENGINE_DIR/logs/scheduled.log"
