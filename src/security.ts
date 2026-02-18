/**
 * Security module for Claude Telegram Bot.
 *
 * Rate limiting, path validation, command safety.
 */

import { resolve, normalize } from "path";
import { realpathSync } from "fs";
import type { RateLimitBucket } from "./types";
import {
  ALLOWED_PATHS,
  BLOCKED_PATTERNS,
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_REQUESTS,
  RATE_LIMIT_WINDOW,
  TEMP_PATHS,
} from "./config";

// ============== Rate Limiter ==============

// Max message length (matches Telegram's own limit)
export const MAX_MESSAGE_LENGTH = 4096;

class RateLimiter {
  private buckets = new Map<number, RateLimitBucket>();
  private maxTokens: number;
  private refillRate: number; // tokens per second
  private cleanupInterval: Timer;

  constructor() {
    this.maxTokens = RATE_LIMIT_REQUESTS;
    this.refillRate = RATE_LIMIT_REQUESTS / RATE_LIMIT_WINDOW;

    // Periodic cleanup of stale buckets (M5: prevent memory leak)
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Remove buckets inactive for more than 10 minutes.
   */
  private cleanup(): void {
    const staleThreshold = Date.now() - 10 * 60 * 1000;
    for (const [userId, bucket] of this.buckets) {
      if (bucket.lastUpdate < staleThreshold) {
        this.buckets.delete(userId);
      }
    }
  }

  check(userId: number): [allowed: boolean, retryAfter?: number] {
    if (!RATE_LIMIT_ENABLED) {
      return [true];
    }

    const now = Date.now();
    let bucket = this.buckets.get(userId);

    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastUpdate: now };
      this.buckets.set(userId, bucket);
    }

    // Refill tokens based on time elapsed
    const elapsed = (now - bucket.lastUpdate) / 1000;
    bucket.tokens = Math.min(
      this.maxTokens,
      bucket.tokens + elapsed * this.refillRate
    );
    bucket.lastUpdate = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return [true];
    }

    // Calculate time until next token
    const retryAfter = (1 - bucket.tokens) / this.refillRate;
    return [false, retryAfter];
  }

  getStatus(userId: number): {
    tokens: number;
    max: number;
    refillRate: number;
  } {
    const bucket = this.buckets.get(userId);
    return {
      tokens: bucket?.tokens ?? this.maxTokens,
      max: this.maxTokens,
      refillRate: this.refillRate,
    };
  }
}

export const rateLimiter = new RateLimiter();

// ============== Path Validation ==============

