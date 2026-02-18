/**
 * SQLite Alert History Store.
 *
 * Persists every incoming alert for trend analysis, MTTR metrics,
 * and data-driven reporting. Purely additive — does not affect
 * the existing alert queue or processing flow.
 *
 * Uses Bun's built-in SQLite with WAL mode for concurrent reads.
 */

import { Database, type Statement } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { ALERT_DB_PATH } from "./config";

let db: Database | null = null;

// Cached prepared statements (created once in initAlertDb)
let insertStmt: Statement | null = null;
let updateStmt: Statement | null = null;

/**
 * Initialize the SQLite database. Creates the directory, database file,
 * and table if they don't exist. Enables WAL mode.
 *
 * Call once at startup (index.ts).
 */
export function initAlertDb(): void {
  // Ensure parent directory exists
  mkdirSync(dirname(ALERT_DB_PATH), { recursive: true });

  const isNew = !existsSync(ALERT_DB_PATH);
  db = new Database(ALERT_DB_PATH);

  // Restrict file permissions (owner-only) — parent dir is 700 but umask may leave file 644
  if (isNew) {
    chmodSync(ALERT_DB_PATH, 0o600);
  }

  db.exec("PRAGMA journal_mode=WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
      type TEXT NOT NULL,
      severity TEXT DEFAULT 'warning',
      message TEXT NOT NULL,
      host TEXT,
      metric_value TEXT,
      processed_at TEXT,
      claude_response_length INTEGER
    )
  `);

  // Indexes for future analytics queries (trend analysis, MTTR, etc.)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_received_at ON alerts(received_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
  `);

  // Cache prepared statements
  insertStmt = db.query(`
    INSERT INTO alerts (type, severity, message, host, metric_value)
    VALUES ($type, $severity, $message, $host, $metric_value)
  `);
  updateStmt = db.query(`
    UPDATE alerts
    SET processed_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'),
        claude_response_length = $responseLength
    WHERE id = $id
  `);

  const count = db.query("SELECT COUNT(*) as cnt FROM alerts").get() as { cnt: number };
  console.log(`[ALERT-DB] Database initialized: ${ALERT_DB_PATH} (${count.cnt} existing records)`);
}

/**
 * Insert an alert record when it arrives on the socket.
 * Returns the row ID for later update via markProcessed().
 */
export function insertAlert(alert: {
  type: string;
  severity?: string;
  message: string;
  host?: string;
  metric_value?: string;
}): number | null {
  if (!db || !insertStmt) return null;

  try {
    const result = insertStmt.run({
      $type: alert.type,
      $severity: alert.severity || "warning",
      $message: alert.message,
      $host: alert.host || null,
      $metric_value: alert.metric_value || null,
    });
    return Number(result.lastInsertRowid);
  } catch (error) {
    console.error("[ALERT-DB] Insert failed:", error);
    return null;
  }
}

/**
 * Mark an alert as processed after Claude has responded.
 * Sets processed_at to current local time and records response length.
 */
export function markProcessed(alertId: number, responseLength: number): void {
  if (!db || !updateStmt) return;

  try {
    updateStmt.run({ $id: alertId, $responseLength: responseLength });
  } catch (error) {
    console.error("[ALERT-DB] markProcessed failed:", error);
  }
}

/**
 * Close the database connection. Call on shutdown.
 */
export function closeAlertDb(): void {
  insertStmt = null;
  updateStmt = null;
  if (db) {
    db.close();
    db = null;
  }
}
