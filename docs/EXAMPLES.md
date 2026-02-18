# Examples

Practical examples for common use cases.

## Alert Socket Integration

The bot exposes a Unix Domain Socket that accepts JSON alerts from local scripts. Claude processes each alert and responds in the configured Telegram group.

### Prerequisites

- `TELEGRAM_ALLOWED_GROUPS` configured in `.env`
- `socat` installed (`apt install socat` / `brew install socat`)
- Bot running with alert socket active (check logs for `Alert socket listening:`)

### Send a Basic Alert

```bash
echo '{"type":"disk","severity":"warning","message":"Root partition at 92%","host":"myserver"}' | \
  socat - UNIX-CONNECT:/run/cc-telegram-bot/alerts.sock
```

### Send an Authenticated Alert

If `ALERT_SOCKET_SECRET` is set in `.env` (recommended for production):

```bash
echo '{"type":"service","severity":"critical","message":"nginx crashed with exit code 1","host":"web-01","secret":"your-shared-secret"}' | \
  socat - UNIX-CONNECT:/run/cc-telegram-bot/alerts.sock
```

Alerts with a missing or incorrect `secret` are silently rejected when authentication is enabled.

### Alert Payload Reference

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `type` | string | yes | max 100 chars | Alert category (`cpu`, `memory`, `disk`, `service`, `custom`, `EOD_REPORT`) |
| `severity` | string | no | max 20 chars | `info`, `warning`, `critical` (default: `warning`) |
| `message` | string | yes | 1-10000 chars | Human-readable alert text |
| `host` | string | no | max 200 chars | Originating hostname |
| `metric_value` | string | no | max 200 chars | Numeric value (e.g., `95%`, `4.2 GB`) |
| `secret` | string | no | max 500 chars | Shared secret (validated if `ALERT_SOCKET_SECRET` is set) |

### Bash Function for Repeated Use

```bash
send_alert() {
    local type="${1:?usage: send_alert TYPE SEVERITY MESSAGE}"
    local severity="${2:?}"
    local message="${3:?}"
    local socket="${ALERT_SOCKET_PATH:-/run/cc-telegram-bot/alerts.sock}"

    if [[ ! -S "$socket" ]]; then
        echo "ERROR: Socket not found: $socket" >&2
        return 1
    fi

    local payload
    payload=$(jq -n \
        --arg type "$type" \
        --arg severity "$severity" \
        --arg msg "$message" \
        --arg host "$(hostname)" \
        --arg secret "${ALERT_SOCKET_SECRET:-}" \
        '{type: $type, severity: $severity, message: $msg, host: $host, secret: $secret}')

    echo "$payload" | socat -t5 - UNIX-CONNECT:"$socket"
}

# Usage:
send_alert "disk" "warning" "Root partition at 92%"
send_alert "service" "critical" "PostgreSQL not responding on port 5432"
send_alert "custom" "info" "Backup completed successfully (3.2 GB, 14 min)"
```

### Cron Job Example

```bash
# /etc/cron.d/disk-alert
*/15 * * * * root bash -c 'usage=$(df / --output=pcent | tail -1 | tr -d " %%"); \
  if [ "$usage" -gt 90 ]; then \
    echo "{\"type\":\"disk\",\"severity\":\"warning\",\"message\":\"Root partition at ${usage}%%\",\"host\":\"$(hostname)\"}" | \
    socat - UNIX-CONNECT:/run/cc-telegram-bot/alerts.sock; \
  fi'
```

### systemd Service Health Check

```bash
#!/bin/bash
# check-services.sh — Alert on failed systemd services

set -euo pipefail

SOCKET="${ALERT_SOCKET_PATH:-/run/cc-telegram-bot/alerts.sock}"
[[ -S "$SOCKET" ]] || exit 0

failed=$(systemctl --no-legend --state=failed --plain | awk '{print $1}')
[[ -z "$failed" ]] && exit 0

message="Failed services detected: $(echo "$failed" | tr '\n' ', ' | sed 's/,$//')"

jq -n \
    --arg msg "$message" \
    --arg host "$(hostname)" \
    '{type: "service", severity: "critical", message: $msg, host: $host}' | \
  socat -t5 - UNIX-CONNECT:"$SOCKET"
```

