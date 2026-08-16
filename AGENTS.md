# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run start      # Run the bot
bun run dev        # Run with auto-reload (--watch)
bun run typecheck  # Run TypeScript type checking
bun install        # Install dependencies
```

## Architecture

This is a Telegram bot (~6,800 lines TypeScript) that lets you control Claude Code from your phone via text, voice, photos, and documents. Built with Bun and grammY.

### Message Flow

```
Telegram message -> Handler -> Auth check -> Rate limit -> Claude session -> Streaming response -> Output redaction -> Audit log
Alert socket -> Zod validation -> Secret check -> Rate limit -> Alert queue -> Claude session -> Output redaction -> Telegram group
```

### Key Modules

- **`src/index.ts`** -- Entry point, registers handlers, starts polling, environment isolation (Layer 16)
- **`src/config.ts`** -- Environment parsing, MCP loading, safety prompts, blocked command patterns
- **`src/session.ts`** -- `ClaudeSession` class wrapping Agent SDK with streaming, session persistence, and defense-in-depth safety checks (path validation and tool allow/deny checks on tool calls)
- **`src/security.ts`** -- `RateLimiter` (token bucket), `isPathAllowed()`, `checkCommandSafety()` (regex patterns), `isToolAllowed()`, `stripToolWildcards()`, `isAuthorized()`
- **`src/alert-socket.ts`** -- Unix socket listener for system alerts, alert prompts, EOD report generation
- **`src/alert-db.ts`** -- SQLite store (`bun:sqlite`, WAL mode, prepared statements, 0o600): alert history, plus the connection shared with `cost.ts`
- **`src/cost.ts`** -- Per-user cost accounting (`user_costs` table keyed by user and `YYYY-MM` period), `CostLimitError`
- **`src/formatting.ts`** -- Markdown to HTML conversion for Telegram, tool status formatting
- **`src/utils.ts`** -- Audit logging (HMAC-SHA256), voice transcription (local whisper-cli), typing indicators, output redaction, log sanitization (console wrapper)
- **`src/types.ts`** -- Shared TypeScript types

### Handlers (`src/handlers/`)

Each message type has a dedicated async handler:
- **`commands.ts`** -- `/start`, `/new`, `/stop`, `/status`, `/resume`, `/restart`, `/retry`, `/model` (`/m`), `/verbose`, `/alert`
- **`text.ts`** -- Text messages with input length validation
- **`voice.ts`** -- Voice to text via local whisper-cli, then same flow as text
- **`audio.ts`** -- Audio file transcription via local whisper-cli (mp3, m4a, ogg, wav, etc.)
- **`photo.ts`** -- Image analysis with media group buffering (1s timeout for albums)
- **`document.ts`** -- PDF extraction (pdftotext CLI), text files, archives, routes audio files to audio.ts
- **`video.ts`** -- Video messages and video notes
- **`callback.ts`** -- Inline keyboard button handling for ask_user MCP
- **`streaming.ts`** -- Shared `StreamingState` and status callback factory, output redaction
- **`media-group.ts`** -- Media group buffering for photo albums

### Security Layers (all 24)

1. User allowlist (`TELEGRAM_ALLOWED_USERS`)
2. Rate limiting (token bucket, configurable)
3. Input length validation (4096 chars)
4. Path validation (`ALLOWED_PATHS`, symlink resolution)
5. Command blocklist -- string patterns (30+)
6. Command blocklist -- regex patterns (40+)
7. File operation path check (Read/Write/Edit/Glob/Grep)
8. Safety system prompt (7 anti-injection rules)
9. Content delimiters (`user_document`/`user_caption`/`alert_data` tags)
10. Secret redaction in audit logs
11. Audit logging (JSON, append-only, 0o600)
12. Session isolation (per-user)
13. File permission hardening (data dir 0o700)
14. Output redaction (all Telegram messages)
15. Env-dump blocklist (printenv/env/export -p/declare)
16. Environment isolation (7 env vars deleted from process.env)
17. Log sanitization (console wrapper)
18. Audit log integrity (HMAC-SHA256 + rotation)
19. Alert content tags (`<alert_data>` + spoofed prefix stripping)
20. Alert rate limiting (10/minute sliding window)
21. Alert payload validation (Zod schema)
22. Alert queue (bounded, max 20, FIFO drain)
23. Per-user context files (MCP context scoped per user ID)
24. Scripting language blocklist (python/node/ruby/perl env access + /proc)

### Configuration

All config via `.env` (copy from `.env.example`). Key variables:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` (required)
- `TELEGRAM_ALLOWED_GROUPS` -- Whitelisted group IDs for group chat support
- `CLAUDE_WORKING_DIR` -- Working directory for Claude
- `ALLOWED_PATHS` -- Directories Claude can access
- `ALLOWED_TOOLS`, `DISALLOWED_TOOLS` -- Tool allow/deny lists (both empty by default; see the Tool Control section in `README.md`)
- `COST_LIMIT_USD` -- Cumulative USD ceiling per user and calendar month (unset = unlimited)
- `VERBOSE_LEVEL` -- Streaming verbosity `0`/`1`/`2` (default `1`); per-user override via `/verbose`
- `ALERT_SOCKET_PATH`, `ALERT_SOCKET_SECRET` -- Alert socket configuration
- `DOCS_DIR` -- Directory scanned for existing documentation during alert handling
- `WHISPER_MODE` -- Voice transcription mode (`local` or `off`)
- `AUDIT_LOG_HMAC_KEY` -- HMAC key for audit log integrity

MCP servers defined in `mcp-config.ts`.

### Runtime Files

All runtime paths derive from `BOT_ID` (default `cc-telegram-bot`), so several
instances can coexist on one machine:

- `~/.<BOT_ID>/sessions.json` -- Session persistence for `/resume`
- `~/.<BOT_ID>/audit.log` -- Audit log (configurable via `AUDIT_LOG_PATH`)
- `~/.<BOT_ID>/alerts.db` -- Alert history and per-user cost totals (configurable via `ALERT_DB_PATH`)
- `/tmp/<BOT_ID>/` -- Downloaded photos/documents (cleaned up automatically)
- `/run/<BOT_ID>/alerts.sock` -- Alert socket (configurable via `ALERT_SOCKET_PATH`)

## Patterns

**Adding a command**: Create handler in `commands.ts`, register in `index.ts` with `bot.command("name", handler)`.

**Adding a message handler**: Create in `handlers/`, export from `index.ts`, register in `index.ts` with appropriate filter.

**Streaming pattern**: All handlers use `createStatusCallback()` from `streaming.ts` and `session.sendMessageStreaming()` for live updates.

**Type checking**: Run `bun run typecheck` periodically while editing TypeScript files. Fix any type errors before committing.

**After code changes**: Restart the bot so changes can be tested (`bun run start`).

### External Dependencies

PDF extraction uses `pdftotext` CLI instead of an npm package:

```bash
brew install poppler   # macOS
sudo apt install poppler-utils   # Debian/Ubuntu
```

### PATH Requirements

When running as a LaunchAgent (macOS), the PATH may not include Homebrew. The config ensures PATH includes:
- `/opt/homebrew/bin` (Apple Silicon Homebrew)
- `/usr/local/bin` (Intel Homebrew)

Without this, `pdftotext` and `whisper-cli` won't be found.

## Commit Style

Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `perf:`

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.
