#!/usr/bin/env bun
/**
 * Ask User MCP Server - Presents options as Telegram inline keyboard buttons.
 *
 * When Claude calls ask_user(), this server writes a request file that the
 * Telegram bot monitors. The bot then displays inline keyboard buttons.
 * When the user clicks, their choice is injected back to Claude.
 *
 * Uses the official MCP TypeScript SDK for proper protocol compliance.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Handshake directory shared with the bot, derived from BOT_ID exactly as
 * src/config.ts derives ASK_USER_DIR. Both must produce the same path or the
 * button flow silently stops working: this process writes request files the
 * bot never finds.
 *
 * Recomputed here instead of imported, because importing src/config.ts would
 * run its startup validation — and src/index.ts strips TELEGRAM_BOT_TOKEN from
 * the environment this subprocess inherits, so that import would exit(1).
 */
const HOME_DIR = process.env.HOME || "/tmp";
const BOT_ID = (process.env.BOT_ID || "cc-telegram-bot").trim();
const ASK_USER_DIR = `${HOME_DIR}/.${BOT_ID}/ask-user`;

/**
 * Telegram user this spawn belongs to, injected per query() by
 * mcpServersForUser() in src/config.ts. Empty when the bot is older than
 * v1.3.1 or when ask-user is not the server key it expects.
 *
 * Decides which context file to read. Without it the only choice was the
 * shared query-context.json, which two simultaneous users overwrite for each
 * other — the per-user file existed but nothing read it.
 */
const ASK_USER_USER_ID = (process.env.ASK_USER_USER_ID || "").trim();

// Create the MCP server
const server = new Server(
  {
    name: "ask-user",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ask_user",
        description:
          "Present options to the user as tappable inline buttons in Telegram. IMPORTANT: After calling this tool, STOP and wait. Do NOT add any text after calling this tool - the user will tap a button and their choice becomes their next message. Just call the tool and end your turn.",
        inputSchema: {
          type: "object" as const,
          properties: {
            question: {
              type: "string",
              description: "The question to ask the user",
            },
            options: {
              type: "array",
              items: { type: "string" },
              description:
                "List of options for the user to choose from (2-6 options recommended)",
              minItems: 2,
              maxItems: 10,
            },
          },
          required: ["question", "options"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "ask_user") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args = request.params.arguments as {
    question?: string;
    options?: string[];
  };

  const question = args.question || "";
  const options = args.options || [];

  if (!question || !options || options.length < 2) {
    throw new Error("question and at least 2 options required");
  }

  // Generate request ID and read chat context from file (SEC-004)
  const requestUuid = crypto.randomUUID().slice(0, 8);
  const { readFileSync, mkdirSync, chmodSync } = await import("fs");

  // Per-user file first, shared file only as the fallback for a bot that did
  // not inject the ID. Reading the shared file when a per-user one is
  // addressable is what delivered buttons to the wrong chat.
  const contextCandidates = ASK_USER_USER_ID
    ? [
        `${ASK_USER_DIR}/query-context-${ASK_USER_USER_ID}.json`,
        `${ASK_USER_DIR}/query-context.json`,
      ]
    : [`${ASK_USER_DIR}/query-context.json`];

  let chatId = "";
  let userId = "";
  let contextSource = "";
  for (const candidate of contextCandidates) {
    try {
      const contextData = JSON.parse(readFileSync(candidate, "utf-8"));
      chatId = String(contextData.chat_id || "");
      userId = String(contextData.user_id || "");
      contextSource = candidate;
      break;
    } catch {
      // Try the next candidate; only report if none of them worked.
    }
  }
  if (!contextSource) {
    console.error(
      `Failed to read query context, tried: ${contextCandidates.join(", ")}`
    );
  }

  // Use restricted directory for request files (H3: security hardening)
  const askUserDir = ASK_USER_DIR;
  try {
    mkdirSync(askUserDir, { recursive: true });
    chmodSync(askUserDir, 0o700);
  } catch {
    // Directory may already exist
  }

  // Write request file for the bot to pick up
  const requestData = {
    request_id: requestUuid,
    question,
    options,
    status: "pending",
    chat_id: chatId,
    user_id: userId,
    created_at: new Date().toISOString(),
  };

  const requestFile = `${askUserDir}/ask-user-${requestUuid}.json`;
  await Bun.write(requestFile, JSON.stringify(requestData, null, 2));

  return {
    content: [
      {
        type: "text" as const,
        text: "[Buttons sent to user. STOP HERE - do not output any more text. Wait for user to tap a button.]",
      },
    ],
  };
});

// Run the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Ask User MCP server running on stdio");
}

main().catch(console.error);