### Python Client

```python
import json
import socket

def send_alert(
    alert_type: str,
    message: str,
    severity: str = "warning",
    host: str | None = None,
    socket_path: str = "/run/cc-telegram-bot/alerts.sock",
    secret: str | None = None,
) -> None:
    payload = {
        "type": alert_type,
        "severity": severity,
        "message": message,
    }
    if host:
        payload["host"] = host
    if secret:
        payload["secret"] = secret

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(5)
        sock.connect(socket_path)
        sock.sendall(json.dumps(payload).encode() + b"\n")

# Usage:
send_alert("memory", "RAM usage at 94%", severity="critical", host="db-01")
```

### Testing the Socket

Verify the socket is active and accepting connections:

```bash
# Check socket exists
ls -la /run/cc-telegram-bot/alerts.sock

# Send a test alert
echo '{"type":"custom","severity":"info","message":"Test alert — ignore this"}' | \
  socat -t5 - UNIX-CONNECT:/run/cc-telegram-bot/alerts.sock

# Watch bot logs for processing
journalctl -u cc-telegram-bot -f --no-hostname | grep '\[ALERT\]'
```

## Query Alert History

Every alert is persisted to a SQLite database (`~/.cc-telegram-bot/alerts.db` by default). Use `sqlite3` to query the history for trend analysis, MTTR metrics, and reporting.

### Top Alert Types (Last 30 Days)

```bash
sqlite3 ~/.cc-telegram-bot/alerts.db "
  SELECT type, COUNT(*) as count,
         ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER(), 1) as pct
  FROM alerts
  WHERE received_at >= date('now', '-30 days')
  GROUP BY type
  ORDER BY count DESC;
"
```

### Mean Time to Response (MTTR)

```bash
sqlite3 ~/.cc-telegram-bot/alerts.db "
  SELECT type,
         ROUND(AVG(
           (julianday(processed_at) - julianday(received_at)) * 86400
         ), 1) as avg_seconds,
         COUNT(*) as count
  FROM alerts
  WHERE processed_at IS NOT NULL
  GROUP BY type
  ORDER BY avg_seconds DESC;
"
```

### Alerts Per Day (Last 14 Days)

```bash
sqlite3 -header -column ~/.cc-telegram-bot/alerts.db "
  SELECT date(received_at) as day,
         COUNT(*) as total,
         SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
         SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) as warning,
         SUM(CASE WHEN severity = 'info' THEN 1 ELSE 0 END) as info
  FROM alerts
  WHERE received_at >= date('now', '-14 days')
  GROUP BY day
  ORDER BY day DESC;
"
```

### Unprocessed Alerts (Dropped or Still Queued)

```bash
sqlite3 ~/.cc-telegram-bot/alerts.db "
  SELECT id, received_at, type, severity, substr(message, 1, 80) as message
  FROM alerts
  WHERE processed_at IS NULL
  ORDER BY received_at DESC
  LIMIT 20;
"
```

## EOD Report

Trigger an End-of-Day report (Claude summarizes all alerts processed that day):

```bash
echo '{"type":"EOD_REPORT","severity":"info","message":"Generate daily report"}' | \
  socat - UNIX-CONNECT:/run/cc-telegram-bot/alerts.sock
```

A ready-made script is included at `scripts/trigger-eod-report.sh`.

For automatic daily reports, configure a systemd timer or launchd plist — see [docs/LAUNCHAGENT.md](LAUNCHAGENT.md) for macOS setup.

## Group Chat

The bot responds in whitelisted groups when:
- Mentioned via `@your_bot_username`
- Someone replies to the bot's message

Configure allowed groups in `.env`:

```bash
TELEGRAM_ALLOWED_GROUPS=-1001234567890,-1009876543210
```

## MCP Server Integration

Extend the bot with custom tools via Model Context Protocol:

```typescript
// mcp-config.ts
import type { McpServerConfig } from "./src/types";

export const mcpServers: McpServerConfig[] = [
  {
    name: "my-tools",
    command: "npx",
    args: ["-y", "my-mcp-server"],
  },
];
```

See [mcp-config.example.ts](../mcp-config.example.ts) for a working example.
