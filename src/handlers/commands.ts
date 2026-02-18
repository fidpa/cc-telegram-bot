/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart, /retry
 */

import type { Context } from "grammy";
import { getSession } from "../session";
import { ALLOWED_USERS, ALLOWED_GROUP_IDS, CLAUDE_MODEL, RESTART_FILE } from "../config";
import { isAuthorized } from "../security";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const session = getSession(userId!);
  const status = session.isActive ? "Aktive Sitzung" : "Keine aktive Sitzung";

  await ctx.reply(
    `🖥️ <b>Macmini — Claude Code Remote</b>\n\n` +
      `Status: ${status}\n\n` +
      `<b>Befehle:</b>\n` +
      `/new - Neue Sitzung starten\n` +
      `/stop - Aktuelle Anfrage abbrechen\n` +
      `/status - Status anzeigen\n` +
      `/resume - Letzte Sitzung fortsetzen\n` +
      `/retry - Letzte Nachricht wiederholen\n` +
      `/m - Modell wechseln (s/o/h)\n` +
      `/restart - Bot neu starten\n\n` +
      `<b>Tipps:</b>\n` +
      `• Mit <code>!</code> vorangestellt aktuelle Anfrage unterbrechen\n` +
      `• "think" für ausführliches Nachdenken\n` +
      `• Fotos, Sprachnachrichten oder Dokumente senden`,
    { parse_mode: "HTML" }
  );
}

/**
 * /new - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const session = getSession(userId!);

  // Stop any running query
  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      await Bun.sleep(100);
      session.clearStopRequested();
    }
  }

  // Clear session
  await session.kill();

  await ctx.reply("🆕 Sitzung beendet. Die nächste Nachricht startet eine neue Sitzung.");
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const session = getSession(userId!);

  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      // Wait for the abort to be processed, then clear stopRequested so next message can proceed
      await Bun.sleep(100);
      session.clearStopRequested();
    }
    // Silent stop - no message shown
  }
  // If nothing running, also stay silent
}

/**
 * /status - Show detailed status.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const session = getSession(userId!);

  const lines: string[] = ["📊 <b>Status</b>\n"];

  // Session status
  if (session.isActive) {
    lines.push(`✅ Sitzung: Aktiv`);
  } else {
    lines.push("⚪ Sitzung: Keine");
  }

  // Query status
  if (session.isRunning) {
    const elapsed = session.queryStarted
      ? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
      : 0;
    lines.push(`🔄 Anfrage: Läuft (${elapsed}s)`);
    if (session.currentTool) {
      lines.push(`   └─ ${session.currentTool}`);
    }
  } else {
    lines.push("⚪ Anfrage: Bereit");
    if (session.lastTool) {
      lines.push(`   └─ Zuletzt: ${session.lastTool}`);
    }
  }

  // Last activity
  if (session.lastActivity) {
    const ago = Math.floor(
      (Date.now() - session.lastActivity.getTime()) / 1000
    );
    lines.push(`\n⏱️ Letzte Aktivität: vor ${ago}s`);
  }

  // Usage stats
  if (session.lastUsage) {
    const usage = session.lastUsage;
    lines.push(
      `\n📈 Letzte Anfrage:`,
      `   Input: ${usage.input_tokens?.toLocaleString() || "?"} Tokens`,
      `   Output: ${usage.output_tokens?.toLocaleString() || "?"} Tokens`
    );
    if (usage.cache_read_input_tokens) {
      lines.push(
        `   Cache: ${usage.cache_read_input_tokens.toLocaleString()}`
      );
    }
  }

  // Error status (sanitized — no file paths)
  if (session.lastError) {
    const ago = session.lastErrorTime
      ? Math.floor((Date.now() - session.lastErrorTime.getTime()) / 1000)
      : "?";
    lines.push(`\n⚠️ Letzter Fehler (vor ${ago}s)`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /resume - Show list of sessions to resume with inline keyboard.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const session = getSession(userId!);

  if (session.isActive) {
    await ctx.reply("Sitzung bereits aktiv. Nutze /new für eine neue Sitzung.");
    return;
  }

  // Get saved sessions
  const sessions = session.getSessionList(userId!);

  if (sessions.length === 0) {
    await ctx.reply("❌ Keine gespeicherten Sitzungen.");
    return;
  }

  // Build inline keyboard with session list
  const buttons = sessions.map((s) => {
    // Format date: "15.02 10:30"
    const date = new Date(s.saved_at);
    const dateStr = date.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
    });
    const timeStr = date.toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
    });

    // Truncate title for button (max ~40 chars to fit)
    const titlePreview =
      s.title.length > 35 ? s.title.slice(0, 32) + "..." : s.title;

    return [
      {
        text: `📅 ${dateStr} ${timeStr} - "${titlePreview}"`,
        callback_data: `resume:${s.session_id}`,
      },
    ];
  });

  await ctx.reply("📋 <b>Gespeicherte Sitzungen</b>\n\nWähle eine Sitzung zum Fortsetzen:", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // Exit - launchd will restart us
  process.exit(0);
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const session = getSession(userId!);

  // Check if there's a message to retry
  if (!session.lastMessage) {
    await ctx.reply("❌ Keine Nachricht zum Wiederholen.");
    return;
  }

  // Check if something is already running
  if (session.isRunning) {
    await ctx.reply("⏳ Anfrage läuft noch. Nutze /stop zuerst.");
    return;
  }

  const lastMessage = session.lastMessage;
  await ctx.reply("🔄 Wird wiederholt...");

  // Simulate sending the message again by emitting a fake text message event
  // We do this by directly calling the text handler logic
  const { handleText } = await import("./text");

  // Create a modified context with the last message
  const fakeCtx = {
    ...ctx,
    message: {
      ...ctx.message,
      text: lastMessage,
    },
  } as Context;

  await handleText(fakeCtx);
}

/**
 * /model - Show or change the Claude model.
 */
