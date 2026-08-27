# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.4] - 2026-08-27: Release notes describe the tag they are published under

Every entry in this file was rewritten to lead with what changed for an operator, and two
sections were found to describe something other than the tag they sit under. The `[1.1.0]`
section listed the alert socket, group chat support, the `/alert` command, the EOD report
and "6 new security layers (19-24)". None of that was released by `v1.1.0`: the section was
already present in the `v1.0.0` commit (`git show v1.0.0:CHANGELOG.md`), `git diff v1.0.0
v1.1.0 -- CHANGELOG.md` is empty, and `src/alert-socket.ts`, `src/alert-db.ts` and the
24-row layer table in `README.md` all exist at `v1.0.0`. Both sections described the state
of the private predecessor, filed under public tags.

No tag was moved and no released code changed. This is a documentation release.

### Fixed

- **The `[1.1.0]` section now describes what the `v1.1.0` tag shipped.** Reconstructed from
  the published release body, which had it right all along, and verified against `git diff
  v1.0.0 v1.1.0`: four files, none of them the alert socket. What the section listed before
  is preserved in `[1.0.0]`, where it belongs, marked as predecessor history
- **The `[1.0.0]` section said 18 security layers where the release shipped 24.** Counted in
  the tag itself: `git show v1.0.0:README.md` carries a 24-row layer table, and
  `docs/SECURITY_AUDIT_REPORT.md` numbers its findings up to `SEC-F15`. The figure 18 was
  the count before the last hardening round of the predecessor, not the count that shipped
- **Both early sections were dated 2026-02-16, which is neither tag date.** `v1.0.0` is
  tagged 2026-02-19 and `v1.1.0` 2026-05-30. The headings now carry the tag dates, and the
  three-month gap between the two is no longer hidden behind an identical date
- **Every entry now opens with a bold line stating the effect.** All 108 entries were plain
  prose before, so a reader scanning the bold lines of a release got nothing. The cause,
  the measurement and the code anchor follow in the paragraph below, unchanged
- **The em dashes and the ellipsis are gone.** Ten em dashes and one ellipsis had entered
  the 1.2.3, 1.3.1 and 1.3.2 sections, although `.claude/commands/release.md` had required
  ASCII (`--`, `->`) from the start. Replaced by the punctuation or the word each stood for

### Changed

- **Release titles carry a headline after the colon instead of repeating the version.** All
  ten published releases were titled with the bare number, which the release list already
  shows next to them. The headline is drawn from the section rather than invented

### Security

- **Nothing about the running bot changed.** No source file, no dependency and no
  configuration was touched. Every measured figure, path, function name and version
  reference in the older sections was verified against its tag and left as it stood, except
  the layer count named above

## [1.3.3] - 2026-08-17: Unsafe tool calls are denied before they run

### Security

- **An unsafe tool call is now prevented, not merely reported after the fact.** A
  `PreToolUse` hook (`buildSafetyHook()` in `src/security.ts`) runs `checkToolCallSafety()`
  before the call executes and denies it with `permissionDecision: "deny"`, which resolves
  before `canUseTool` and is therefore not overridden by
  `permissionMode: "bypassPermissions"`. This covers the command blocklist (Layers 5/6),
  file and search path validation (Layer 7) and the `ALLOWED_TOOLS` / `DISALLOWED_TOOLS`
  lists, and it fires inside sub-agents as well (`HookInput.agent_id`). 1.3.0 named this as
  the missing piece and deferred it as its own change; this is that change. The hook fails
  closed: anything thrown inside the callback still denies
- **The layer count stays at 24.** Nothing new is defended here. The same four checks now
  act where they previously only observed, and inventing a Layer 25 for a relocated
  enforcement point would overstate what changed. `docs/SECURITY_AUDIT_REPORT.md` is a dated
  document and is left untouched

### Fixed

- **A blocked tool call no longer costs the user the whole answer.** The stream check threw,
  which aborted the query: the user asked a question, the model reached for a route it was
  not allowed to take, and no answer ever arrived, with only the generic error to show for
  it. The denial now goes back to the model as a tool result and it picks another route. The
  stream check reports and continues. Measured against SDK 0.3.233, the `tool_use` block
  reaches the output stream *before* the hook fires, so the stream check cannot serve as a
  fallback and must not throw; prevention lives in the hook alone
