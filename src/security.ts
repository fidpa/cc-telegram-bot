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
  ALLOWED_TOOLS,
  BLOCKED_PATTERNS,
  DISALLOWED_TOOLS,
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

// ============== Tool Control ==============

/**
 * Does a configured spec match a tool name?
 *
 * Three forms, mirroring how the SDK documents its own MCP specs:
 *   Read              exact name
 *   mcp__ask-user__*  prefix wildcard (trailing *)
 *   mcp__ask-user     MCP server-level spec, matches every tool of that server
 */
function toolSpecMatches(spec: string, toolName: string): boolean {
  if (spec === toolName) return true;
  if (spec.endsWith("*")) return toolName.startsWith(spec.slice(0, -1));
  if (spec.startsWith("mcp__") && !spec.slice(5).includes("__")) {
    return toolName.startsWith(`${spec}__`);
  }
  return false;
}

/**
 * Is this tool permitted by ALLOWED_TOOLS / DISALLOWED_TOOLS?
 *
 * Both lists empty -> always true, which is the shipped default and the
 * behaviour every existing installation has today. Deny wins over allow: a
 * name on both lists is blocked, because the operator who wrote the denylist
 * was answering a narrower question than the one who wrote the allowlist.
 *
 * IMPORTANT — what this is and is not. This is called while reading the output
 * stream (session.ts), not before the tool runs. It reports and it aborts the
 * turn; it does not prevent execution. That limit is the whole of it:
 *
 *   - `canUseTool` would be synchronous, but it does not fire here. The shipped
 *     bundle says so itself: "permissionMode 'bypassPermissions' auto-approves
 *     every tool call (except explicit deny rules) before the callback is
 *     consulted. To gate every tool call, use a PreToolUse hook instead."
 *   - A `PreToolUse` hook is therefore the SDK's own answer for real prevention,
 *     and it fires inside sub-agents too (HookInput.agent_id, sdk.d.ts). It is
 *     deliberately not wired up here — that reworks the permission path and
 *     belongs in its own change, not alongside three unrelated features.
 *   - Sub-agent tool calls ARE visible to this function. sdk.d.ts documents
 *     that tool_use/tool_result blocks from sub-agents are emitted by default
 *     (see `forwardSubagentText`), and session.ts does not filter on
 *     parent_tool_use_id. Detection covers them; prevention still does not.
 *
 * Enforcement is `tools` / `disallowedTools` handed to the SDK, and the two do
 * not have the same reach (measured against 0.3.233, no longer inferred from
 * the type definitions):
 *
 *   `tools`            built-in tools only. MCP tools stay available in full,
 *                      so an allowlist alone does NOT yield a read-only bot
 *                      once any MCP server is configured.
 *   `disallowedTools`  reaches both. The exact name, `mcp__server__*` and
 *                      `mcp__server` all remove the server's tools from the
 *                      session itself, not just from this check.
 *
 * A read-only configuration therefore needs both lists. This function is the
 * second pair of eyes: it catches what an allowlist leaves through, it survives
 * the SDK renaming or re-scoping those options, and it makes a blocked call
 * visible to the user instead of leaving a turn that just stops.
 */
export function isToolAllowed(
  toolName: string
): [allowed: boolean, reason: string] {
  for (const spec of DISALLOWED_TOOLS) {
    if (toolSpecMatches(spec, toolName)) {
      return [false, `${toolName} is on DISALLOWED_TOOLS (matched "${spec}")`];
    }
  }

  if (ALLOWED_TOOLS.length > 0) {
    const permitted = ALLOWED_TOOLS.some((spec) =>
      toolSpecMatches(spec, toolName)
    );
    if (!permitted) {
      return [false, `${toolName} is not on ALLOWED_TOOLS`];
    }
  }

  return [true, ""];
}

/**
 * Drop wildcard specs before handing the list to the SDK.
 *
 * ALLOWED_TOOLS carries two grammars at once: isToolAllowed() understands
 * "mcp__ask-user__*", while the SDK's `tools` option documents concrete names
 * only. Passing a literal "mcp__ask-user__*" through would ask the SDK for a
 * tool by that exact name. Wildcards therefore stay with the runtime check.
 */
export function stripToolWildcards(specs: string[]): string[] {
  return specs.filter((s) => !s.endsWith("*"));
}