export async function handleModel(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const text = ctx.message?.text || "";

  if (!userId) return;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const session = getSession(userId);
  const args = text.split(" ").slice(1); // Get arguments after /model

  // Available models (short names)
  const models = {
    "s": "claude-sonnet-4-5",
    "o": "claude-opus-4-6",
    "h": "claude-haiku-4-5",
  };

  const modelNames = {
    "claude-sonnet-4-5": "Sonnet 4.5",
    "claude-opus-4-6": "Opus 4.6",
    "claude-haiku-4-5": "Haiku 4.5",
  };

  // No arguments - show current model
  if (args.length === 0) {
    const currentModel = session.preferredModel || CLAUDE_MODEL;
    const modelName = modelNames[currentModel as keyof typeof modelNames] || currentModel;

    await ctx.reply(
      `🤖 <b>Aktuelles Modell</b>\n\n` +
        `<b>${modelName}</b>\n` +
        `<code>${currentModel}</code>\n\n` +
        `<b>Modell wechseln:</b>\n` +
        `• <code>/m s</code> - Sonnet 4.5 (Standard)\n` +
        `• <code>/m o</code> - Opus 4.6 (maximale Qualität)\n` +
        `• <code>/m h</code> - Haiku 4.5 (schnell)\n\n` +
        `<i>Gilt ab nächster Nachricht</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Change model
  const modelArg = args[0]?.toLowerCase();

  if (modelArg && modelArg in models) {
    const newModel = models[modelArg as keyof typeof models];
    const newModelName = modelNames[newModel as keyof typeof modelNames];
    session.preferredModel = newModel;

    await ctx.reply(
      `✅ Modell: <b>${newModelName}</b>\n\n` +
        `<code>${newModel}</code>\n\n` +
        `Gilt ab nächster Nachricht.`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(
      `❌ Unbekannt: <code>${modelArg}</code>\n\n` +
        `Verfügbar:\n` +
        `• <code>/m s</code> - Sonnet 4.5\n` +
        `• <code>/m o</code> - Opus 4.6\n` +
        `• <code>/m h</code> - Haiku 4.5`,
      { parse_mode: "HTML" }
    );
  }
}

/**
 * /alert <message> - Send a message into the alert session (user ID 0).
 * Allows interactive access to the daily alert session from Telegram.
 * The alert session has context over all alerts processed today.
 */
export async function handleAlert(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Extract message after /alert (or /alert@botname)
  const raw = ctx.message?.text || "";
  const message = raw.replace(/^\/alert(@\S+)?\s*/, "").trim();

  if (!message) {
    const alertSession = getSession(0);
    const status = alertSession.isActive ? "active" : "inactive";
    const running = alertSession.isRunning ? " (processing)" : "";
    await ctx.reply(
      `🔔 <b>Alert Session</b> (User ID 0)\n\n` +
        `Status: ${status}${running}\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/alert &lt;message&gt;</code> — Send a message into the alert session\n\n` +
        `The alert session has context over all alerts processed today.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Determine target group for response
  const groupId = ALLOWED_GROUP_IDS[0] || chatId;
  if (!groupId) return;

  const alertSession = getSession(0);

  // Wait if alert is already processing
  if (alertSession.isRunning) {
    await ctx.reply("⏳ Alert session is processing. Please wait...");
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(1000);
      if (!alertSession.isRunning) break;
    }
    if (alertSession.isRunning) {
      await ctx.reply("❌ Timeout — alert session still busy.");
      return;
    }
  }

  // Import streaming utilities
  const { StreamingState, createStatusCallback } = await import("./streaming");
  const { auditLog } = await import("../utils");

  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const prefixedMessage = `[MANUAL via /alert] ${message}`;
    const response = await alertSession.sendMessageStreaming(
      prefixedMessage,
      ctx.from?.username || "unknown",
      0, // Alert user ID
      statusCallback,
      chatId!,
      ctx
    );

    await auditLog(0, "alert-manual", "ALERT_CMD", message, response);
  } catch (error) {
    const errorStr = String(error);
    if (!errorStr.includes("abort") && !errorStr.includes("cancel")) {
      await ctx.reply("❌ An error occurred. Check logs for details.");
    }
  }
}