- **The 1.3.2 release stopped after the tag, leaving the version and the changelog behind.**
  `package.json` still read `1.3.1` after the 1.3.2 release, and `CHANGELOG.md` had no
  `[1.3.2]` section: its entries were left under `[Unreleased]`. The section has been written
  from the 1.3.2 commit and the version now reads `1.3.3`. The `v1.3.2` tag itself was never
  pushed and is published unchanged rather than moved; the `package.json` it carries still
  says `1.3.1`, which cannot be corrected without rewriting history. Same failure mode as the
  drift that 1.2.0 had to clean up
- **Three documents described tool-call checking as it behaved before this release.** They
  asserted that it "reports, it does not prevent" and that no hook was installed: `README.md`
  (Tool Control), `SECURITY.md` (bypass mode) and `docs/security-limitations.md`
  (limitation 4, now marked closed and kept in the list rather than deleted, as limitation 8
  was in 1.3.1)
- **`src/session.ts` had crossed the 800-line limit that `CONTRIBUTING.md` sets.** It stood
  at 806 lines, because the new comment block duplicated the one it replaced. Condensed to
  797
- **The size claim in `README.md` and `AGENTS.md` was 200 lines short.** Corrected from
  "~6,800 lines TypeScript" to ~7,000; measured across `src/` and `ask_user_mcp/`: 7,052

## [1.3.2] - 2026-08-16: A reasoning baseline that does not depend on remembering a keyword

### Added

- **A reasoning level can now be set once instead of per message.** `THINKING_DEFAULT`
  (`off` by default = previous behaviour) is the baseline thinking level for every message,
  applied before keywords. Until now the only way to get reasoning effort was a keyword in
  the message, so a bot whose turns are judgement calls rather than commands depended on the
  operator remembering one every time, which is the kind of discipline that fails on the
  message where it mattered. `normal` maps to `effort: high`, `deep` to `effort: max`.
  Keywords still apply on top and can only raise the level, never lower it: a `deep` baseline
  stays `deep` even when the message contains a `normal` keyword, since a floor that wording
  can undo is not a floor

### Changed

- **`/model o` now selects Opus 5 instead of Opus 4.8.** Opus 4.8 stays in the display-name
  table so an existing `CLAUDE_MODEL` pointing at it is still shown by name rather than as a
  raw ID

### Fixed

- **Two lines in `.env.example` stopped the bot from starting as a LaunchAgent.** They broke
  `source .env`, which is how `launchagent/start.sh` reads the file. Uncommenting them and
  starting the bot produced `command not found: are` and `command not found: the` instead of
  a running bot. Every other multi-word value in the file was already quoted; these two were
  not:
  - the `BOT_PERSONA` example, added in 1.2.3, now quoted, with a note saying why
  - a prose line in the `ALLOWED_TOOLS` section that happened to wrap onto
    `# ALLOWED_TOOLS=Read,Grep,Glob the built-ins reduce...`, so a sentence read as an
    assignment. Reflowed. It also looked like a variable to the CI documentation gate, which
    greps `^#? ?[A-Z_]{4,}=`; it passed only because `ALLOWED_TOOLS` is a real variable, and
    a prose line starting with any other uppercase token would have failed the gate with a
    confusing message

  Found while configuring a bot built on this code, not by review: the failure surfaces on
  the LaunchAgent path and not when running `bun run start` by hand

## [1.3.1] - 2026-08-16: Two users at once no longer race on the ask_user handshake

### Fixed

- **An inline keyboard could reach the wrong chat when two users asked at the same moment.**
  The ask_user subprocess read the shared `query-context.json` and never the per-user
  `query-context-{userId}.json` the bot wrote beside it, because it had no way to know which
  user it was serving. The second request overwrote the file before the first subprocess read
  it. The bot now injects `ASK_USER_USER_ID` per query (`mcpServersForUser()`), which works
  because the SDK spawns stdio MCP servers per `query()` call, verified against 0.3.233 that
  two spawns carry different values without leaking. The subprocess prefers the per-user file
  and falls back to the shared one, so an older subprocess keeps working. Measured before and
  after: with two users' contexts written in sequence the old path returned the second user's
  chat ID for both turns, the new one returns each user's own
