# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Alert History Store: SQLite database persists every incoming alert (`~/.cc-telegram-bot/alerts.db`)
- MTTR tracking: `processed_at` and `claude_response_length` recorded after Claude responds
- `ALERT_DB_PATH` environment variable for configurable database location
- WAL mode for concurrent reads during bot operation
- Indexes on `received_at` and `type` for analytics queries
- Query examples in docs/EXAMPLES.md (top alerts, MTTR, daily breakdown)

### Security
- Alert secrets stripped before database insertion (defense-in-depth)
- Database file created with 0o600 permissions (owner-only access)
- Prepared statements cached at init (parameterized queries, no SQL injection surface)

## [1.1.0] - 2026-02-16

### Added
- Alert socket: Unix domain socket for automated system alerts from monitoring scripts
- Group chat support: whitelisted groups with @mention or reply-to-bot activation
- `/alert` command: interactive access to the daily alert session
- EOD report generation: daily summaries via systemd timer
- 6 new security layers (19-24), bringing total to 24 defense-in-depth layers

### Security
- SEC-F1: Alert payloads wrapped in `<alert_data>` content tags (prompt injection defense)
- SEC-F2: 11 new regex patterns blocking scripting language env access and /proc filesystem
- SEC-F3: Alert rate limiting (10/minute sliding window)
- SEC-F4: Startup warning when ALERT_SOCKET_SECRET is not configured
- SEC-F5: Generic error messages to Telegram (no internal details leaked)
- SEC-F6: TEMP_PATHS narrowed from `/tmp/` to `/tmp/telegram-bot/`
- SEC-F7: Per-user MCP context files (prevents cross-user race condition)
- SEC-F8: Zod runtime validation for alert payloads (replaces bare type assertion)
- SEC-F9: Extended environment isolation (7 env vars deleted, up from 2)
- SEC-F11: Bounded alert queue (max 20) replacing 60s wait-and-drop

### Changed
- Security layer count: 18 -> 24
- Regex blocklist patterns: 30+ -> 40+
- Safety system prompt: 5 rules -> 7 rules (added alert safety)
- Environment isolation: 2 vars deleted -> 7 vars deleted

## [1.0.0] - 2026-02-16

### Added
- Security audit with 7 findings (0C, 2H, 1M, 4L), all addressed
- 18 security hardening layers (defense-in-depth)
- Credential leak prevention (blocklist + env isolation + output redaction)
- HMAC-SHA256 audit log integrity with rotation
- Log sanitization (console wrapper)
- Environment isolation (secrets stripped from process.env)
- Multi-modal input (text, voice, photo, document, video)
- Streaming responses with live updates
- Session management with persistence
- Extended thinking (keyword-triggered)
- MCP server integration
- Local voice transcription (whisper.cpp)
- macOS LaunchAgent for always-on operation
- Model switching (/model command)

### Based on
- [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot) (MIT License)
- Core architecture: grammY Telegram bot, Claude Agent SDK integration, streaming responses, multi-modal input (text, voice, photo, document, video), MCP support

[Unreleased]: https://github.com/fidpa/cc-telegram-bot/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/fidpa/cc-telegram-bot/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/fidpa/cc-telegram-bot/releases/tag/v1.0.0
