/**
 * Utility functions for Claude Telegram Bot.
 *
 * Audit logging, voice transcription, typing indicator.
 */

import type { Chat } from "grammy/types";
import type { Context } from "grammy";
import type { AuditEvent } from "./types";
import { unlinkSync, statSync, rmSync } from "fs";
import {
  AUDIT_LOG_PATH,
  AUDIT_LOG_JSON,
  AUDIT_LOG_MAX_SIZE,
  AUDIT_LOG_MAX_FILES,
  AUDIT_LOG_HMAC_KEY,
  TRANSCRIPTION_AVAILABLE,
  TELEGRAM_TOKEN,
  TEMP_DIR,
  WHISPER_CLI_PATH,
  WHISPER_LANGUAGE,
  WHISPER_MODEL_PATH,
} from "./config";

// ============== Secret Redaction ==============

// Collect all known secret values at startup for exact-match redaction
const KNOWN_SECRETS: string[] = [];

// Env vars that contain secrets (values collected once, immutable)
const SECRET_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "TYPEFULLY_API_KEY",
];

for (const key of SECRET_ENV_KEYS) {
  const val = process.env[key];
  if (val && val.length >= 8) {
    KNOWN_SECRETS.push(val);
  }
}

// Also include the already-parsed token (in case env was cleared later)
if (TELEGRAM_TOKEN && !KNOWN_SECRETS.includes(TELEGRAM_TOKEN)) {
  KNOWN_SECRETS.push(TELEGRAM_TOKEN);
}

// Sort longest first so longer matches take priority
KNOWN_SECRETS.sort((a, b) => b.length - a.length);

// Regex patterns that catch secrets even if not in KNOWN_SECRETS
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Anthropic API keys: sk-ant-api03-...
  [/sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/g, "[REDACTED:ANTHROPIC_KEY]"],
  // OpenAI keys: sk-proj-... or sk-...
  [/sk-proj-[A-Za-z0-9_-]{20,}/g, "[REDACTED:OPENAI_KEY]"],
  [/sk-[A-Za-z0-9]{20,}/g, "[REDACTED:API_KEY]"],
  // Telegram bot tokens: 1234567890:ABC-DEF...
  [/\d{8,10}:[A-Za-z0-9_-]{35}/g, "[REDACTED:BOT_TOKEN]"],
];

/**
 * Redact known secrets and secret-shaped patterns from text.
 * Used for both audit logs AND Telegram output.
 */
export function redactSecrets(text: string): string {
  let redacted = text;

  // Exact-match redaction of known secrets
  for (const secret of KNOWN_SECRETS) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }

  // Pattern-based redaction for unknown secrets
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }

  return redacted;
}

// ============== Log Sanitization (SEC-009) ==============

const HOME_DIR = process.env.HOME || "/Users/unknown";

/**
 * Sanitize a string for safe logging:
 * - Replace home directory with ~
 * - Strip node_modules stack frames
 * - Redact secrets
 */
function sanitizeForLog(text: string): string {
  let safe = text;

  // Replace full home path with ~
  safe = safe.replaceAll(HOME_DIR, "~");

  // Strip verbose node_modules paths from stack traces
  // e.g. "at Object.<anonymous> (/Users/.../node_modules/grammy/out/bot.js:123:45)"
  // becomes "at Object.<anonymous> (node_modules/grammy/...)"
  safe = safe.replace(
    /[^\s(]*\/node_modules\/([^/]+)\/[^\s)]+/g,
    "node_modules/$1/..."
  );

  // Redact secrets
  safe = redactSecrets(safe);

  return safe;
}

/**
 * Wrap console.error and console.warn to sanitize all log output.
 * Prevents internal paths, stack traces, and secrets from leaking to bot.log.
 */
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);

console.error = (...args: unknown[]) => {
  const sanitized = args.map((arg) =>
    typeof arg === "string"
      ? sanitizeForLog(arg)
      : arg instanceof Error
        ? sanitizeForLog(arg.message)
        : arg
  );
  originalConsoleError(...sanitized);
};

console.warn = (...args: unknown[]) => {
  const sanitized = args.map((arg) =>
    typeof arg === "string"
      ? sanitizeForLog(arg)
      : arg instanceof Error
        ? sanitizeForLog(arg.message)
        : arg
  );
  originalConsoleWarn(...sanitized);
};

// ============== Audit Logging (SEC-010: Rotation + HMAC) ==============

import { createHmac, randomBytes } from "crypto";
import { renameSync, existsSync as fsExistsSync } from "fs";

// Generate HMAC key if not configured (persists for this process lifetime)
const hmacKey = AUDIT_LOG_HMAC_KEY || randomBytes(32).toString("hex");

