/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { TELEGRAM_TOKEN, WORKING_DIR, ALLOWED_USERS, ALLOWED_GROUP_IDS, RESTART_FILE, ALERT_SOCKET_PATH } from "./config";
import { startAlertSocket } from "./alert-socket";
import { initAlertDb, closeAlertDb } from "./alert-db";
import { unlinkSync, readFileSync, existsSync } from "fs";
import {
  handleStart,
  handleNew,
  handleStop,
  handleStatus,
  handleResume,
  handleRestart,
  handleRetry,
  handleModel,
  handleAlert,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleAudio,
  handleVideo,
  handleCallback,
} from "./handlers";

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

// F8 + SEC-F9: Environment isolation — strip secrets Claude doesn't need.
// grammY stores the token internally; Claude's child process shouldn't inherit it.
// ANTHROPIC_API_KEY is intentionally kept — required by the Agent SDK.
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_ALLOWED_USERS;
delete process.env.TELEGRAM_ALLOWED_GROUPS;
delete process.env.ALERT_SOCKET_SECRET;
delete process.env.AUDIT_LOG_HMAC_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.TYPEFULLY_API_KEY;

// F6: Group Chat Protection with Whitelist
// Private chats: always allowed
// Whitelisted groups: only on @mention or reply-to-bot
// Everything else: silently blocked
bot.use(async (ctx, next) => {
  if (!ctx.chat) return;

  // Private chats: always allow
  if (ctx.chat.type === "private") {
    await next();
    return;
  }

  // Groups: only whitelisted AND (@mention OR reply-to-bot)
  if (ALLOWED_GROUP_IDS.includes(ctx.chat.id)) {
    const botUsername = ctx.me.username;
    const text = ctx.message?.text || ctx.message?.caption || "";

    // Check @mention
    const isMentioned = botUsername &&
      text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);

    // Check reply-to-bot
    const isReply = ctx.message?.reply_to_message?.from?.id === ctx.me.id;

    // Check if it's a command directed at the bot (e.g. /status@botname)
    const isDirectCommand = botUsername &&
      text.startsWith("/") &&
      text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);

    if (isMentioned || isReply || isDirectCommand) {
      console.log(
        `[GROUP] Processing message in group ${ctx.chat.id} from user ${ctx.from?.id}`
      );
      await next();
      return;
    }
  }

  // Everything else: block silently
  console.warn(
    `[GROUP] Rejected ${ctx.chat.type} chat ${ctx.chat.id} (not whitelisted or no mention)`
  );
  return;
});

// Rewrite "@botname /command args" → "/command@botname args" in groups
// so grammY's bot.command() handlers can match (they require / at offset 0)
bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== "private" && ctx.message?.text) {
    const botUsername = ctx.me.username;
    if (botUsername) {
      const regex = new RegExp(
        `^@${botUsername}\\s+(/[a-zA-Z]\\w*)(\\s.*)?$`,
        "i"
      );
      const match = ctx.message.text.match(regex);
      if (match && match[1]) {
        const cmd = match[1]; // e.g. "/new"
        const rest = match[2] || "";
        const rewritten = `${cmd}@${botUsername}${rest}`;
        // Mutate update so grammY sees a standard group command
        const msg = ctx.message as unknown as Record<string, unknown>;
        msg.text = rewritten;
        msg.entities = [
          {
            type: "bot_command",
            offset: 0,
            length: cmd.length + 1 + botUsername.length, // "/new@botname"
          },
        ];
      }
    }
  }
  await next();
});

// Sequentialize non-command messages per user (prevents race conditions)
// Commands bypass sequentialization so they work immediately
bot.use(
  sequentialize((ctx) => {
    // Commands are not sequentialized - they work immediately
    if (ctx.message?.text?.startsWith("/")) {
      return undefined;
    }
    // Messages with ! prefix bypass queue (interrupt)
    if (ctx.message?.text?.startsWith("!")) {
      return undefined;
    }
    // Callback queries (button clicks) are not sequentialized
    if (ctx.callbackQuery) {
      return undefined;
    }
    // Other messages are sequentialized per chat
    return ctx.chat?.id.toString();
  })
);

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("new", handleNew);
bot.command("stop", handleStop);
bot.command("status", handleStatus);
bot.command("resume", handleResume);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);
bot.command("model", handleModel);
bot.command("m", handleModel); // Short alias for /model
bot.command("alert", handleAlert); // Send message into alert session (user ID 0)

// ============== Message Handlers ==============

// Text messages
bot.on("message:text", handleText);

// Voice messages
bot.on("message:voice", handleVoice);

// Photo messages
bot.on("message:photo", handlePhoto);

// Document messages
bot.on("message:document", handleDocument);

// Audio messages
bot.on("message:audio", handleAudio);

// Video messages (regular videos and video notes)
bot.on("message:video", handleVideo);
bot.on("message:video_note", handleVideo);

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
  console.error("Bot error:", err);
});

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Telegram Bot");
console.log("=".repeat(50));
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
console.log(`Allowed groups: ${ALLOWED_GROUP_IDS.length}`);
console.log("Starting bot...");

// Get bot info first
const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    // Only update if restart was recent (within 30 seconds)
    // Validate chat_id belongs to an authorized user (L2: prevent message spoofing)
    const chatIdNum = Number(data.chat_id);
    const isAuthorizedChat = ALLOWED_USERS.includes(chatIdNum);
    if (age < 30000 && data.chat_id && data.message_id && isAuthorizedChat) {
      await bot.api.editMessageText(
        data.chat_id,
        data.message_id,
        "✅ Bot restarted"
      );
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    console.warn("Failed to update restart message:", e);
    try { unlinkSync(RESTART_FILE); } catch {}
  }
}

// Start with concurrent runner (commands work immediately)
const runner = run(bot);

// Initialize alert history database
try {
  initAlertDb();
} catch (error) {
  console.warn(`[ALERT-DB] Initialization failed: ${error}`);
  console.warn("Alert history will be unavailable this session.");
}

// Start alert socket listener (optional — only if TELEGRAM_ALLOWED_GROUPS is configured)
let stopAlertSocket: (() => void) | null = null;
if (ALLOWED_GROUP_IDS.length > 0) {
  try {
    stopAlertSocket = startAlertSocket(bot);
  } catch (error) {
    console.warn(`Alert socket not started: ${error}`);
    console.warn("Alerts via Unix socket will be unavailable. Check that the directory exists.");
  }
}

// Graceful shutdown
const stopRunner = () => {
  if (runner.isRunning()) {
    console.log("Stopping bot...");
    runner.stop();
  }
  if (stopAlertSocket) {
    stopAlertSocket();
    stopAlertSocket = null;
  }
  closeAlertDb();
};

process.on("SIGINT", () => {
  console.log("Received SIGINT");
  stopRunner();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM");
  stopRunner();
  process.exit(0);
});