export function isPathAllowed(path: string): boolean {
  try {
    // Expand ~ and resolve to absolute path
    const expanded = path.replace(/^~/, process.env.HOME || "");
    const normalized = normalize(expanded);

    // Try to resolve symlinks (may fail if path doesn't exist yet)
    let resolved: string;
    try {
      resolved = realpathSync(normalized);
    } catch {
      resolved = resolve(normalized);
    }

    // Always allow temp paths (for bot's own files)
    for (const tempPath of TEMP_PATHS) {
      if (resolved.startsWith(tempPath)) {
        return true;
      }
    }

    // Check against allowed paths using proper containment
    for (const allowed of ALLOWED_PATHS) {
      const allowedResolved = resolve(allowed);
      if (
        resolved === allowedResolved ||
        resolved.startsWith(allowedResolved + "/")
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

// ============== Command Safety ==============

// Regex patterns for more robust detection (harder to bypass than string matching)
const BLOCKED_REGEX_PATTERNS: Array<[RegExp, string]> = [
  // rm -rf with variable expansion or quoting tricks
  [/rm\s+(-[a-z]*f[a-z]*\s+)?["']?\/["']?\s*$/i, "rm targeting root"],
  [/rm\s+(-[a-z]*f[a-z]*\s+)?["']?~["']?\s*$/i, "rm targeting home"],
  // Pipe to shell variants (with optional whitespace)
  [/\|\s*(ba|z|da|k|tc)?sh(\s|$)/i, "pipe to shell"],
  // curl/wget piped to execution
  [/(curl|wget)\s+.*\|\s*(ba|z)?sh/i, "remote code execution"],
  // Process substitution for execution
  [/(ba|z)?sh\s*<\s*\(/i, "process substitution execution"],
  // Overwriting system files
  [/>\s*\/etc\//i, "overwriting system files"],
  // Crontab manipulation
  [/crontab\s+-r/i, "crontab removal"],
  // Environment manipulation to bypass PATH restrictions
  [/env\s+.*PATH=/i, "PATH manipulation"],

  // F2: Block eval/encoding bypass vectors
  // eval: only block standalone eval command, not words like "evaluate"
  [/;\s*eval\s+/i, "eval after semicolon"],
  [/\|\s*eval\s+/i, "eval in pipe"],
  [/^\s*eval\s+["'$]/i, "eval with expansion"],
  // base64: only block decode piped to shell execution
  [/base64.*(-d|--decode).*\|\s*(ba|z|da|k)?sh/i, "base64 decode to shell"],
  // Process substitution sourcing
  [/(source|\.\s)\s+<\s*\(\s*(curl|wget)/i, "sourcing remote content"],
  // xargs: only block dangerous rm -rf patterns
  [/\bxargs\s+.*\brm\s+-rf\s+[/~]/i, "xargs rm -rf targeting root/home"],

  // F8: Block environment variable dumping (credential leak prevention)
  [/^\s*printenv\b/i, "printenv dumps all env vars"],
  [/^\s*env\s*$/i, "standalone env dumps all vars"],
  [/^\s*env\s*\|/i, "env piped (dumps all vars)"],
  [/\bexport\s+-p\b/i, "export -p dumps all vars"],
  [/\bdeclare\s+-[xp]/i, "declare -x/-p dumps env vars"],
  [/\bcompgen\s+-v\b/i, "compgen -v lists all variables"],

  // F1: Block reading sensitive files via shell commands
  [/(cat|head|tail|less|more|bat|strings)\s+.*\.env\b/i, "reading .env file via shell"],
  [/(cat|head|tail|less|more|bat|strings)\s+.*id_rsa/i, "reading SSH key via shell"],
  [/(cat|head|tail|less|more|bat|strings)\s+.*id_ed25519/i, "reading SSH key via shell"],
  [/(cat|head|tail|less|more|bat|strings)\s+.*authorized_keys/i, "reading SSH authorized keys"],
  [/(cat|head|tail|less|more|bat|strings)\s+.*\.ssh\/config/i, "reading SSH config"],
  [/(cat|head|tail|less|more|bat|strings)\s+.*\/etc\/shadow/i, "reading shadow file"],
  [/(cat|head|tail|less|more|bat|strings)\s+.*\.netrc/i, "reading netrc credentials"],
  [/(cat|head|tail|less|more|bat|strings)\s+.*\.aws\/credentials/i, "reading AWS credentials"],
  [/(cat|head|tail|less|more|bat|strings)\s+.*\.kube\/config/i, "reading kubeconfig"],

  // F1: Block network exfiltration of sensitive data
  [/(curl|wget|nc|ncat)\s+.*\.(env|pem|key|p12|pfx)\b/i, "exfiltrating sensitive files"],
  [/(curl|wget)\s+.*--data.*\.(env|pem|key)\b/i, "exfiltrating via POST"],
  [/(curl|wget)\s+.*--upload-file/i, "file upload via curl/wget"],

  // SEC-F2: Block scripting language env access (bypass for shell-level blocks)
  [/\bpython[23]?\s+-c\s+.*os\.environ/i, "Python env access"],
  [/\bpython[23]?\s+-c\s+.*subprocess/i, "Python subprocess"],
  [/\bnode\s+-e\s+.*process\.env/i, "Node.js env access"],
  [/\bbun\s+-e\s+.*process\.env/i, "Bun env access"],
  [/\bbun\s+-e\s+.*Bun\.env/i, "Bun env access"],
  [/\bruby\s+-e\s+.*\bENV\b/i, "Ruby ENV access"],
  [/\bperl\s+-e\s+.*%ENV/i, "Perl ENV access"],

  // SEC-F2: Block /proc access to process environment and cmdline
  [/\/proc\/[^\s]*\/environ/i, "/proc environ access"],
  [/\/proc\/[^\s]*\/cmdline/i, "/proc cmdline access"],
  [/\/proc\/[^\s]*\/maps/i, "/proc maps access"],
];

export function checkCommandSafety(
  command: string
): [safe: boolean, reason: string] {
  const lowerCommand = command.toLowerCase();

  // Check string-based blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (lowerCommand.includes(pattern.toLowerCase())) {
      return [false, `Blocked pattern: ${pattern}`];
    }
  }

  // Check regex-based patterns (more robust)
  for (const [regex, reason] of BLOCKED_REGEX_PATTERNS) {
    if (regex.test(command)) {
      return [false, `Blocked: ${reason}`];
    }
  }

  // Special handling for rm commands - validate paths
  if (lowerCommand.includes("rm ")) {
    try {
      // Simple parsing: extract arguments after rm
      const rmMatch = command.match(/rm\s+(.+)/i);
      if (rmMatch) {
        const args = rmMatch[1]!.split(/\s+/);
        for (const arg of args) {
          // Skip flags
          if (arg.startsWith("-") || arg.length <= 1) continue;
          // Skip variable references (can't validate at parse time)
          if (arg.includes("$")) {
            return [false, "rm with variable expansion not allowed"];
          }

          // Check if path is allowed
          if (!isPathAllowed(arg)) {
            return [false, `rm target outside allowed paths: ${arg}`];
          }
        }
      }
    } catch {
      // If parsing fails, be cautious
      return [false, "Could not parse rm command for safety check"];
    }
  }

  return [true, ""];
}

// ============== Authorization ==============

export function isAuthorized(
  userId: number | undefined,
  allowedUsers: number[]
): boolean {
  if (!userId) return false;
  if (allowedUsers.length === 0) return false;
  return allowedUsers.includes(userId);
}
