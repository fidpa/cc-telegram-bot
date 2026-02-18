/**
 * Unix Domain Socket listener for local alert ingestion.
 *
 * Accepts JSON alerts from local scripts and processes them through Claude,
 * responding in the configured Telegram group.
 *
 * Protocol: newline-delimited JSON over Unix stream socket.
 * Each connection sends one JSON object followed by a newline, then closes.
 *
 * Expected JSON format:
 * {
 *   "type": "cpu" | "memory" | "disk" | "service" | "custom",
 *   "severity": "info" | "warning" | "critical",
 *   "message": "Human-readable alert text",
 *   "host": "hostname",            // optional
 *   "metric_value": "95%",         // optional
 *   "secret": "shared-secret"      // optional, validated if ALERT_SOCKET_SECRET is set
 * }
 */

import type { Bot } from "grammy";
import { z } from "zod/v4";

interface SocketData {
  buffer: string;
}
import { ALERT_SOCKET_PATH, ALERT_SOCKET_SECRET, ALLOWED_GROUP_IDS, DAILY_LOG_DIR } from "./config";
import { getSession } from "./session";
import { StreamingState } from "./handlers/streaming";
import { auditLog } from "./utils";
import { insertAlert, markProcessed } from "./alert-db";
import { unlinkSync } from "fs";

// Alert user ID — alerts use a synthetic user ID to avoid collision with real users
const ALERT_USER_ID = 0;
const ALERT_USERNAME = "alert-system";

// Track daily session — reset at midnight for fresh context
let alertSessionDate: string | null = null;

// SEC-F3: Simple rate limiter for socket alerts (prevents DoS from compromised scripts)
const ALERT_MAX_PER_MINUTE = 10;
let alertRateCount = 0;
let alertRateWindowStart = Date.now();

// SEC-F11: Alert queue to prevent loss during busy processing
const ALERT_QUEUE_MAX = 20;
const alertQueue: InternalAlert[] = [];
let alertProcessing = false;

// SEC-F8: Runtime validation for alert payloads (replaces bare type assertion)
const AlertPayloadSchema = z.object({
  type: z.string().max(100),
  severity: z.string().max(20).optional(),
  message: z.string().min(1).max(10000),
  host: z.string().max(200).optional(),
  metric_value: z.string().max(200).optional(),
  secret: z.string().max(500).optional(),
});

type AlertPayload = z.infer<typeof AlertPayloadSchema>;

// Internal alert with optional DB row ID for tracking
type InternalAlert = AlertPayload & { _dbId?: number | null };

/**
 * Format an alert payload into a Claude prompt.
 * Only contains dynamic alert data — all static instructions are in SAFETY_PROMPT.
 */
function formatAlertPrompt(alert: AlertPayload): string {
  const severity = (alert.severity || "warning").toUpperCase();
  const host = alert.host || "unknown";

  // SEC-F1: Wrap untrusted alert data in content tags to prevent prompt injection.
  const alertDataLines = [
    `Type: ${alert.type}`,
    `Severity: ${severity}`,
    `Host: ${host}`,
    `Message: ${alert.message}`,
  ];
  if (alert.metric_value) {
    alertDataLines.push(`Value: ${alert.metric_value}`);
  }

  return [
    "[ALERT] New system alert received.",
    "",
    "<alert_data>",
    ...alertDataLines,
    "</alert_data>",
  ].join("\n");
}

/**
 * Format the EOD report prompt. Claude uses its session context
 * (all alerts processed today) to write the daily report.
 */
function formatEodReportPrompt(): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateStr = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  // dateStr = "DD/MM/YYYY" — extract parts for filename
  const parts = dateStr.split("/");
  const dd = parts[0];
  const mm = parts[1];
  const yyyy = parts[2] || "";
  const yy = yyyy.slice(2);
  const filename = `${dd}${mm}${yy}-bot-daily-log.md`;
  const filePath = `${DAILY_LOG_DIR}/${filename}`;
  const displayDate = `${dd}.${mm}.${yyyy}`;

  return [
    "GENERATE DAILY REPORT",
    "",
    `Write the daily report for today (${displayDate}) as a Markdown file.`,
    "",
    "STEPS:",
    `1. Create the directory if needed: mkdir -p ${DAILY_LOG_DIR}`,
    `2. Write the report to: ${filePath}`,
    "3. Reply with ONLY a brief summary (1-3 sentences) for the Telegram chat.",
    "",
    "REPORT STRUCTURE (as guidance, not a rigid template):",
    "",
    `  # Bot Daily Report - ${displayDate}`,
    "",
    "  **Session duration:** HH:MM (first alert) - HH:MM (last alert)",
    "  **Total alerts:** N",
    "  **Alerts by type:**",
    "  - ALERT_TYPE: N",
    "",
    "  ---",
    "",
    "  ## Alert History",
    "",
    "  ### HH:MM:SS - ALERT_TYPE",
    "  **Action:** What was done",
    "  **Result:** Success / Failure",
    "  **Notes:** Additional observations",
    "",
    "  ---",
    "",
    "  ## Summary",
    "",
    "  **Success rate:** X% (N/M actions successful)",
    "  **Issues:** ...",
    "  **Patterns:** ...",
    "  **Recommendations:** ...",
    "",
    "  ---",
    "",
    "  **Created:** YYYY-MM-DD HH:MM:SS",
    "",
    "DAYS WITHOUT ALERTS:",
    "If no alerts were processed today, still create a brief report:",
    "- Document it as 'No alerts — normal operation'",
    "- Run a quick system check (uptime, disk, memory)",
    "- Keep the report minimal (5-10 lines)",
    "",
    "RULES:",
    "- Use your session context: you have processed all of today's alerts.",
    "- Do NOT execute any git operations.",
    "- The Telegram reply should be a brief summary only, NOT the full report.",
  ].join("\n");
}