- **`BOT_ID` did not reach the ask_user handshake, so two instances shared it.** The
  handshake directory was still hardcoded to `~/.cc-telegram-bot/ask-user` in four places
  (`src/session.ts`, `src/handlers/streaming.ts`, `src/handlers/callback.ts`,
  `ask_user_mcp/server.ts`). `query-context.json` in that directory is the one handshake file
  that is not per user, so instance A could answer a button press with instance B's chat
  context. Now derived from `BOT_ID` via the new `ASK_USER_DIR` export
- **`SECURITY.md` Layer 23 claimed a protection that no code provided.** It asserted that
  ask-user context files "are scoped per user to prevent cross-user race conditions" for a
  version in which nothing read the per-user file, describing the intent as though it were
  the behaviour. It now describes both halves of the handshake and names the residual: a bot
  paired with an older subprocess still falls back to the shared file. Recorded in
  `docs/security-limitations.md` as limitation 8, kept in the list as closed rather than
  deleted, so a reader who met it as an accepted risk can see where it went
- **`src/security.ts` still hedged about something that has since been measured.** It carried
  the pre-measurement note that `tools` "is not shown to constrain MCP tools". It is now
  measured and stated as fact, with the reach of both lists spelled out, matching the table
  added to `README.md`
- **The `ASK_USER_DIR` comment in `src/config.ts` undercounted the places it replaced.** It
  said the path had been hardcoded in "three places"; it was four, as the changelog entry
  above already enumerated. Three under `src/` plus the MCP subprocess
- **`AGENTS.md` was missing one of the paths its own section claims are derived from
  `BOT_ID`.** It lists `~/.<BOT_ID>/ask-user/` among the runtime paths; that one was absent
- **Removed `getTextFromMessage()` from `src/session.ts`.** It was defined and called from
  nowhere, and its removal took the orphaned `SDKMessage` import with it. Without this the
  file would have crossed the 800-line limit in `CONTRIBUTING.md` at 801
- **A documented guarantee about tool-name drift is now enforced instead of asserted.**
  `ASK_USER_SERVER_KEY` documented itself as the source the `mcp__ask-user__*` tool names are
  derived from, "so the two cannot drift apart", while `session.ts` matched on the string
  literal and could drift apart freely. The prefix is now derived from the key
  (`ASK_USER_TOOL_PREFIX`) and the literals are gone, which makes the existing claim true
  instead of softening it. Same resolved value, no behaviour change

### Changed

- **The CI configuration-documentation gate now also covers the MCP subprocess.** It scanned
  only `src/`, so the subprocess reading `BOT_ID`, introduced by this same release, would have
  gone undocumented without anything noticing. It now scans `ask_user_mcp/*.ts`.
  `ASK_USER_USER_ID` is exempt from the gate: the bot injects it per query, and documenting
  it in `.env.example` would invite the manual override that breaks the handshake
- **An allowlist alone does not make the bot read-only once an MCP server is configured.**
  Tool control documentation corrected after measuring against SDK 0.3.233: `ALLOWED_TOOLS`
  (`tools`) governs built-in tools only. With `ALLOWED_TOOLS=Read,Grep,Glob` the built-ins
  reduce to those three while every tool of every configured MCP server remains available.
  Both lists are needed
- **`DISALLOWED_TOOLS` does reach MCP tools, in both of its forms.** The earlier caveat that
  the wildcard and server-level forms might be honoured only by the bot's own runtime check
  was too cautious. Both `mcp__server` and `mcp__server__*` remove the server's entire tool
  set from the session itself

## [1.3.0] - 2026-08-16: Tool restrictions, a spending ceiling and a quiet mode

### Added

- **The bot can be restricted to a set of tools instead of only a set of paths.**
  `ALLOWED_TOOLS` and `DISALLOWED_TOOLS` (both empty by default). Until now the bot passed no
  tool restriction to the Agent SDK at all while running with
  `permissionMode: "bypassPermissions"`: `ALLOWED_PATHS` bounded where Claude could work,
  nothing bounded what it could do there, so a fork pointed at a documentation repository had
  no way to make it read-only. The lists are handed to the SDK as `tools` and
  `disallowedTools`. The similarly named `allowedTools` option is deliberately not used: it
  is an auto-approve list for permission prompts and enforces nothing under
  `bypassPermissions`. Leaving both unset keeps the previous behaviour exactly
