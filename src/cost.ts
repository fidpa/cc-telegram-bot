/**
 * Per-user cost accounting.
 *
 * The bot recorded `lastUsage` of the most recent request for `/status` and
 * nothing else — no total, no ceiling. A bot you start Opus sessions from while
 * away from your desk can get expensive without anyone noticing until the
 * invoice does the noticing.
 *
 * Storage: the SQLite database that alert-db.ts already opens (`alerts.db`),
 * sharing its handle rather than opening a second one. The other candidate was
 * `sessions.json`, and it loses on one point that decides it:
 * `loadSessionHistory()` swallows parse errors and returns `{sessions: []}`
 * (session.ts). A budget that silently resets to zero when a JSON file gets
 * corrupted is not a budget. Three lesser reasons point the same way — the file
 * is rewritten whole with an un-awaited `Bun.write`, so two users finishing at
 * once can lose an update; it is capped at MAX_SESSIONS entries, which is the
 * wrong lifetime for a running total; and it is keyed per session, not per user.
 *
 * Reset interval: calendar month, local time. The period string is part of the
 * primary key, so a new month is simply a new key — no cron job, no cleanup
 * pass, no state a restart can lose, and previous months stay readable as
 * history. A month is also the period an operator's real Anthropic budget is
 * measured in; thirty daily limits are not a monthly ceiling.
 *
 * NOTE — no migration mechanism. Like the alerts table, this schema is created
 * with CREATE TABLE IF NOT EXISTS and nothing more. Adding a column later will
 * silently not happen on databases that already exist; that will need an
 * explicit migration step when the time comes. Reverting the feature leaves the
 * table in place, which is harmless — older code never reads it.
 */

import type { Database, Statement } from "bun:sqlite";

/**
 * Thrown when a request would exceed the configured cost limit.
 *
 * A distinct class rather than a plain Error because the handlers have to tell
 * it apart from a real failure: the user already received an explanation
 * through the `notice` channel, so the generic "something went wrong" reply
 * would be both redundant and misleading.
 */
export class CostLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostLimitError";
  }
}

let db: Database | null = null;
let upsertStmt: Statement | null = null;
let selectStmt: Statement | null = null;

/** Current accounting period: "YYYY-MM" in local time. */
function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Attach to an open database and create the table.
 *
 * Called from initAlertDb() with its handle — one connection, one init path.
 * Passing the Database in rather than importing it back from alert-db.ts keeps
 * the dependency one-directional.
 */
export function initCostDb(database: Database): void {
  db = database;

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_costs (
      user_id INTEGER NOT NULL,
      period TEXT NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0,
      queries INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
      PRIMARY KEY (user_id, period)
    )
  `);

  // Atomic read-modify-write in one statement: two handlers finishing at the
  // same moment both add their amount instead of one overwriting the other.
  upsertStmt = db.query(`
    INSERT INTO user_costs (user_id, period, cost_usd, queries)
    VALUES ($user_id, $period, $cost_usd, 1)
    ON CONFLICT(user_id, period) DO UPDATE SET
      cost_usd = cost_usd + excluded.cost_usd,
      queries = queries + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')
  `);
  selectStmt = db.query(`
    SELECT cost_usd, queries FROM user_costs
    WHERE user_id = $user_id AND period = $period
  `);
}

/**
 * Add the cost of one completed query to a user's running total.
 *
 * Silently does nothing when the database is unavailable — see getUserCost()
 * for what that means for the limit.
 */
export function addUserCost(userId: number, costUsd: number): void {
  if (!db || !upsertStmt || !(costUsd > 0)) return;

  try {
    upsertStmt.run({
      $user_id: userId,
      $period: currentPeriod(),
      $cost_usd: costUsd,
    });
  } catch (error) {
    console.error("[COST] Failed to record cost:", error);
  }
}

/**
 * Spend and query count for a user in the current period.
 *
 * Returns zeroes when the database is unavailable. That is a deliberate
 * fail-open: a failed `initAlertDb()` is only a warning today (index.ts), and
 * refusing every request because of it would turn a database hiccup into a
 * dead bot. The cost of that choice is worth stating plainly: if the database
 * is broken, the limit is not enforced, and it is not enforced at exactly the
 * moment nobody is looking. The alternative — fail closed — was considered and
 * rejected by the operator.
 */
export function getUserCost(userId: number): {
  costUsd: number;
  queries: number;
} {
  if (!db || !selectStmt) return { costUsd: 0, queries: 0 };

  try {
    const row = selectStmt.get({
      $user_id: userId,
      $period: currentPeriod(),
    }) as { cost_usd: number; queries: number } | null;
    return row
      ? { costUsd: row.cost_usd, queries: row.queries }
      : { costUsd: 0, queries: 0 };
  } catch (error) {
    console.error("[COST] Failed to read cost:", error);
    return { costUsd: 0, queries: 0 };
  }
}

/** Release the cached statements. The Database itself is closed by alert-db.ts. */
export function closeCostDb(): void {
  upsertStmt = null;
  selectStmt = null;
  db = null;
}
