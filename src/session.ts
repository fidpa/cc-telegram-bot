/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions using the Agent SDK V1.
 * V1 supports full options (cwd, mcpServers, settingSources, etc.)
 */

import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, unlinkSync } from "fs";
import type { Context } from "grammy";
import {
  ALERT_USER_ID,
  ALLOWED_PATHS,
  ALLOWED_TOOLS,
  CLAUDE_MODEL,
  COST_LIMIT_USD,
  DISALLOWED_TOOLS,
  mcpServersForUser,
  SAFETY_PROMPT,
  SESSION_FILE,
  STREAMING_THROTTLE_MS,
  ASK_USER_DIR,
  ASK_USER_TOOL_PREFIX,
  THINKING_DEEP_KEYWORDS,
  THINKING_DEFAULT,
  THINKING_KEYWORDS,
  VERBOSE_LEVEL,
  WORKING_DIR,
} from "./config";
import { addUserCost, CostLimitError, getUserCost } from "./cost";
import { formatToolStatus } from "./formatting";
import { checkPendingAskUserRequests } from "./handlers/streaming";
import {
  buildSafetyHook,
  checkToolCallSafety,
  stripToolWildcards,
} from "./security";
import type {
  SavedSession,
  SessionHistory,
  StatusCallback,
  TokenUsage,
} from "./types";

type ThinkingLevel = "off" | "normal" | "deep";

/**
 * Determine thinking level from the message keywords, floored at
 * THINKING_DEFAULT.
 *
 * Keywords raise, never lower: a baseline of `deep` is not undone by a message
 * that happens to contain a `normal` keyword. Anything else would make the
 * floor conditional on wording, which is the opposite of a floor.
 */
function getThinkingLevel(message: string): ThinkingLevel {
  const msgLower = message.toLowerCase();
  const rank: Record<ThinkingLevel, number> = { off: 0, normal: 1, deep: 2 };

  let level: ThinkingLevel = THINKING_DEFAULT;

  // Check deep thinking triggers first (more specific)
  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) {
    level = "deep";
  } else if (THINKING_KEYWORDS.some((k) => msgLower.includes(k))) {
    level = "normal";
  }

  return rank[level] >= rank[THINKING_DEFAULT] ? level : THINKING_DEFAULT;
}

/**
 * Map a thinking level to SDK options.
 *
 * The deprecated `maxThinkingTokens` is only honoured as on/off on current
 * models, which collapsed "deep" into "normal". `effort` restores the
 * distinction between the two enabled levels.
 */
function getThinkingOptions(
  level: ThinkingLevel
): Pick<Options, "thinking" | "effort"> {
  switch (level) {
    case "deep":
      return { thinking: { type: "adaptive" }, effort: "max" };
    case "normal":
      return { thinking: { type: "adaptive" }, effort: "high" };
    case "off":
      return { thinking: { type: "disabled" } };
  }
}

/**
 * Manages Claude Code sessions using the Agent SDK V1.
 */
// Maximum number of sessions to keep in history
const MAX_SESSIONS = 5;

class ClaudeSession {
  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;
  conversationTitle: string | null = null;
  preferredModel: string | null = null; // User's preferred model (overrides default)
  // Per-user streaming verbosity, null = fall back to VERBOSE_LEVEL.
  //
  // Mirrors preferredModel exactly, on purpose: in memory only, never written
  // to sessions.json, and deliberately not cleared by kill() — so it survives
  // /new and is lost on restart, falling back to the env default just as the
  // model does. The alert session is a separate instance (getSession of
  // ALERT_USER_ID), so a user's /verbose never changes what the group sees.
  verboseLevel: number | null = null;