- **A monthly spending ceiling per user, surviving restarts.** `COST_LIMIT_USD` (unset by
  default = unlimited) tracks cumulative spend per Telegram user and calendar month,
  persisted in the existing SQLite database (`ALERT_DB_PATH`, new `user_costs` table).
  `sessions.json` was the other candidate and lost on one point: `loadSessionHistory()`
  swallows parse errors and returns an empty history, so a corrupted file would have reset
  the budget to zero without saying so. The period (`YYYY-MM`, local time) is part of the
  primary key, so the monthly reset needs no scheduled job that could fail to run. Exceeding
  the limit produces an explicit message naming the amount, the ceiling and the reset, not a
  bare refusal
- **The stream of tool calls and reasoning fragments can be turned down or off.**
  `VERBOSE_LEVEL` (default `1` = previous behaviour) and a `/verbose` command. The bot
  streamed every tool call and every reasoning fragment unconditionally, which is the point
  for system administration and a wall of noise for anything else. `0` shows the final answer
  only, `1` keeps thinking previews and tool status, `2` adds tool results and a closing line
  with duration, tokens and cost. The per-user override is held in memory on the session
  exactly like the `/model` override: it survives `/new`, is lost on restart, and then falls
  back to the environment default
- **`/status` shows what the month has cost so far.** With the ceiling and percentage when
  one is configured, and shown regardless of whether a limit is set, because picking a
  sensible ceiling requires seeing the number first

### Changed

- **A refused request now says why it was refused.** Blocked tool calls, blocked commands and
  denied paths are reported through a new `notice` status type instead of the ephemeral
  `tool` type. Refusals were pushed onto the same message list that is deleted when a turn
  ends, and deleted again by the error handlers in `text.ts`/`media-group.ts`, so the user saw
  the generic error and not the reason. On the alert path they were not delivered at all,
  because `createAlertStatusCallback` implements `tool`/`segment_end`/`done` and nothing else
- **Those refusal messages appear at every verbose level, including `0`.** They look like
  status updates but are the only explanation a user gets for a refused request; gating them
  would have turned a noise setting into a security setting and quietly undone the tool
  control above
- **`/alert` bills the person who typed it, not the alert session.** The alert session
  (synthetic user ID 0) is exempt from the cost ceiling on purpose, because a budget must
  never be able to silence system monitoring, and without this attribution a user who had hit
  their limit could have kept working through `/alert` on that exemption
- **Tool-call safety checks moved out of `session.ts` into `checkToolCallSafety()` in
  `security.ts`.** Adding three features to `sendMessageStreaming()` had pushed `session.ts`
  past the 800-line limit in `CONTRIBUTING.md`; the checks are questions about safety and
  belong in that module. No behaviour change
- **`README.md` is titled "Claude Code Telegram Bot" instead of the repository slug.**
  `cc-telegram-bot` said what the directory is called rather than what the project does

### Fixed

- **The size claim in `README.md` and `AGENTS.md` was almost a thousand lines short.** Both
  claimed "~5,900 lines TypeScript". Measured across `src/` and `ask_user_mcp/`: 6,838. The
  figure had been drifting since before v1.2.0

### Security

- **Two documents told operators that tool restriction was not available.**
  `docs/security-limitations.md` and `SECURITY.md` documented restricting tool usage as "not
  implemented" and as something to do "via the system prompt". Both are now env-configurable
  and SDK-enforced
- **A documented claim about sub-agent tool calls was removed rather than carried forward.**
  `docs/security-limitations.md` claimed "there is no SDK-level hook to intercept sub-agent
  tool calls". That is not true of Agent SDK 0.3.233: a `PreToolUse` hook fires before
  execution and inside sub-agents (`HookInput.agent_id` exists to tell them apart), and it is
  what the SDK recommends for gating under `bypassPermissions`, while `canUseTool` is
  auto-approved past and never consulted. No hook is installed here; that reworks the
  permission path and belongs in its own change. What the bot's runtime check does and does
  not do is now stated precisely: it detects after dispatch, sub-agent calls included, and
  does not prevent
- **The holes in cost accounting are stated plainly rather than left to be discovered.**
  Automatic socket alerts are exempt from the ceiling by design (see above); `total_cost_usd`
  is only emitted on the result event, so the four paths that leave the stream earlier (the
  inline-keyboard hand-off, `/stop`, a `!` interrupt, and a tool call blocked by the checks)
  consume real tokens and book zero; and because the ceiling is checked before a turn rather
  than during it, a single turn can exceed it by any amount. The SDK's `maxBudgetUsd` would
  close the latter two, but needs its own handling of the `error_max_budget_usd` result
  subtype and is therefore left to a separate change
