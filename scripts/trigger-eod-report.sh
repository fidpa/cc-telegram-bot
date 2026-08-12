#!/bin/bash
# Trigger EOD (End of Day) report via the alert socket.
# Called by systemd timer or launchd at your configured time.

set -euo pipefail

SOCKET_PATH="${ALERT_SOCKET_PATH:-/run/cc-telegram-bot/alerts.sock}"

# Validate socket path contains only safe characters
if [[ ! "$SOCKET_PATH" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
    logger -t cc-telegram-eod "Invalid socket path: $SOCKET_PATH"
    echo "ERROR: Invalid socket path" >&2
    exit 1
fi

if [[ ! -S "$SOCKET_PATH" ]]; then
    logger -t cc-telegram-eod "Socket not found: $SOCKET_PATH"
    echo "ERROR: Socket not found: $SOCKET_PATH" >&2
    exit 1
fi

JSON='{"type":"EOD_REPORT","severity":"info","message":"Generate daily report"}'

echo "$JSON" | socat - UNIX-CONNECT:"$SOCKET_PATH"
STATUS=$?

if [[ $STATUS -eq 0 ]]; then
    logger -t cc-telegram-eod "EOD report trigger sent"
else
    logger -t cc-telegram-eod "EOD report trigger failed (exit: $STATUS)"
    exit $STATUS
fi
