# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-08-16

### Added
- `ALLOWED_TOOLS` and `DISALLOWED_TOOLS` (both empty by default). Until now the bot
  passed no tool restriction to the Agent SDK at all while running with
  `permissionMode: "bypassPermissions"`: `ALLOWED_PATHS` bounded where Claude could
  work, nothing bounded what it could do there, so a fork pointed at a documentation
  repository had no way to make it read-only. The lists are handed to the SDK as `tools`
  and `disallowedTools`. The similarly named `allowedTools` option is deliberately not
  used -- it is an auto-approve list for permission prompts and enforces nothing under
  `bypassPermissions`. Leaving both unset keeps the previous behaviour exactly
- `COST_LIMIT_USD` (unset by default = unlimited). Cumulative spend per Telegram user
  and calendar month, persisted in the existing SQLite database (`ALERT_DB_PATH`, new
  `user_costs` table) so it survives restarts. `sessions.json` was the other candidate
  and lost on one point: `loadSessionHistory()` swallows parse errors and returns an
  empty history, so a corrupted file would have silently reset the budget to zero.
  The period (`YYYY-MM`, local time) is part of the primary key, so the monthly reset
  needs no scheduled job that could fail to run. Exceeding the limit produces an
  explicit message naming the amount, the ceiling and the reset, not a silent refusal
- `VERBOSE_LEVEL` (default `1` = previous behaviour) and a `/verbose` command. The bot
  streamed every tool call and every reasoning fragment unconditionally, which is the
  point for system administration and a wall of noise for anything else. `0` shows the
  final answer only, `1` keeps thinking previews and tool status, `2` adds tool results
  and a closing line with duration, tokens and cost. The per-user override is held in
  memory on the session exactly like the `/model` override: it survives `/new`, is lost
  on restart, and then falls back to the environment default
- Cumulative monthly cost is shown in `/status`, with the ceiling and percentage when
  one is configured. Shown regardless of whether a limit is set, because picking a
  sensible ceiling requires seeing the number first

### Changed
- Blocked tool calls, blocked commands and denied paths are now reported through a new
  `notice` status type instead of the ephemeral `tool` type. Refusals were pushed onto
  the same message list that is deleted when a turn ends, and deleted again by the error
  handlers in `text.ts`/`media-group.ts`, so the user saw only the generic error and
  never the reason. On the alert path they were not delivered at all, because
  `createAlertStatusCallback` implements `tool`/`segment_end`/`done` and nothing else
- Those refusal messages are reported at every verbose level, including `0`. They look
  like status updates but are the only explanation a user gets for a refused request;
  gating them would have turned a noise setting into a security setting and quietly
  undone the tool control above
- `/alert` now bills the person who typed it, not the alert session. The alert session
  (synthetic user ID 0) is exempt from the cost ceiling on purpose, because a budget
  must never be able to silence system monitoring, and without this attribution a user
  who had hit their limit could have kept working through `/alert` on that exemption
- Tool-call safety checks moved from `session.ts` into `checkToolCallSafety()` in
  `security.ts`. Adding three features to `sendMessageStreaming()` had pushed
  `session.ts` past the 800-line limit in `CONTRIBUTING.md`; the checks are questions
  about safety and belong in that module. No behaviour change
- `README.md` is titled "Claude Code Telegram Bot" instead of the repository slug
  `cc-telegram-bot`, which said what the directory is called rather than what the
  project does

### Fixed
- `README.md` and `AGENTS.md` claimed "~5,900 lines TypeScript". Measured across `src/`
  and `ask_user_mcp/`: 6,838. The figure had been drifting since before v1.2.0

### Security
- `docs/security-limitations.md` and `SECURITY.md` corrected: restricting tool usage was
  documented as "not implemented" and as something to do "via the system prompt". Both
  are now env-configurable and SDK-enforced
- `docs/security-limitations.md` claimed "there is no SDK-level hook to intercept
  sub-agent tool calls". That is not true of Agent SDK 0.3.233 and the claim has been
  removed rather than carried forward: a `PreToolUse` hook fires before execution and
  inside sub-agents (`HookInput.agent_id` exists to tell them apart), and it is what the
  SDK recommends for gating under `bypassPermissions`, while `canUseTool` is
  auto-approved past and never consulted. No hook is installed here; that reworks the
  permission path and belongs in its own change. What the bot's runtime check does and
  does not do is now stated precisely: it detects after dispatch, sub-agent calls
  included, and never prevents
- Known holes in cost accounting, stated plainly rather than buried: automatic socket
  alerts are exempt from the ceiling by design (see above); `total_cost_usd` is only
  emitted on the result event, so the four paths that leave the stream earlier (the
  inline-keyboard hand-off, `/stop`, a `!` interrupt, and a tool call blocked by the
  checks) consume real tokens and book zero; and because the ceiling is checked before
  a turn rather than during it, a single turn can exceed it by any amount. The SDK's
  `maxBudgetUsd` would close the latter two, but needs its own handling of the
  `error_max_budget_usd` result subtype and is therefore left to a separate change