- **Adding a column to `user_costs` later will need a migration that does not exist yet.**
  The table is created with `CREATE TABLE IF NOT EXISTS` and there is no migration mechanism,
  matching the existing `alerts` table. Reverting leaves the table in place, which is
  harmless, because older code never reads it
- **Tool control is intentionally not counted as a 25th security layer.** The 24 numbered
  layers describe what protects an operator who changed no configuration, and these lists are
  empty until someone fills them in. A future security audit may reasonably take tool control
  up as Layer 25 once it has been reviewed as one; `docs/SECURITY_AUDIT_REPORT.md` is a dated
  document and has been left untouched

## [1.2.3] - 2026-08-16: Two bots on one machine keep their own state

### Added

- **Every per-instance path derives from one setting.** `BOT_ID` (default
  `cc-telegram-bot`) governs `~/<.BOT_ID>/` (sessions, audit log, alert database),
  `/tmp/<BOT_ID>/` (downloaded media) and `/run/<BOT_ID>/alerts.sock`. Validated as a single
  path segment at startup, so a value like `../../etc` aborts instead of escaping into the
  filesystem
- **The bot's role description can be changed without editing the source.** `BOT_PERSONA`
  (default unchanged) sets the one-line role description at the top of the system prompt; the
  detailed personality stays in `CLAUDE.md` inside `CLAUDE_WORKING_DIR`

### Fixed

- **Two instances of this bot on one machine shared their state without saying so.** The data
  directory (`~/.cc-telegram-bot`) and temp directory (`/tmp/telegram-bot`) were hardcoded, so
  both wrote the same `sessions.json`: last write won, and a conversation could surface in the
  wrong bot. Set a distinct `BOT_ID` per instance
- **A bot without alerting no longer carries the alert half of the safety prompt.** The alert
  rules (7 through 12, roughly half the safety prompt) were emitted unconditionally. They now
  follow the same gate as the runtime, since the alert socket only starts when a group is
  whitelisted (`src/index.ts`), so the rules only appear when `TELEGRAM_ALLOWED_GROUPS` is
  set. Without alerts the prompt drops from 4097 to 2181 characters, and the bot no longer
  carries instructions to scan `DOCS_DIR` and await `/alert` approval for a subsystem that
  never runs
- **A bot built on this code for another purpose was told it was an admin bot.** The persona
  line was hardcoded as "You are a Claude-powered Telegram admin bot", which outranked the
  bot's own `CLAUDE.md`, because the system prompt wins

### Changed

- **Dependencies raised:** Claude Agent SDK 0.3.215 -> 0.3.233, MCP SDK 1.29.0 -> 1.30.0,
  TypeScript `^5` -> `^5.9.3`

## [1.2.2] - 2026-08-12: The EOD report script is executable

### Fixed

- **`scripts/trigger-eod-report.sh` could not be run directly.** It shipped without the
  executable bit since v1.0.0, so `./scripts/trigger-eod-report.sh` failed with "Permission
  denied"; it worked only when invoked as `bash scripts/trigger-eod-report.sh`

## [1.2.1] - 2026-08-08: Continuous integration, and the last two undocumented settings

### Added

- **Every push and pull request is now checked by CI** (`.github/workflows/lint.yml`). The
  repository had no CI at all until now, so every check ran locally or not at all. The
  workflow runs typecheck (`bun install --frozen-lockfile` + `bun run typecheck`), ShellCheck
  on the two shell scripts, an XML parse of the LaunchAgent template, three
  configuration-documentation gates, a relative-link check across all Markdown, a changelog
  link-definition check, and gitleaks over the full history
- **`CLAUDE_CODE_PATH` is documented** in `.env.example` and `README.md`. It sets the Claude
  Code executable handed to the Agent SDK (`src/session.ts`) and is needed for standalone
  builds
- **`DOCS_DIR` is documented** in `.env.example` and `README.md`. Claude scans this directory
  for existing documentation before diagnosing an alert (`src/config.ts`); default
  `~/Documents/docs`

### Fixed