/**
 * Compute HMAC-SHA256 for an audit log entry.
 */
function computeHmac(content: string): string {
  return createHmac("sha256", hmacKey).update(content).digest("hex");
}

/**
 * Rotate audit log if it exceeds max size.
 * audit.log -> audit.log.1 -> audit.log.2 -> ... -> audit.log.N (deleted)
 */
async function rotateAuditLog(): Promise<void> {
  try {
    const stat = statSync(AUDIT_LOG_PATH);
    if (stat.size < AUDIT_LOG_MAX_SIZE) return;

    // Shift existing rotated files
    for (let i = AUDIT_LOG_MAX_FILES - 1; i >= 1; i--) {
      const older = `${AUDIT_LOG_PATH}.${i}`;
      const newer = i === 1 ? AUDIT_LOG_PATH : `${AUDIT_LOG_PATH}.${i - 1}`;
      if (fsExistsSync(newer)) {
        if (i === AUDIT_LOG_MAX_FILES - 1 && fsExistsSync(older)) {
          unlinkSync(older);
        }
        renameSync(newer, older);
      }
    }
    // AUDIT_LOG_PATH has been renamed to .1, a fresh file will be created on next write
  } catch {
    // File may not exist yet or rotation failed — continue
  }
}

async function writeAuditLog(event: AuditEvent): Promise<void> {
  try {
    // Check rotation before writing
    await rotateAuditLog();

    let record: string;
    if (AUDIT_LOG_JSON) {
      const json = redactSecrets(JSON.stringify(event));
      const hmac = computeHmac(json);
      // Append HMAC as a field for tamper detection
      record = JSON.stringify({ ...JSON.parse(json), _hmac: hmac }) + "\n";
    } else {
      const lines = ["\n" + "=".repeat(60)];
      for (const [key, value] of Object.entries(event)) {
        let displayValue = value;
        if (
          (key === "content" || key === "response") &&
          String(value).length > 500
        ) {
          displayValue = String(value).slice(0, 500) + "...";
        }
        lines.push(`${key}: ${displayValue}`);
      }
      const text = redactSecrets(lines.join("\n") + "\n");
      const hmac = computeHmac(text);
      record = text + `hmac: ${hmac}\n`;
    }

    // Append to audit log file
    const fs = await import("fs/promises");
    await fs.appendFile(AUDIT_LOG_PATH, record, { mode: 0o600 });
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}

export async function auditLog(
  userId: number,
  username: string,
  messageType: string,
  content: string,
  response = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "message",
    user_id: userId,
    username,
    message_type: messageType,
    content,
  };
  if (response) {
    event.response = response;
  }
  await writeAuditLog(event);
}

export async function auditLogAuth(
  userId: number,
  username: string,
  authorized: boolean
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "auth",
    user_id: userId,
    username,
    authorized,
  });
}

export async function auditLogTool(
  userId: number,
  username: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  blocked = false,
  reason = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "tool_use",
    user_id: userId,
    username,
    tool_name: toolName,
    tool_input: toolInput,
    blocked,
  };
  if (blocked && reason) {
    event.reason = reason;
  }
  await writeAuditLog(event);
}

export async function auditLogError(
  userId: number,
  username: string,
  error: string,
  context = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "error",
    user_id: userId,
    username,
    error,
  };
  if (context) {
    event.context = context;
  }
  await writeAuditLog(event);
}

export async function auditLogRateLimit(
  userId: number,
  username: string,
  retryAfter: number
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "rate_limit",
    user_id: userId,
    username,
    retry_after: retryAfter,
  });
}

// ============== Voice Transcription ==============

const WHISPER_TIMEOUT_MS = 120_000;

/**
 * Convert audio to 16kHz mono WAV for whisper-cli compatibility.
 * whisper-cli cannot decode OGG/Opus (Telegram voice format) directly.
 */
async function convertToWav(inputPath: string): Promise<string | null> {
  const hasExtension = /\.[^.]+$/.test(inputPath);
  const wavPath = hasExtension
    ? inputPath.replace(/\.[^.]+$/, ".wav")
    : `${inputPath}.wav`;
  try {
    const proc = Bun.spawn(
      ["ffmpeg", "-loglevel", "error", "-i", inputPath, "-ar", "16000", "-ac", "1", "-y", wavPath],
      { stdout: "pipe", stderr: "pipe" }
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`ffmpeg exited with code ${exitCode}:`, stderr.trim());
      return null;
    }
    return wavPath;
  } catch (error) {
    console.error("ffmpeg conversion failed:", error);
    return null;
  }
}

/**
 * Transcribe audio locally using whisper-cli (whisper.cpp).
 * German-tuned GGML model. Converts non-WAV to WAV first via ffmpeg.
 */