  private abortController: AbortController | null = null;
  private isQueryRunning = false;
  private stopRequested = false;
  private _isProcessing = false;
  private _wasInterruptedByNewMessage = false;
  private _userId: number | null = null;

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.isQueryRunning || this._isProcessing;
  }

  /**
   * Check if the last stop was triggered by a new message interrupt (! prefix).
   * Resets the flag when called. Also clears stopRequested so new messages can proceed.
   */
  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) {
      // Clear stopRequested so the new message can proceed
      this.stopRequested = false;
    }
    return was;
  }

  /**
   * Mark that this stop is from a new message interrupt.
   */
  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  /**
   * Clear the stopRequested flag (used after interrupt to allow new message to proceed).
   */
  clearStopRequested(): void {
    this.stopRequested = false;
  }

  /**
   * Mark processing as started.
   * Returns a cleanup function to call when done.
   */
  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  /**
   * Stop the currently running query or mark for cancellation.
   * Returns: "stopped" if query was aborted, "pending" if processing will be cancelled, false if nothing running
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    // If a query is actively running, abort it
    if (this.isQueryRunning && this.abortController) {
      this.stopRequested = true;
      this.abortController.abort();
      console.log("Stop requested - aborting current query");
      return "stopped";
    }

    // If processing but query not started yet
    if (this._isProcessing) {
      this.stopRequested = true;
      console.log("Stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }

  /**
   * Send a message to Claude with streaming updates via callback.
   *
   * @param ctx - grammY context for ask_user button display
   * @param billToUserId - who this turn's cost counts against, when that is
   *   not `userId`. Only /alert passes it: that command runs in the alert
   *   session (ALERT_USER_ID) but is typed by a real person, and without this
   *   a user who had hit their limit could keep working through /alert on the
   *   alert session's untaxed budget.
   */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context,
    billToUserId?: number
  ): Promise<string> {
    this._userId = userId;
    const billTo = billToUserId ?? userId;

    // Write chat context to file for ask_user MCP subprocess (SEC-004)
    // SEC-F7: Per-user file prevents cross-user race condition
    const askUserDir = ASK_USER_DIR;
    const contextFile = `${askUserDir}/query-context-${userId}.json`;
    // Also write generic file for backward compatibility with MCP server
    const genericContextFile = `${askUserDir}/query-context.json`;
    const contextData = JSON.stringify({ chat_id: chatId || "", user_id: userId });
    await Bun.write(contextFile, contextData);
    await Bun.write(genericContextFile, contextData);

    const isNewSession = !this.isActive;
    const thinkingLabel = getThinkingLevel(message);
    const verbose = this.verboseLevel ?? VERBOSE_LEVEL;

    // Inject current date/time at session start so Claude doesn't need to call a tool for it
    let messageToSend = message;
    if (isNewSession) {
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const datePrefix = `[Current date/time: ${now.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: tz,
      })}, ${now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: tz,
        timeZoneName: "short",
      })}]\n\n`;
      messageToSend = datePrefix + message;
    }

    // Build SDK V1 options - supports all features
    const options: Options = {
      hooks: { PreToolUse: buildSafetyHook() },
      model: this.preferredModel || CLAUDE_MODEL,
      cwd: WORKING_DIR,
      settingSources: ["user", "project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: SAFETY_PROMPT,
      // Per-user copy: the ask_user subprocess needs to know whose turn this
      // is to read the right context file. See mcpServersForUser() in config.ts.
      mcpServers: mcpServersForUser(userId),
      // Both spread conditionally rather than passed as empty arrays.
      //
      // `tools: []` is not "no restriction", it disables every built-in tool.
      // And for disallowedTools, settingSources: ["user", "project"] above
      // lets permissions.deny from ~/.claude/settings.json contribute; whether
      // an explicit [] replaces or merges with that is not something the type
      // definitions state. Not setting the key at all is the only form that
      // provably leaves an existing installation running exactly as before.
      ...(ALLOWED_TOOLS.length > 0
        ? { tools: stripToolWildcards(ALLOWED_TOOLS) }
        : {}),
      ...(DISALLOWED_TOOLS.length > 0
        ? { disallowedTools: DISALLOWED_TOOLS }
        : {}),
      ...getThinkingOptions(thinkingLabel),
      additionalDirectories: ALLOWED_PATHS,
      resume: this.sessionId || undefined,
    };

    // Add Claude Code executable path if set (required for standalone builds)
    if (process.env.CLAUDE_CODE_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
    }

    if (this.sessionId && !isNewSession) {
      console.log(
        `RESUMING session ${this.sessionId.slice(
          0,
          8
        )}... (thinking=${thinkingLabel})`
      );
    } else {
      console.log(`STARTING new Claude session (thinking=${thinkingLabel})`);
      this.sessionId = null;
    }

    // Check if stop was requested during processing phase
    if (this.stopRequested) {
      console.log(
        "Query cancelled before starting (stop was requested during processing)"
      );
      this.stopRequested = false;
      throw new Error("Query cancelled");
    }

    // Cost ceiling. Deliberately placed after the stopRequested reset above:
    // callback.ts calls stop() without a following clearStopRequested(), so
    // returning before that reset would leave the flag set and the next real
    // request would die on "Query cancelled" long after the limit was raised.
    //
    // ALERT_USER_ID is exempt on purpose. A cost ceiling that silences system
    // monitoring converts a billing safeguard into an outage, and the operator
    // would find out from the thing the alerts were supposed to warn about.
    if (COST_LIMIT_USD !== null && billTo !== ALERT_USER_ID) {
      const { costUsd } = getUserCost(billTo);
      if (costUsd >= COST_LIMIT_USD) {
        const msg =
          `Cost limit reached: $${costUsd.toFixed(2)} of $${COST_LIMIT_USD.toFixed(2)} ` +
          `this month. Resets at the start of next month, or raise COST_LIMIT_USD.`;
        console.warn(`[COST] Blocked user ${billTo}: ${msg}`);
        // "notice" so the reason survives on every path, including alerts;
        // the throw so no caller mistakes the refusal for an answer. Without
        // it, alert-socket.ts would hand the text to markProcessed() and file
        // the unanswered alert as handled.
        await statusCallback("notice", msg);
        throw new CostLimitError(msg);
      }
    }

    // Create abort controller for cancellation
    this.abortController = new AbortController();
    this.isQueryRunning = true;
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

    // Response tracking
    const responseParts: string[] = [];
    let currentSegmentId = 0;
    let currentSegmentText = "";
    let lastTextUpdate = 0;
    let queryCompleted = false;
    let askUserTriggered = false;
    let turnCostUsd = 0;

    try {
      // Use V1 query() API - supports all options including cwd, mcpServers, etc.
      const queryInstance = query({
        prompt: messageToSend,
        options: {
          ...options,
          abortController: this.abortController,
        },
      });

      // Process streaming response
      for await (const event of queryInstance) {
        // Check for abort
        if (this.stopRequested) {
          console.log("Query aborted by user");
          break;
        }

        // Capture session_id from first message
        if (!this.sessionId && event.session_id) {
          this.sessionId = event.session_id;
          console.log(`GOT session_id: ${this.sessionId!.slice(0, 8)}...`);
          this.saveSession();
        }

        // Handle different message types
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            // Thinking blocks
            if (block.type === "thinking") {
              const thinkingText = block.thinking;
              if (thinkingText) {
                console.log(`THINKING BLOCK: ${thinkingText.slice(0, 100)}...`);
                // Level 0 keeps the server-side log and drops the Telegram
                // message — the record stays, the noise goes.
                if (verbose >= 1) {
                  await statusCallback("thinking", thinkingText);
                }
              }
            }

            // Tool use blocks
            if (block.type === "tool_use") {
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown>;

              // REPORTING ONLY. Prevention is the PreToolUse hook's job — see
              // buildSafetyHook() in security.ts, which denies the call before
              // it runs and hands the reason back to the model.
              //
              // This must not throw, and that is an ordering fact rather than a
              // preference: measured against SDK 0.3.233 the tool_use block
              // arrives in this stream BEFORE the hook fires. Throwing here
              // would abort the query while the hook is still pending, which is
              // exactly the old behaviour where one blocked call cost the user
              // the whole answer. For the same reason it cannot serve as a
              // fallback — it never runs second.
              //
              // What it is good for is telling the user why the model changed
              // course. Reported through "notice", never "tool": tool messages
              // are deleted on "done" and again by the catch blocks in text.ts
              // and media-group.ts, so a refusal sent as "tool" would vanish. A
              // refusal is not a progress update, and it is shown at every
              // VERBOSE_LEVEL including 0. Sub-agent calls reach this point too
              // (the SDK emits their tool_use blocks and nothing here filters
              // on parent_tool_use_id).
              const [toolSafe, toolNotice] = checkToolCallSafety(
                toolName,
                toolInput
              );
              if (!toolSafe) {
                console.warn(`BLOCKED: ${toolNotice}`);
                await statusCallback("notice", toolNotice);
                continue;
              }

              // Segment ends when tool starts
              if (currentSegmentText) {
                await statusCallback(
                  "segment_end",
                  currentSegmentText,
                  currentSegmentId
                );
                currentSegmentId++;
                currentSegmentText = "";
              }

              // Format and show tool status
              const toolDisplay = formatToolStatus(toolName, toolInput);
              this.currentTool = toolDisplay;
              this.lastTool = toolDisplay;
              console.log(`Tool: ${toolDisplay}`);

              // Don't show tool status for ask_user - the buttons are self-explanatory.
              // Level 0 drops the status line entirely; the BLOCKED/Access denied
              // messages above are NOT gated by the level — see VERBOSE_LEVEL in
              // config.ts for why.
              if (verbose >= 1 && !toolName.startsWith(ASK_USER_TOOL_PREFIX)) {
                await statusCallback("tool", toolDisplay);
              }

              // Check for pending ask_user requests after ask-user MCP tool
              if (toolName.startsWith(ASK_USER_TOOL_PREFIX) && ctx && chatId) {
                // Small delay to let MCP server write the file
                await new Promise((resolve) => setTimeout(resolve, 200));

                // Retry a few times in case of timing issues
                for (let attempt = 0; attempt < 3; attempt++) {
                  const buttonsSent = await checkPendingAskUserRequests(
                    ctx,
                    chatId
                  );
                  if (buttonsSent) {
                    askUserTriggered = true;
                    break;
                  }
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
              }
            }

            // Text content
            if (block.type === "text") {
              responseParts.push(block.text);
              currentSegmentText += block.text;

              // Stream text updates (throttled)
              const now = Date.now();
              if (
                now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                currentSegmentText.length > 20
              ) {
                await statusCallback(
                  "text",
                  currentSegmentText,
                  currentSegmentId
                );
                lastTextUpdate = now;
              }
            }
          }

          // Break out of event loop if ask_user was triggered
          if (askUserTriggered) {
            break;
          }
        }

        // Level 2: surface what the tools actually returned, not just that
        // they ran. Seeing a command's output is the difference between
        // "Bash ran" and knowing whether it worked.
        //
        // The Array.isArray guard is required, not defensive: on a user
        // message `message` is a MessageParam whose content is
        // `string | ContentBlockParam[]`, unlike the assistant branch above
        // where it is always an array. Iterating it unguarded does not
        // compile under strict mode.
        //
        // Filtering on tool_result also excludes replayed user prompts, which
        // arrive on this same message type but carry text blocks.
        if (verbose >= 2 && event.type === "user") {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type !== "tool_result") continue;

              const raw =
                typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content
                        .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
                        .join("")
                    : "";

              if (raw.trim()) {
                const preview =
                  raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
                // "notice" rather than "tool": tool results are exactly the
                // content that gets deleted on "done", and they carry raw
                // output with < and & that would break an unescaped HTML send.
                await statusCallback("notice", preview);
              }
            }
          }
        }

        // Result message
        if (event.type === "result") {
          console.log("Response complete");
          queryCompleted = true;

          // total_cost_usd is non-optional on both result variants, so no
          // presence test. Error results are recorded too when non-zero: a
          // turn that failed halfway still burned tokens.
          //
          // The SDK documents this figure as cumulative per query() call and
          // reset for resumed sessions. This bot calls query() once per
          // message with `resume`, so each result carries only that turn —
          // summing across calls is correct here. Summing across results
          // *within* one call would not be.
          turnCostUsd = event.total_cost_usd;

          // Capture usage if available
          if ("usage" in event && event.usage) {
            this.lastUsage = event.usage as TokenUsage;
            const u = this.lastUsage;
            console.log(
              `Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${
                u.cache_read_input_tokens || 0
              } cache_create=${u.cache_creation_input_tokens || 0}`
            );
          }

          // Level 2: what this turn cost, while the answer is still on screen.
          // /status has the monthly total; this is the per-turn figure that
          // makes the monthly one explicable.
          if (verbose >= 2) {
            const u = this.lastUsage;
            const secs = (event.duration_ms / 1000).toFixed(1);
            const tokens = u
              ? ` · in ${u.input_tokens} / out ${u.output_tokens} tokens`
              : "";
            await statusCallback(
              "notice",
              `${secs}s${tokens} · $${turnCostUsd.toFixed(4)}`
            );
          }
        }
      }

      // V1 query completes automatically when the generator ends
    } catch (error) {
      const errorStr = String(error).toLowerCase();
      const isCleanupError =
        errorStr.includes("cancel") || errorStr.includes("abort");

      if (
        isCleanupError &&
        (queryCompleted || askUserTriggered || this.stopRequested)
      ) {
        console.warn(`Suppressed post-completion error: ${error}`);
      } else {
        console.error(`Error in query: ${error}`);
        this.lastError = String(error).slice(0, 100);
        this.lastErrorTime = new Date();
        throw error;
      }
    } finally {
      this.isQueryRunning = false;
      this.abortController = null;
      this.queryStarted = null;
      this.currentTool = null;

      // Booked here rather than in the result branch so a turn that throws
      // after the result still gets charged.
      //
      // KNOWN HOLE, not a footnote: total_cost_usd exists only on the result
      // event, and four paths leave the loop before it arrives — the ask_user
      // hand-off, an explicit /stop, a `!` interrupt, and a tool call blocked
      // by the checks above. All four consumed real tokens and all four book
      // zero. Someone who works entirely through inline buttons, or who
      // routinely interrupts long turns, never approaches the ceiling.
      //
      // The remedy is known and deliberately not taken here: the SDK's own
      // maxBudgetUsd enforces mid-query, so it would also close the unbounded
      // single-turn overshoot (this gate only checks *before* a turn, so one
      // turn can exceed the limit by any amount). It needs its own handling of
      // the error_max_budget_usd result subtype — otherwise alert-socket.ts
      // would file an aborted turn as a completed one — and so belongs in a
      // change of its own rather than bolted onto this one.
      addUserCost(billTo, turnCostUsd);
      // Clean up context files to prevent cross-session leaks (SEC-004, SEC-F7)
      for (const f of [contextFile, genericContextFile]) {
        try {
          unlinkSync(f);
        } catch {
          // File may already be deleted
        }
      }
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // If ask_user was triggered, return early - user will respond via button
    if (askUserTriggered) {
      await statusCallback("done", "");
      return "[Waiting for user selection]";
    }

    // Emit final segment
    if (currentSegmentText) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    await statusCallback("done", "");

    return responseParts.join("") || "No response from Claude.";
  }

  /**
   * Kill the current session (clear session_id).
   */
  async kill(): Promise<void> {
    this.sessionId = null;
    this._userId = null;
    this.lastActivity = null;
    this.conversationTitle = null;
    console.log("Session cleared");
  }

  /**
   * Save session to disk for resume after restart.
   * Saves to multi-session history format.
   */
  saveSession(): void {
    if (!this.sessionId || !this._userId) return;

    try {
      // Load existing session history
      const history = this.loadSessionHistory();

      // Create new session entry
      const newSession: SavedSession = {
        session_id: this.sessionId,
        user_id: this._userId,
        saved_at: new Date().toISOString(),
        working_dir: WORKING_DIR,
        title: this.conversationTitle || "Sitzung ohne Titel",
      };

      // Remove any existing entry with same session_id (update in place)
      const existingIndex = history.sessions.findIndex(
        (s) => s.session_id === this.sessionId
      );
      if (existingIndex !== -1) {
        history.sessions[existingIndex] = newSession;
      } else {
        // Add new session at the beginning
        history.sessions.unshift(newSession);
      }

      // Keep only the last MAX_SESSIONS
      history.sessions = history.sessions.slice(0, MAX_SESSIONS);

      // Save
      Bun.write(SESSION_FILE, JSON.stringify(history, null, 2));
      console.log(`Session saved to ${SESSION_FILE}`);
    } catch (error) {
      console.warn(`Failed to save session: ${error}`);
    }
  }

  /**
   * Load session history from disk.
   */
  private loadSessionHistory(): SessionHistory {
    try {
      const file = Bun.file(SESSION_FILE);
      if (!file.size) {
        return { sessions: [] };
      }

      const text = readFileSync(SESSION_FILE, "utf-8");
      return JSON.parse(text) as SessionHistory;
    } catch {
      return { sessions: [] };
    }
  }

  /**
   * Get list of saved sessions for display.
   */
  getSessionList(userId: number): SavedSession[] {
    const history = this.loadSessionHistory();
    // Filter to only sessions for current working directory and user
    return history.sessions.filter(
      (s) =>
        s.user_id === userId &&
        (!s.working_dir || s.working_dir === WORKING_DIR)
    );
  }

  /**
   * Resume a specific session by ID.
   */
  resumeSession(
    sessionId: string,
    userId: number
  ): [success: boolean, message: string] {
    const history = this.loadSessionHistory();
    const sessionData = history.sessions.find((s) => s.session_id === sessionId);

    if (!sessionData) {
      return [false, "Sitzung nicht gefunden"];
    }

    if (sessionData.user_id !== userId) {
      return [false, "Sitzung nicht gefunden"];
    }

    if (sessionData.working_dir && sessionData.working_dir !== WORKING_DIR) {
      return [false, "Sitzung gehoert zu einem anderen Arbeitsverzeichnis"];
    }

    this.sessionId = sessionData.session_id;
    this.conversationTitle = sessionData.title;
    this.lastActivity = new Date();

    console.log(
      `Resumed session ${sessionData.session_id.slice(0, 8)}... - "${sessionData.title}"`
    );

    return [
      true,
      `Sitzung fortgesetzt: "${sessionData.title}"`,
    ];
  }

  /**
   * Resume the last persisted session (legacy method, now resumes most recent).
   */
  resumeLast(userId: number): [success: boolean, message: string] {
    const sessions = this.getSessionList(userId);
    if (sessions.length === 0) {
      return [false, "Keine gespeicherten Sitzungen"];
    }

    return this.resumeSession(sessions[0]!.session_id, userId);
  }
}

// Per-user session instances (H2: multi-user isolation)
const sessions = new Map<number, ClaudeSession>();

/**
 * Get or create a session for a specific user.
 */
export function getSession(userId: number): ClaudeSession {
  let userSession = sessions.get(userId);
  if (!userSession) {
    userSession = new ClaudeSession();
    sessions.set(userId, userSession);
  }
  return userSession;
}