- **`CLAUDE_CODE_PATH` and `DOCS_DIR` were findable only by reading the source.** Both were
  configurable in code and appeared in no documentation
- **Four documented settings were missing from the README configuration table.**
  `CLAUDE_CLI_PATH`, `WHISPER_CLI_PATH`, `AUDIT_LOG_MAX_SIZE` and `AUDIT_LOG_MAX_FILES` were
  documented in `.env.example` but not in the table
- **The `[Unreleased]` compare link pointed one release too far back.** The `[1.2.0]` compare
  link was never added in the 1.2.0 release, which left `[Unreleased]` comparing against
  `v1.1.0`. Both corrected, and the check is now part of CI

### Changed

- **`.gitignore` now covers local agent tooling and further private note formats.**
  `.claude/`, `REDDIT_POST.md`, `TODO.md`, `NOTES.md`. `CLAUDE.md` stays versioned on
  purpose: it is the shipped example system prompt, documented in `README.md` and
  `CONTRIBUTING.md`

## [1.2.0] - 2026-07-20: The SDK bump of 1.1.0 actually reaches an install

### Changed

- **The Agent SDK a fresh install pulls is now the one `package.json` declares.** Updated to
  0.3.215; the lockfile still pinned 0.1.77 even though `package.json` already declared
  `^0.3.158`, because no install had been run after the bump in 1.1.0
- **Dependencies updated:** grammY 1.40.0 -> 1.45.1, MCP SDK 1.26.0 -> 1.29.0, zod 4.3.6 ->
  4.4.3
- **`deep` thinking is distinguishable from `normal` again.** Thinking control migrated from
  the deprecated `maxThinkingTokens` to `thinking` + `effort`: `off` -> `thinking: disabled`,
  `normal` -> adaptive + `effort: "high"`, `deep` -> adaptive + `effort: "max"`. Current
  models only honoured `maxThinkingTokens` as on/off, which made `deep` (50k) behave
  identically to `normal` (10k)
- **Model IDs raised to the current generation:** default `claude-sonnet-4-6` ->
  `claude-sonnet-5`, `/model` shortcut `s` -> `claude-sonnet-5`, `o` -> `claude-opus-4-8`
  (was `claude-opus-4-6`)

### Fixed

- **`bun run typecheck` was not runnable.** `typescript` was declared only under
  `peerDependencies` and therefore never installed; now a `devDependency`
- **The type check failed with about 35 `Cannot find name 'Bun'` errors** until
  `"types": ["bun"]` was added to `tsconfig.json`
- **`package.json` had drifted from the changelog.** It still read `1.0.0` after the 1.1.0
  release, and is now kept in sync with the released version
- **The documented default model named a version the code no longer used.** `README.md` and
  `.env.example` both still named `claude-sonnet-4-5`
- **The `/model` error branch in `commands.ts` still listed Sonnet 4.5 / Opus 4.6**
- **A dead link in `README.md`:** the Agent SDK docs returned 404
  (`docs.anthropic.com/en/docs/build-with-claude/agent-sdk` ->
  `code.claude.com/docs/en/agent-sdk`)
- **`AGENTS.md` referenced two functions that do not exist:** `isCommandSafe()` /
  `isUserAuthorized()` (actual: `checkCommandSafety()` / `isAuthorized()`), and it did not
  list `src/alert-db.ts`
- **`THINKING_DEEP_KEYWORDS` was documented as "50k tokens"** in `README.md` /
  `.env.example`, which no longer applies after the thinking migration (now `effort: max`)
- **`systemd/` was missing from the architecture tree** in `README.md` and `CONTRIBUTING.md`
- **The size claim "~3,500 lines TypeScript"** in `README.md` / `AGENTS.md` corrected to the
  actual figure (~5,900 lines across `src/`)

### Added

- **Every incoming alert is now persisted and queryable.** Alert History Store: a SQLite
  database (`~/.cc-telegram-bot/alerts.db`) records the alert on arrival
- **MTTR tracking:** `processed_at` and `claude_response_length` recorded after Claude
  responds
- **`ALERT_DB_PATH`** for a configurable database location
- **WAL mode** for concurrent reads during bot operation
- **Indexes on `received_at` and `type`** for analytics queries
- **Query examples in `docs/EXAMPLES.md`** (top alerts, MTTR, daily breakdown)

### Security

