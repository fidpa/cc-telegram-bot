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

This is a Telegram bot (~5,900 lines TypeScript) that lets you control Claude Code from your phone via text, voice, photos, and documents. Built with Bun and grammY.

### Message Flow

```
Telegram message -> Handler -> Auth check -> Rate limit -> Claude session -> Streaming response -> Output redaction -> Audit log
Alert socket -> Zod validation -> Secret check -> Rate limit -> Alert queue -> Claude session -> Output redaction -> Telegram group
```

### Key Modules

- **`src/index.ts`** -- Entry point, registers handlers, starts polling, environment isolation (Layer 16)
- **`src/config.ts`** -- Environment parsing, MCP loading, safety prompts, blocked command patterns
- **`src/session.ts`** -- `ClaudeSession` class wrapping Agent SDK with streaming, session persistence, and defense-in-depth safety checks (path validation on tool calls)
- **`src/security.ts`** -- `RateLimiter` (token bucket), `isPathAllowed()`, `checkCommandSafety()` (regex patterns), `isAuthorized()`
- **`src/alert-socket.ts`** -- Unix socket listener for system alerts, alert prompts, EOD report generation
- **`src/alert-db.ts`** -- SQLite alert history store (`bun:sqlite`, WAL mode, prepared statements, 0o600)
- **`src/formatting.ts`** -- Markdown to HTML conversion for Telegram, tool status formatting
- **`src/utils.ts`** -- Audit logging (HMAC-SHA256), voice transcription (local whisper-cli), typing indicators, output redaction, log sanitization (console wrapper)
- **`src/types.ts`** -- Shared TypeScript types

### Handlers (`src/handlers/`)

Each message type has a dedicated async handler:
- **`commands.ts`** -- `/start`, `/new`, `/stop`, `/status`, `/resume`, `/restart`, `/retry`, `/model` (`/m`), `/alert`
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
- `ALERT_SOCKET_PATH`, `ALERT_SOCKET_SECRET` -- Alert socket configuration
- `WHISPER_MODE` -- Voice transcription mode (`local` or `off`)
- `AUDIT_LOG_HMAC_KEY` -- HMAC key for audit log integrity

MCP servers defined in `mcp-config.ts`.

### Runtime Files

- `~/.cc-telegram-bot/sessions.json` -- Session persistence for `/resume`
- `~/.cc-telegram-bot/audit.log` -- Audit log (configurable via `AUDIT_LOG_PATH`)
- `/tmp/telegram-bot/` -- Downloaded photos/documents (cleaned up automatically)

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
