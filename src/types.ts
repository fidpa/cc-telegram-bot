/**
 * Shared TypeScript types for the Claude Telegram Bot.
 */

import type { Context } from "grammy";
import type { Message } from "grammy/types";

// Status callback for streaming updates
//
// "notice" is the channel for messages that are neither Claude's answer nor
// transient progress: a blocked tool call, a refused request, a closing stats
// line. It exists because "tool" was the only alternative, and "tool" messages
// are deleted on "done" (streaming.ts) or dropped entirely on the alert path
// (alert-socket.ts only implements tool/segment_end/done). A blocked tool call
// that vanishes before it is read is indistinguishable from one that never
// happened. Every StatusCallback implementation MUST handle "notice" and MUST
// NOT put the message on the ephemeral cleanup list.
export type StatusCallback = (
  type: "thinking" | "tool" | "text" | "segment_end" | "done" | "notice",
  content: string,
  segmentId?: number
) => Promise<void>;

// Rate limit bucket for token bucket algorithm
export interface RateLimitBucket {
  tokens: number;
  lastUpdate: number;
}

// Session persistence
export interface SavedSession {
  session_id: string;
  user_id: number;
  saved_at: string;
  working_dir: string;
  title: string; // First message truncated (max ~50 chars)
}

export interface SessionHistory {
  sessions: SavedSession[];
}

// Token usage from Claude
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// MCP server configuration types
export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

// Audit log event types
export type AuditEventType =
  | "message"
  | "auth"
  | "tool_use"
  | "error"
  | "rate_limit";

export interface AuditEvent {
  timestamp: string;
  event: AuditEventType;
  user_id: number;
  username?: string;
  [key: string]: unknown;
}

// Pending media group for buffering albums
export interface PendingMediaGroup {
  items: string[];
  ctx: Context;
  caption?: string;
  statusMsg?: Message;
  timeout: Timer;
}

// Bot context with optional message
export type BotContext = Context;