async function transcribeLocal(filePath: string): Promise<string | null> {
  let wavPath: string | null = null;

  try {
    // Convert to WAV if not already WAV
    const inputPath = filePath.endsWith(".wav") ? filePath : await convertToWav(filePath);
    if (!inputPath) {
      console.error("Failed to convert audio to WAV");
      return null;
    }
    if (inputPath !== filePath) {
      wavPath = inputPath;
    }

    const proc = Bun.spawn(
      [
        WHISPER_CLI_PATH,
        "--model", WHISPER_MODEL_PATH,
        "--language", WHISPER_LANGUAGE,
        "--no-timestamps",
        "--no-prints",
        inputPath,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    let timeoutId: Timer | undefined;
    const result = await Promise.race([
      (async () => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        clearTimeout(timeoutId);
        return { stdout, stderr, exitCode, timedOut: false };
      })(),
      new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>(
        (resolve) => {
          timeoutId = setTimeout(() => {
            proc.kill();
            resolve({ stdout: "", stderr: "", exitCode: -1, timedOut: true });
          }, WHISPER_TIMEOUT_MS);
        }
      ),
    ]);

    if (result.timedOut) {
      console.error(`whisper-cli timed out after ${WHISPER_TIMEOUT_MS}ms`);
      return null;
    }

    // whisper-cli returns exit 0 even on read errors — check stderr
    if (result.exitCode !== 0 || result.stderr.includes("failed to read")) {
      console.error("whisper-cli failed:", result.stderr.trim());
      return null;
    }

    const text = result.stdout.trim();
    return text || null;
  } catch (error) {
    console.error("Local transcription failed:", error);
    return null;
  } finally {
    // Clean up temporary WAV
    if (wavPath) {
      try { unlinkSync(wavPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Transcribe audio file using local whisper-cli.
 * Returns transcript text or null on failure/disabled.
 */
export async function transcribeVoice(
  filePath: string
): Promise<string | null> {
  if (!TRANSCRIPTION_AVAILABLE) {
    return null;
  }

  return transcribeLocal(filePath);
}

// ============== Typing Indicator ==============

export interface TypingController {
  stop: () => void;
}

export function startTypingIndicator(ctx: Context): TypingController {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        await ctx.replyWithChatAction("typing");
      } catch (error) {
        console.debug("Typing indicator failed:", error);
      }
      await Bun.sleep(4000);
    }
  };

  // Start the loop
  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}

// ============== Message Interrupt ==============

// Import session lazily to avoid circular dependency
let sessionModule: {
  getSession: (userId: number) => {
    isRunning: boolean;
    stop: () => Promise<"stopped" | "pending" | false>;
    markInterrupt: () => void;
    clearStopRequested: () => void;
  };
} | null = null;

export async function checkInterrupt(text: string, userId: number): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  // Lazy import to avoid circular dependency
  if (!sessionModule) {
    sessionModule = await import("./session");
  }

  const strippedText = text.slice(1).trimStart();
  const session = sessionModule.getSession(userId);

  if (session.isRunning) {
    console.log("! prefix - interrupting current query");
    session.markInterrupt();
    await session.stop();
    await Bun.sleep(100);
    // Clear stopRequested so the new message can proceed
    session.clearStopRequested();
  }

  return strippedText;
}

// ============== Temp File Cleanup ==============

/**
 * Clean up temp files older than maxAgeMs (default: 30 minutes).
 */
export function cleanupTempFiles(maxAgeMs = 30 * 60 * 1000): void {
  try {
    const now = Date.now();

    // Clean individual files
    for (const entry of new Bun.Glob("*").scanSync({ cwd: TEMP_DIR, dot: false })) {
      if (entry === ".keep") continue;
      const filePath = `${TEMP_DIR}/${entry}`;
      try {
        const file = Bun.file(filePath);
        if (now - file.lastModified > maxAgeMs) {
          unlinkSync(filePath);
        }
      } catch {
        // Skip files that can't be stat'd or deleted
      }
    }

    // Clean archive_* directories
    for (const entry of new Bun.Glob("archive_*").scanSync({ cwd: TEMP_DIR, dot: false })) {
      const dirPath = `${TEMP_DIR}/${entry}`;
      try {
        const stat = statSync(dirPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          rmSync(dirPath, { recursive: true });
        }
      } catch {
        // Skip directories that can't be stat'd or deleted
      }
    }
  } catch (error) {
    console.error("Temp cleanup failed:", error);
  }
}

// Run cleanup every 10 minutes
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => cleanupTempFiles(), CLEANUP_INTERVAL_MS);
// Initial cleanup on startup
cleanupTempFiles();
