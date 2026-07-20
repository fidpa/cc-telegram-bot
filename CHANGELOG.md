# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-07-20

### Changed
- Claude Agent SDK updated to 0.3.215. The lockfile still pinned 0.1.77 even though
  `package.json` already declared `^0.3.158` -- no install had been run after the bump
- Dependencies updated: grammY 1.40.0 -> 1.45.1, MCP SDK 1.26.0 -> 1.29.0, zod 4.3.6 -> 4.4.3
- Thinking control migrated from the deprecated `maxThinkingTokens` to `thinking` + `effort`.
  The three levels are distinguishable again: `off` -> `thinking: disabled`,
  `normal` -> adaptive + `effort: "high"`, `deep` -> adaptive + `effort: "max"`.
  Current models only honoured `maxThinkingTokens` as on/off, which made `deep` (50k)
  behave identically to `normal` (10k)
- Model IDs raised to the current generation: default `claude-sonnet-4-6` -> `claude-sonnet-5`,
  `/model` shortcut `s` -> `claude-sonnet-5`, `o` -> `claude-opus-4-8` (was `claude-opus-4-6`)

### Fixed
- `bun run typecheck` was not runnable: `typescript` was declared only under
  `peerDependencies` and therefore never installed -- now a `devDependency`
- Added `"types": ["bun"]` to `tsconfig.json`; without it the type check failed with
  ~35 `Cannot find name 'Bun'` errors
- `package.json` version had drifted from the changelog (it still read `1.0.0` after the
  1.1.0 release) and is now kept in sync with the released version
- Documented default model in `README.md` and `.env.example` realigned with the code
  (both still named `claude-sonnet-4-5`)
- The `/model` error branch in `commands.ts` still listed Sonnet 4.5 / Opus 4.6
- Dead link in `README.md`: the Agent SDK docs returned 404
  (`docs.anthropic.com/en/docs/build-with-claude/agent-sdk` -> `code.claude.com/docs/en/agent-sdk`)
- `AGENTS.md` referenced non-existent functions `isCommandSafe()` / `isUserAuthorized()`
  (actual: `checkCommandSafety()` / `isAuthorized()`) and did not list `src/alert-db.ts`
- `THINKING_DEEP_KEYWORDS` was documented as "50k tokens" in `README.md` / `.env.example`,
  which no longer applies after the thinking migration (now `effort: max`)
- `systemd/` was missing from the architecture tree in `README.md` and `CONTRIBUTING.md`
- Size claim "~3,500 lines TypeScript" in `README.md` / `AGENTS.md` corrected to the
  actual figure (~5,900 lines)

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