/**
 * Run every safety check that applies to a single tool call.
 *
 * Collected here rather than inline in the streaming loop for two reasons: the
 * loop had grown past the file-size limit in CONTRIBUTING.md, and all four
 * checks are questions about safety, which is what this module is. The caller
 * logs, reports and aborts — this function only decides.
 *
 * Returns the user-facing message as the second element, because the wording
 * differs per check ("BLOCKED:" for a command, "Access denied:" for a path)
 * and the caller should not have to reconstruct it.
 */
export function checkToolCallSafety(
  toolName: string,
  toolInput: Record<string, unknown>
): [safe: boolean, notice: string] {
  // L25-ish: tool allow/deny lists. No-op while both are empty.
  const [toolOk, toolReason] = isToolAllowed(toolName);
  if (!toolOk) {
    return [false, `Blocked: ${toolReason}`];
  }

  // L5/L6: command blocklist
  if (toolName === "Bash") {
    const command = String(toolInput.command || "");
    const [isSafe, reason] = checkCommandSafety(command);
    if (!isSafe) {
      return [false, `BLOCKED: ${reason}`];
    }
  }

  // L7: file operation paths
  if (["Read", "Write", "Edit"].includes(toolName)) {
    const filePath = String(toolInput.file_path || "");
    if (filePath) {
      // Reads from temp paths and .claude directories stay allowed: that is
      // where the bot puts its own downloads and where plan mode reads from.
      const isTmpRead =
        toolName === "Read" &&
        (TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
          filePath.includes("/.claude/"));

      if (!isTmpRead && !isPathAllowed(filePath)) {
        return [false, `Access denied: ${filePath}`];
      }
    }
  }

  // L7: Glob and Grep search roots
  if (["Glob", "Grep"].includes(toolName)) {
    const searchPath = String(toolInput.path || "");
    if (searchPath && !isPathAllowed(searchPath)) {
      return [false, `Access denied: ${searchPath}`];
    }
  }

  return [true, ""];
}

/**
 * Refuse an unsafe tool call BEFORE it runs, and let the turn continue.
 *
 * This is the prevention half that the stream check in session.ts cannot be.
 * By the time a tool_use block appears in the output stream the call has
 * already been dispatched, so the only enforcement left there is to abort the
 * whole turn — which is what used to happen: the user asked a question, some
 * tool call tripped a rule, and the answer never arrived. Nothing about that
 * was a security failure; it was the model taking a route it was not allowed
 * to take, and the bot treating that as fatal.
 *
 * A PreToolUse hook is the SDK's own answer, documented in sdk.d.ts, and it
 * behaves the way Claude Code does interactively: the call is denied, the
 * reason goes back to the model as a tool result, and the model picks a
 * different route. `permissionDecision: "deny"` resolves before canUseTool
 * runs, so `permissionMode: "bypassPermissions"` does not override it. The
 * hook also fires inside sub-agents (HookInput.agent_id).
 *
 * This is the ONLY thing standing between an unsafe call and execution, so it
 * fails closed: anything thrown inside the callback still denies. The stream
 * check in session.ts cannot serve as a fallback, however tempting that reads
 * — measured against SDK 0.3.233, the tool_use block reaches the output stream
 * BEFORE the hook runs, so a stream-side check firing first would abort the
 * query before the hook ever gets a say. That ordering is exactly what used to
 * make a blocked call kill the whole turn. The stream check therefore only
 * reports now, and prevention lives here alone.
 */
export function buildSafetyHook() {
  return [
    {
      hooks: [
        async (
          input: { hook_event_name: string } & Record<string, unknown>
        ) => {
          if (input.hook_event_name !== "PreToolUse") return { continue: true };

          let notice: string;
          try {
            const toolName = String(input.tool_name || "");
            const toolInput = (input.tool_input || {}) as Record<
              string,
              unknown
            >;
            const [safe, reason] = checkToolCallSafety(toolName, toolInput);
            if (safe) return { continue: true };
            notice = reason;
          } catch (e) {
            notice = `Safety check failed: ${(e as Error).message}`;
          }

          // continue: true keeps the turn alive. Only the call dies — the
          // reason goes back to the model as a tool result, and it picks
          // another route instead of the user losing the answer.
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: notice,
            },
          };
        },
      ],
    },
  ];
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