/**
 * Process an alert through Claude and send the response to the Telegram group.
 */
async function processAlert(bot: Bot, alert: InternalAlert): Promise<void> {
  const groupId = ALLOWED_GROUP_IDS[0];
  if (!groupId) {
    console.error("[ALERT] No group configured in TELEGRAM_ALLOWED_GROUPS");
    return;
  }

  // SEC-F3: Rate limit socket alerts
  const now = Date.now();
  if (now - alertRateWindowStart > 60_000) {
    alertRateCount = 0;
    alertRateWindowStart = now;
  }
  alertRateCount++;
  if (alertRateCount > ALERT_MAX_PER_MINUTE) {
    console.warn(`[ALERT] Rate limited: ${alertRateCount} alerts in 60s window, skipping`);
    return;
  }

  const prompt = alert.type === "EOD_REPORT"
    ? formatEodReportPrompt()
    : formatAlertPrompt(alert);
  const severity = (alert.severity || "warning").toUpperCase();

  console.log(`[ALERT] Processing ${alert.type} alert (${severity})`);

  // No header message — the alert bot already posts to the group.
  // Claude's response will appear directly as the bot's reaction.

  const session = getSession(ALERT_USER_ID);

  // Daily session: reset at midnight, resume within the same day
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  if (alertSessionDate !== today) {
    if (session.isActive) {
      console.log(`[ALERT] New day (${today}) — resetting alert session`);
      await session.kill();
    }
    alertSessionDate = today;

    // Auto-resume last alert session from today (e.g., after service restart)
    if (!session.isActive) {
      const savedSessions = session.getSessionList(ALERT_USER_ID);
      if (savedSessions.length > 0) {
        const lastSaved = savedSessions[0]!;
        const savedDate = lastSaved.saved_at.slice(0, 10);
        if (savedDate === today) {
          const [ok, msg] = session.resumeSession(lastSaved.session_id, ALERT_USER_ID);
          if (ok) {
            console.log(`[ALERT] Auto-resumed session after restart: ${msg}`);
          }
        }
      }
    }
  } else if (session.isRunning) {
    // SEC-F11: Queue alert instead of waiting 60s and dropping
    if (alertQueue.length >= ALERT_QUEUE_MAX) {
      console.warn(`[ALERT] Queue full (${ALERT_QUEUE_MAX}), dropping oldest alert`);
      alertQueue.shift();
    }
    alertQueue.push(alert);
    console.log(`[ALERT] Queued: ${alert.type} (${alertQueue.length} pending)`);
    return;
  }

  // If session was resumed, we may need to fall back to a fresh session
  const wasResumed = session.isActive;
  let lastError: unknown;

  for (let attempt = 0; attempt < (wasResumed ? 2 : 1); attempt++) {
    if (attempt === 1) {
      console.warn("[ALERT] Resumed session failed, falling back to fresh session");
      await session.kill();
    }

    const state = new StreamingState();
    const statusCallback = createAlertStatusCallback(bot, groupId, state);

    try {
      const response = await session.sendMessageStreaming(
        prompt,
        ALERT_USERNAME,
        ALERT_USER_ID,
        statusCallback,
        groupId
      );

      // Record processing in alert history DB
      if (alert._dbId) {
        markProcessed(alert._dbId, response.length);
      }

      await auditLog(ALERT_USER_ID, ALERT_USERNAME, "ALERT", prompt, response);
      console.log(
        `[ALERT] Processing complete${attempt > 0 ? " (fresh session fallback)" : ""}`
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }

  console.error("[ALERT] Claude processing failed:", lastError);
  try {
    await bot.api.sendMessage(
      groupId,
      "❌ Alert processing failed. Check logs for details."
    );
  } catch {
    // Ignore send failure
  }
}

/**
 * SEC-F11: Enqueue an alert for processing.
 * Processes immediately if idle, otherwise queues. Drains queue after each alert.
 */
async function enqueueAlert(bot: Bot, alert: InternalAlert): Promise<void> {
  if (alertProcessing) {
    if (alertQueue.length >= ALERT_QUEUE_MAX) {
      console.warn(`[ALERT] Queue full (${ALERT_QUEUE_MAX}), dropping oldest alert`);
      alertQueue.shift();
    }
    alertQueue.push(alert);
    console.log(`[ALERT] Queued: ${alert.type} (${alertQueue.length} pending)`);
    return;
  }

  alertProcessing = true;
  try {
    await processAlert(bot, alert);

    // Drain queued alerts
    while (alertQueue.length > 0) {
      const next = alertQueue.shift()!;
      console.log(`[ALERT] Dequeued: ${next.type} (${alertQueue.length} remaining)`);
      await processAlert(bot, next);
    }
  } finally {
    alertProcessing = false;
  }
}

/**
 * Create a status callback for alert processing that sends to a group chat.
 * Similar to the regular createStatusCallback but uses bot.api directly.
 */
function createAlertStatusCallback(
  bot: Bot,
  chatId: number,
  state: StreamingState
) {
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      if (statusType === "tool") {
        const toolMsg = await bot.api.sendMessage(chatId, content, {
          parse_mode: "HTML",
        });
        state.toolMessages.push(toolMsg);
      } else if (statusType === "segment_end" && segmentId !== undefined && content) {
        const { convertMarkdownToHtml } = await import("./formatting");
        const { redactSecrets } = await import("./utils");
        const formatted = convertMarkdownToHtml(redactSecrets(content));

        // Split if too long (4096 Telegram limit)
        const LIMIT = 4000;
        if (formatted.length <= LIMIT) {
          try {
            await bot.api.sendMessage(chatId, formatted, { parse_mode: "HTML" });
          } catch {
            await bot.api.sendMessage(chatId, content);
          }
        } else {
          for (let i = 0; i < formatted.length; i += LIMIT) {
            const chunk = formatted.slice(i, i + LIMIT);
            try {
              await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
            } catch {
              await bot.api.sendMessage(chatId, chunk);
            }
          }
        }
      } else if (statusType === "done") {
        // Clean up tool status messages
        for (const toolMsg of state.toolMessages) {
          try {
            await bot.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
      // Skip "thinking" and intermediate "text" updates for alerts — only show final result
    } catch (error) {
      console.error("[ALERT] Status callback error:", error);
    }
  };
}

/**
 * Start the Unix Domain Socket listener for alerts.
 * Returns a cleanup function to stop the server.
 */
export function startAlertSocket(bot: Bot): () => void {
  // SEC-F4: Warn if socket has no authentication configured
  if (!ALERT_SOCKET_SECRET) {
    console.warn(
      "[ALERT] WARNING: ALERT_SOCKET_SECRET is not set. " +
      "Any local process can send alerts without authentication. " +
      "Set ALERT_SOCKET_SECRET in .env for production use."
    );
  }

  // Clean up stale socket file
  try {
    unlinkSync(ALERT_SOCKET_PATH);
  } catch {
    // Socket file doesn't exist yet — fine
  }

  const server = Bun.listen<SocketData>({
    unix: ALERT_SOCKET_PATH,
    socket: {
      data(socket, data) {
        socket.data.buffer += new TextDecoder().decode(data);
      },
      open(socket) {
        socket.data = { buffer: "" };
      },
      close(socket) {
        const raw = socket.data.buffer;
        if (!raw.trim()) return;

        try {
          const parsed = JSON.parse(raw.trim());

          // SEC-F8: Runtime validation with Zod (replaces bare type assertion)
          const result = AlertPayloadSchema.safeParse(parsed);
          if (!result.success) {
            console.warn("[ALERT] Rejected: invalid payload:", result.error.message);
            return;
          }
          const alert = result.data;

          // Validate secret if configured
          if (ALERT_SOCKET_SECRET && alert.secret !== ALERT_SOCKET_SECRET) {
            console.warn("[ALERT] Rejected: invalid secret");
            return;
          }

          // SEC-F1: Strip spoofed manual prefix from alert messages
          let message = alert.message;
          if (message.includes("[MANUAL via /alert]")) {
            console.warn("[ALERT] Stripped spoofed manual prefix from alert message");
            message = message.replaceAll("[MANUAL via /alert]", "[SPOOFED-PREFIX-REMOVED]");
          }

          // Persist to alert history DB before queuing (strip secret — defense-in-depth)
          const { secret: _s, ...alertData } = alert;
          const dbId = insertAlert({ ...alertData, message });

          // SEC-F11: Enqueue instead of direct processing (prevents alert loss)
          enqueueAlert(bot, { ...alert, message, _dbId: dbId }).catch((err) => {
            console.error("[ALERT] Async processing error:", err);
          });
        } catch (error) {
          console.error("[ALERT] Invalid JSON received:", error);
        }
      },
      error(socket, error) {
        console.error("[ALERT] Socket error:", error);
      },
    },
  });

  // Make socket accessible to the alert script user
  try {
    const { chmodSync } = require("fs");
    chmodSync(ALERT_SOCKET_PATH, 0o660);
  } catch {
    // Non-critical
  }

  console.log(`Alert socket listening: ${ALERT_SOCKET_PATH}`);

  return () => {
    server.stop();
    try {
      unlinkSync(ALERT_SOCKET_PATH);
    } catch {
      // Ignore
    }
  };
}