- **Alert secrets are stripped before database insertion** (defense-in-depth)
- **The database file is created with 0o600 permissions** (owner-only access)
- **Prepared statements are cached at init** (parameterized queries, no SQL injection
  surface)

## [1.1.0] - 2026-05-30: Agent SDK 0.3 for compatibility with current Claude CLI

### Fixed

- **The bot returned empty answers against Claude CLI 2.1.156 and newer.**
  `@anthropic-ai/claude-agent-sdk` 0.1.x is incompatible with that line, and the failure
  arrives as an empty response rather than an error. `package.json` now declares `^0.3.158`

### Changed

- **`@anthropic-ai/claude-agent-sdk` raised from `^0.1.76` to `^0.3.158`** in `package.json`
- **The default model is `claude-sonnet-4-6`** instead of `claude-sonnet-4-5`
  (`src/config.ts`)
- **`launchagent/start.sh` carries its executable bit**
- **`CODE_OF_CONDUCT.md` uses `-` list markers** instead of `*`, matching every other
  document in the repository

### Upgrade notes

Run `bun install` after updating. `bun.lock` was not regenerated in this release and still
pins 0.1.77, so an install with `--frozen-lockfile` keeps the old SDK and the empty-response
failure with it. 1.2.0 regenerated the lockfile and closed that gap.

## [1.0.0] - 2026-02-19: First public release

### Added

- **Two security audits and the 24 hardening layers they produced.** The first audit reported
  7 findings (0 critical, 2 high, 1 medium, 4 low), all addressed; the layer table in
  `README.md` and `SECURITY.md` numbers 24
- **Credential leak prevention:** blocklist, environment isolation, output redaction
- **HMAC-SHA256 audit log integrity** with rotation
- **Log sanitization** through a console wrapper
- **Environment isolation:** secrets stripped from `process.env`
- **Multi-modal input:** text, voice, photo, document, video
- **Streaming responses** with live updates
- **Session management** with persistence
- **Extended thinking**, keyword-triggered
- **MCP server integration**
- **Local voice transcription** via whisper.cpp
- **Alert socket:** a Unix domain socket for automated system alerts from monitoring scripts
  (`src/alert-socket.ts`), with the alert history store in `src/alert-db.ts`
- **Group chat support:** whitelisted groups with @mention or reply-to-bot activation
- **`/alert` command:** interactive access to the daily alert session
- **EOD report generation:** daily summaries via systemd timer
- **macOS LaunchAgent** for always-on operation
- **Model switching** through the `/model` command

### Notes on the predecessor

This repository publishes work that began in a private repository. The hardening that took
the layer count from 18 to 24 (`SEC-F1` through `SEC-F11` in
`docs/SECURITY_AUDIT_REPORT.md`, covering alert payload content tags, 11 additional
blocklist patterns, alert rate limiting, a startup warning for an unset
`ALERT_SOCKET_SECRET`, generic error messages to Telegram, `TEMP_PATHS` narrowed from
`/tmp/` to `/tmp/telegram-bot/`, per-user MCP context files, Zod validation of alert
payloads, environment isolation extended from 2 to 7 variables, and a bounded alert queue)
happened there, before this tag. It is recorded here because the audit report references it,
not because `v1.0.0` changed it. Until 1.3.4 this history was filed under a `[1.1.0]`
heading, which described a release that shipped four unrelated files.

### Based on

- [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot) (MIT License)
- Core architecture: grammY Telegram bot, Claude Agent SDK integration, streaming responses,
  multi-modal input (text, voice, photo, document, video), MCP support

[Unreleased]: https://github.com/fidpa/cc-telegram-bot/compare/v1.3.4...HEAD
[1.3.4]: https://github.com/fidpa/cc-telegram-bot/compare/v1.3.3...v1.3.4
[1.3.3]: https://github.com/fidpa/cc-telegram-bot/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/fidpa/cc-telegram-bot/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/fidpa/cc-telegram-bot/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/fidpa/cc-telegram-bot/compare/v1.2.3...v1.3.0
[1.2.3]: https://github.com/fidpa/cc-telegram-bot/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/fidpa/cc-telegram-bot/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/fidpa/cc-telegram-bot/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/fidpa/cc-telegram-bot/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/fidpa/cc-telegram-bot/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/fidpa/cc-telegram-bot/releases/tag/v1.0.0