- `user_costs` is created with `CREATE TABLE IF NOT EXISTS` and there is no migration
  mechanism, matching the existing `alerts` table. Adding a column later will not happen
  by itself on databases that already exist. Reverting leaves the table in place, which
  is harmless, because older code never reads it
- Tool control is intentionally **not** counted as a 25th security layer. The 24 numbered
  layers describe what protects an operator who changed no configuration, and these lists
  are empty until someone fills them in. A future security audit may reasonably take tool
  control up as Layer 25 once it has been reviewed as one; `docs/SECURITY_AUDIT_REPORT.md`
  is a dated document and has been left untouched

## [1.2.3] - 2026-08-16

### Added
- `BOT_ID` (default `cc-telegram-bot`). Every per-instance path now derives from it:
  `~/<.BOT_ID>/` (sessions, audit log, alert database), `/tmp/<BOT_ID>/` (downloaded
  media) and `/run/<BOT_ID>/alerts.sock`. Validated as a single path segment at startup,
  so a value like `../../etc` aborts instead of escaping into the filesystem
- `BOT_PERSONA` (default unchanged). The one-line role description at the top of the
  system prompt is now configurable; the detailed personality stays in `CLAUDE.md`
  inside `CLAUDE_WORKING_DIR`

### Fixed
- Two instances of this bot on one machine silently shared state. The data directory
  (`~/.cc-telegram-bot`) and temp directory (`/tmp/telegram-bot`) were hardcoded, so both
  wrote the same `sessions.json` — last write won, and a conversation could surface in the
  wrong bot. Set a distinct `BOT_ID` per instance
- The alert rules (7 through 12, roughly half the safety prompt) were emitted
  unconditionally, including in bots with no alerting. They now follow the same gate as
  the runtime — the alert socket only starts when a group is whitelisted (`src/index.ts`),
  so the rules only appear when `TELEGRAM_ALLOWED_GROUPS` is set. Without alerts the
  prompt drops from 4097 to 2181 characters, and the bot no longer carries instructions
  to scan `DOCS_DIR` and await `/alert` approval for a subsystem that never runs
- The persona line was hardcoded as "You are a Claude-powered Telegram admin bot". A bot
  built on this code for any other purpose carried a contradictory role statement that
  outranked its own `CLAUDE.md`, because the system prompt wins

### Changed
- Claude Agent SDK 0.3.215 -> 0.3.233, MCP SDK 1.29.0 -> 1.30.0, TypeScript `^5` -> `^5.9.3`

## [1.2.2] - 2026-08-12

### Fixed
- `scripts/trigger-eod-report.sh` shipped without the executable bit since v1.0.0.
  Running it directly (`./scripts/trigger-eod-report.sh`) failed with
  "Permission denied"; it only worked when invoked as `bash scripts/trigger-eod-report.sh`

## [1.2.1] - 2026-08-08

### Added
- Continuous integration (`.github/workflows/lint.yml`). The repository had no CI at all
  until now -- every check ran locally or not at all. On push and pull request it runs:
  typecheck (`bun install --frozen-lockfile` + `bun run typecheck`), ShellCheck on the two
  shell scripts, an XML parse of the LaunchAgent template, three configuration-documentation
  gates, a relative-link check across all Markdown, a changelog link-definition check,
  and gitleaks over the full history
- `CLAUDE_CODE_PATH` documented in `.env.example` and `README.md`. It sets the Claude Code
  executable handed to the Agent SDK (`src/session.ts`) and is needed for standalone builds
- `DOCS_DIR` documented in `.env.example` and `README.md`. Claude scans this directory for
  existing documentation before diagnosing an alert (`src/config.ts`); default `~/Documents/docs`

### Fixed
- `CLAUDE_CODE_PATH` and `DOCS_DIR` were configurable in code but appeared in no
  documentation -- they were findable only by reading the source
- README configuration table completed: `CLAUDE_CLI_PATH`, `WHISPER_CLI_PATH`,
  `AUDIT_LOG_MAX_SIZE` and `AUDIT_LOG_MAX_FILES` were documented in `.env.example`
  but missing from the table
- Changelog link definitions: the `[1.2.0]` compare link was never added in the 1.2.0
  release, which also left `[Unreleased]` comparing against `v1.1.0` -- one release too
  far back. Both corrected, and the check is now part of CI

### Changed
- `.gitignore` now covers local agent tooling (`.claude/`) and further private note formats
  (`REDDIT_POST.md`, `TODO.md`, `NOTES.md`). `CLAUDE.md` stays versioned on purpose: it is
  the shipped example system prompt, documented in `README.md` and `CONTRIBUTING.md`

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

[Unreleased]: https://github.com/fidpa/cc-telegram-bot/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/fidpa/cc-telegram-bot/compare/v1.2.3...v1.3.0
[1.2.3]: https://github.com/fidpa/cc-telegram-bot/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/fidpa/cc-telegram-bot/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/fidpa/cc-telegram-bot/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/fidpa/cc-telegram-bot/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/fidpa/cc-telegram-bot/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/fidpa/cc-telegram-bot/releases/tag/v1.0.0
