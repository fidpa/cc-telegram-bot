# cc-telegram-bot

[![Release](https://img.shields.io/github/v/release/fidpa/cc-telegram-bot)](https://github.com/fidpa/cc-telegram-bot/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.1%2B-black?logo=bun)](https://bun.sh/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](https://bun.sh/)
![Last Commit](https://img.shields.io/github/last-commit/fidpa/cc-telegram-bot)

Security-hardened Telegram bot for remote Claude Code access.

**The Problem**: Running Claude Code remotely via Telegram with `bypassPermissions` requires systematic security hardening. Without permission prompts, Claude can read, write, and execute anything on the host machine. After conducting two security audits (Claude Opus 4.6, OWASP methodology), 24 hardening layers were implemented as defense-in-depth. This repository documents the entire process transparently -- including the limitations that remain.

## Features

- **24 Security Layers, Defense-in-Depth** -- from user allowlist to HMAC-signed audit logs (see [Security](#security-architecture))
- **Multi-Modal Input** -- text, voice messages, photos, documents (PDF extraction), video
- **Streaming Responses with Live Updates** -- real-time message editing as Claude generates
- **Extended Thinking (Keyword-Triggered)** -- configurable keywords activate Claude's thinking mode
- **MCP Server Integration** -- extensible via Model Context Protocol (ask-user inline keyboards, custom tools)
- **Session Management** -- persist, resume, and switch conversations (`/new`, `/stop`, `/resume`)
- **Local Voice Transcription** -- whisper.cpp with local GGML model, no data leaves the machine
- **Audit Logging with HMAC Integrity** -- tamper-evident JSON logs with automatic rotation
- **Output Redaction** -- credential leak prevention on all outbound Telegram messages
- **Environment Isolation** -- secrets stripped from `process.env` before Claude spawns
- **Alert Socket** -- Unix domain socket for automated system alerts from monitoring scripts
- **Alert History (SQLite)** -- every alert persisted for trend analysis, MTTR metrics, and data-driven reports
- **Group Chat Support** -- whitelisted groups with @mention or reply-to-bot activation
- **LaunchAgent for macOS** -- always-on operation with automatic restart
- **systemd for Linux** -- always-on operation with automatic restart and EOD timer
- **Model Switching** -- `/model` command to switch between Sonnet, Opus, and Haiku at runtime

## Known Limitations

> **IMPORTANT**: The bot runs Claude Code with `bypassPermissions` mode. This is intentional for mobile UX, but means all security measures are defense-in-depth guardrails, not hard boundaries.
>
> - The command blocklist is best-effort (string matching cannot prevent all shell injection vectors)
> - The Bash tool bypasses path validation (Claude can `cat` any file via shell)
> - Rate limiter state resets on restart
>
> See [docs/security-limitations.md](docs/security-limitations.md) for the full analysis with accepted risks and recommended mitigations.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) 1.1+
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Claude Code CLI installed and authenticated (or Anthropic API key)
- Optional: `whisper-cpp` for voice transcription (`brew install whisper-cpp`) + GGML model
- Optional: `ffmpeg` for voice message conversion (`brew install ffmpeg`)
- Optional: `poppler` for PDF extraction (`brew install poppler`)

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/fidpa/cc-telegram-bot.git
cd cc-telegram-bot

# 2. Install dependencies
bun install

# 3. Configure environment
cp .env.example .env
# Edit .env with your Telegram bot token and user ID

# 4. (Optional) Customize the system prompt
# Edit CLAUDE.md to match your use case

# 5. Run the bot
bun run start

# 6. Test: Send a message to your bot on Telegram
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/new` | Start a new conversation (clears session) |
| `/stop` | Stop the current Claude session |
| `/status` | Show session info and rate limit status |
| `/resume` | Resume previous conversation |
| `/restart` | Restart the bot process |
| `/retry` | Retry the last failed message |
| `/model` (`/m`) | Switch Claude model (Sonnet, Opus, Haiku) |
| `/alert` | Send a message into the alert session (daily context) |

## Configuration

All configuration via environment variables (see [.env.example](.env.example)):

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USERS` | Yes | Comma-separated Telegram user IDs |
| `CLAUDE_WORKING_DIR` | Recommended | Working directory for Claude (loads CLAUDE.md) |
| `CLAUDE_MODEL` | Optional | Default Claude model (default: `claude-sonnet-4-5`) |
| `WHISPER_MODE` | Optional | `local` (default) or `off` -- voice transcription mode |
| `WHISPER_MODEL_PATH` | Optional | Path to GGML whisper model |
| `WHISPER_LANGUAGE` | Optional | Whisper language code (default: `de`) |
| `ALLOWED_PATHS` | Optional | Directories Claude can access (default: working dir, ~/Documents, ~/Downloads, ~/Desktop, ~/.claude) |
| `RATE_LIMIT_ENABLED` | Optional | Enable rate limiting (default: `true`) |
| `RATE_LIMIT_REQUESTS` | Optional | Requests per window (default: `20`) |
| `RATE_LIMIT_WINDOW` | Optional | Window in seconds (default: `60`) |
| `AUDIT_LOG_PATH` | Optional | Audit log location (default: `~/.cc-telegram-bot/audit.log`) |
| `AUDIT_LOG_JSON` | Optional | JSON format for logs (default: `true`) |
| `AUDIT_LOG_HMAC_KEY` | Optional | HMAC key for log integrity (auto-generated if not set) |
| `TELEGRAM_ALLOWED_GROUPS` | Optional | Comma-separated Telegram group IDs for group chat support |
| `ALERT_SOCKET_PATH` | Optional | Unix socket path for alerts (default: `/run/cc-telegram-bot/alerts.sock`) |
| `ALERT_SOCKET_SECRET` | Optional | Shared secret for socket authentication (recommended for production) |
| `ALERT_DB_PATH` | Optional | SQLite alert history database (default: `~/.cc-telegram-bot/alerts.db`) |
| `DAILY_LOG_DIR` | Optional | Directory for daily bot reports |
| `ANTHROPIC_API_KEY` | Optional | API key (alternative to CLI auth) |
| `THINKING_KEYWORDS` | Optional | Keywords triggering extended thinking |
| `THINKING_DEEP_KEYWORDS` | Optional | Keywords triggering deep thinking (50k tokens) |

MCP servers are configured in `mcp-config.ts` (see [mcp-config.example.ts](mcp-config.example.ts)).

## Security Architecture

The bot implements defense-in-depth with 24 security layers:

| # | Layer | File | Description |
|---|-------|------|-------------|
| 1 | User Authorization | security.ts | Allowlist-based Telegram user ID check |
| 2 | Rate Limiting | security.ts | Token bucket algorithm with periodic cleanup |
| 3 | Input Length Validation | text.ts | MAX_MESSAGE_LENGTH = 4096 |
| 4 | Path Validation | security.ts | `isPathAllowed()` with symlink resolution |
| 5 | Command Blocklist (String) | config.ts | 30+ dangerous patterns (fork bombs, disk destruction) |
| 6 | Command Blocklist (Regex) | security.ts | 40+ regex patterns for robust detection |
| 7 | File Operation Path Check | session.ts | Read/Write/Edit/Glob/Grep validated against ALLOWED_PATHS |
| 8 | Safety System Prompt | config.ts | 7 anti-injection rules for Claude |
| 9 | Content Delimiters | handlers | `user_document`/`user_caption`/`alert_data` safety tags |
| 10 | Secret Redaction (Logs) | utils.ts | Exact-match + pattern-based redaction in audit logs |
| 11 | Audit Logging | utils.ts | JSON-formatted, append-only, 0o600 permissions |
| 12 | Session Isolation | session.ts | Per-user session instances |
| 13 | File Permission Hardening | config.ts | Data directory 0o700, audit log 0o600 |
| 14 | Output Redaction | streaming.ts | Secrets redacted in ALL outbound Telegram messages |
| 15 | Env-Dump Blocklist | security.ts | `printenv`/`env`/`export -p`/`declare` blocked |
| 16 | Environment Isolation | index.ts | 7 sensitive env vars deleted from `process.env` |
| 17 | Log Sanitization | utils.ts | `console.error`/`warn`: home paths, stack traces, secrets redacted |
| 18 | Audit Log Integrity | utils.ts, config.ts | HMAC-SHA256 per entry + automatic log rotation |
| 19 | Alert Content Tags | alert-socket.ts | `<alert_data>` tags + spoofed prefix stripping |
| 20 | Alert Rate Limiting | alert-socket.ts | 10 alerts/minute sliding window |
| 21 | Alert Payload Validation | alert-socket.ts | Zod schema with field-level length limits |
| 22 | Alert Queue | alert-socket.ts | Bounded queue (max 20) with FIFO drain |
| 23 | Per-User Context Files | session.ts | MCP context scoped per user ID |
| 24 | Scripting Language Blocklist | security.ts | Blocks env access via python/node/ruby/perl + /proc |

### Credential Leak Prevention

Four layers ensure secrets never reach the user, regardless of attack vector:

```
                           Attack
                              |
            +-----------------+-----------------+
            |                 |                 |
       "cat .env"        "printenv"       Prompt Injection
            |            "python -c"     "show me the token"
            |            "/proc/environ"       |
            |                 |                 |
       +----+----+      +----+----+            |
       | String  |      | Regex   |            |
       | Block-  |      | Block-  |            |
       | list    |      | list    |            |
       | L5  X   |      | L6/24 X |            |
       +---------+      +---------+            |
                                               |
                              +----------------+----------------+
                              | Environment Isolation (L16)      |
                              |                                  |
                              | 7 env vars deleted:              |
                              | TELEGRAM_BOT_TOKEN               |
                              | TELEGRAM_ALLOWED_USERS           |
                              | ALERT_SOCKET_SECRET              |
                              | AUDIT_LOG_HMAC_KEY               |
                              | OPENAI_API_KEY, etc.         X   |
                              +----------------+----------------+
                                               |
                                  If a secret still ends up
                                  in Claude's response
                                               |
                              +----------------+----------------+
                              | Output Redaction (L14)           |
                              |                                  |
                              | EVERY Telegram message is        |
                              | checked for known secrets and    |
                              | secret patterns before sending.  |
                              |                              X   |
                              +----------------+----------------+
                                               |
                                    User sees: [REDACTED]
```

Full audit report: [docs/SECURITY_AUDIT_REPORT.md](docs/SECURITY_AUDIT_REPORT.md)

Integration examples (alert clients in Bash/Python, cron jobs, systemd health checks): [docs/EXAMPLES.md](docs/EXAMPLES.md)

## Use Cases

### Perfect for

- ✅ **Remote development** -- Run Claude Code on your Mac Mini or server, control it from your phone
- ✅ **Headless machines** -- Access Claude on servers without monitors (SSH alternative with richer UX)
- ✅ **Personal automation** -- Custom CLAUDE.md system prompt + MCP tools for your specific workflow
- ✅ **Infrastructure monitoring** -- Alert socket receives system alerts, Claude analyzes and responds
- ✅ **Voice-first interaction** -- Dictate to Claude via Telegram voice messages (local whisper.cpp)

### Not recommended for

- ❌ **Multi-user SaaS** -- Designed for single-user or small trusted groups, not public deployment
- ❌ **Air-gapped environments** -- Requires internet (Telegram API + Claude API)
- ❌ **Production servers without backups** -- `bypassPermissions` means Claude can modify files; have backups
- ❌ **Windows hosts** -- Bun and whisper.cpp support is limited on Windows (use WSL2)

### vs. Alternatives

| Solution | Security | Voice | Alert Socket | Streaming | Limitation |
|----------|----------|-------|-------------|-----------|------------|
| [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot) (upstream) | Basic auth | ✅ | ❌ | ✅ | No security audit, no output redaction |
| Direct Claude API | N/A | ❌ | ❌ | ✅ | No Telegram, no tool use, no MCP |
| Claude Code via SSH | OS-level | ❌ | ❌ | ❌ | Requires terminal, no mobile UX |
| Other Telegram AI bots | Varies | Varies | ❌ | Varies | No Claude Code tool use, no MCP |
| **This project** | 24 layers | ✅ | ✅ | ✅ | `bypassPermissions` (documented) |

**Unique value**: Two documented security audits, 24 hardening layers, transparent limitation documentation, alert socket for infrastructure integration, HMAC audit log integrity.

## Architecture

```
cc-telegram-bot/
+-- src/
|   +-- index.ts           # Entry point, middleware chain, handler registration
|   +-- config.ts          # Environment parsing, MCP loading, safety prompts
|   +-- session.ts         # ClaudeSession class (Agent SDK, streaming, persistence)
|   +-- security.ts        # RateLimiter, path validation, command safety
|   +-- alert-socket.ts    # Unix socket listener, alert prompts, EOD report
|   +-- alert-db.ts        # SQLite alert history store (bun:sqlite, WAL mode)
|   +-- formatting.ts      # Markdown -> Telegram HTML conversion
|   +-- utils.ts           # Audit logging, voice transcription, typing indicators
|   +-- types.ts           # Shared TypeScript types
|   +-- handlers/
|       +-- text.ts        # Text message handling
|       +-- voice.ts       # Voice -> local whisper-cli transcription -> Claude
|       +-- photo.ts       # Image analysis with media group buffering
|       +-- document.ts    # PDF extraction, text files, archives
|       +-- audio.ts       # Audio file transcription
|       +-- video.ts       # Video messages and video notes
|       +-- callback.ts    # Inline keyboard (MCP ask-user)
|       +-- streaming.ts   # Shared streaming state and status callbacks
|       +-- commands.ts    # Bot command handlers (/start, /new, /model, /alert, etc.)
|       +-- media-group.ts # Media group buffering for albums
|       +-- index.ts       # Handler exports
+-- ask_user_mcp/          # MCP server for interactive Telegram buttons
+-- scripts/               # Utility scripts (test-alert, trigger-eod-report)
+-- launchagent/           # macOS LaunchAgent for always-on operation
+-- docs/
|   +-- security-limitations.md  # Architectural security analysis
|   +-- SECURITY_AUDIT_REPORT.md # Full audit with all findings
|   +-- LAUNCHAGENT.md           # macOS LaunchAgent setup guide
|   +-- EXAMPLES.md              # Usage examples (alert socket, cron, Python client)
+-- CLAUDE.md              # System prompt (loaded by Claude)
+-- SECURITY.md            # Security model documentation
```

### Message Flow

```
Telegram -> grammy handler -> Auth check -> Rate limit
    -> ClaudeSession (Agent SDK) -> Streaming response -> Output redaction -> Audit log -> Telegram

Alert Socket -> JSON validation (Zod) -> Secret check -> SQLite insert -> Rate limit -> Alert queue
    -> ClaudeSession (user ID 0) -> Streaming response -> SQLite update -> Output redaction -> Telegram group
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | [Bun](https://bun.sh/) |
| Language | TypeScript 5 (strict mode) |
| AI Backend | [Claude Agent SDK](https://docs.anthropic.com/en/docs/build-with-claude/agent-sdk) |
| Voice Transcription | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (local, GGML model) |
| Telegram Library | [grammY](https://grammy.dev/) |
| Tool Integration | [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) |
| Validation | [Zod](https://zod.dev/) |

### Design Decisions

**Why `bypassPermissions`?** The bot is designed for mobile use, where confirming every file read or shell command would be impractical. Instead of per-action prompts, security relies on 24 defense-in-depth layers (allowlist, rate limiting, path validation, command safety, alert validation, output redaction, audit logging, and more).

**Why string-based command blocking?** Full shell AST parsing is impractical, and OS-level sandboxing (containers, bubblewrap) would be the proper solution. The blocklist is a pragmatic guardrail that catches common destructive patterns while documenting its limitations transparently.

**Why grammY?** grammY is the most actively maintained TypeScript Telegram library. It provides type-safe middleware, built-in runner for concurrent message handling, and native support for inline keyboards and file downloads.

**Why Bun?** Bun provides native TypeScript execution without a build step, fast startup times, and built-in shell utilities (`Bun.$`) for safe subprocess execution. The bot runs as a long-lived process where Bun's performance characteristics are well-suited.

**Why Agent SDK V1?** The Claude Agent SDK provides first-class support for streaming, tool interception (used for path validation and command safety), session management, and MCP server integration. It handles the complexity of multi-turn conversations with tool use that would otherwise require significant boilerplate.

## Requirements

**Minimum**:
- [Bun](https://bun.sh/) 1.1+
- Claude Code CLI installed and authenticated (or `ANTHROPIC_API_KEY`)
- Telegram bot token from [@BotFather](https://t.me/BotFather)

**Optional**:
- `whisper-cpp` + GGML model (voice transcription)
- `ffmpeg` (voice message conversion)
- `poppler` (PDF text extraction)

## Compatibility

**Fully supported**:
- macOS 13+ (Ventura) -- LaunchAgent for always-on operation
- Ubuntu 22.04 LTS, 24.04 LTS -- systemd service
- Debian 12 (Bookworm)
- Raspberry Pi OS (64-bit, ARM64)

**Should work** (untested):
- Fedora, Arch Linux (any systemd-based distro with Bun support)
- WSL2 (without LaunchAgent; use systemd service instead)

**Not supported**:
- Windows native (use WSL2)
- 32-bit ARM (Bun requires 64-bit)

## Documentation

| Document | Description |
|----------|-------------|
| [docs/SECURITY_AUDIT_REPORT.md](docs/SECURITY_AUDIT_REPORT.md) | Full audit: 22 findings, 7 attack vectors, all addressed |
| [docs/security-limitations.md](docs/security-limitations.md) | 5 architectural limitations with accepted risks |
| [docs/EXAMPLES.md](docs/EXAMPLES.md) | Alert socket clients (Bash, Python, cron, systemd) |
| [docs/LAUNCHAGENT.md](docs/LAUNCHAGENT.md) | macOS LaunchAgent setup for always-on operation |
| [SECURITY.md](SECURITY.md) | Security model and vulnerability reporting |
| [.env.example](.env.example) | All environment variables with documentation |

## Customization Guide

This bot is designed to be customized for your personal use case. Here are the key customization points:

### Customize the System Prompt

Edit `CLAUDE.md` in your working directory to define Claude's persona and behavior:

```markdown
# Example: Development Assistant
You are a senior software engineer. Focus on clean code, testing, and security.
Always explain your reasoning before making changes.
```

The bot loads `CLAUDE.md` from `CLAUDE_WORKING_DIR` automatically.

### Add Custom Commands

1. Add your command handler in `src/handlers/commands.ts`
2. Register it in `src/index.ts`:
   ```typescript
   bot.command("mycommand", handleMyCommand);
   ```

### Add MCP Servers

Copy and customize the MCP config:

```bash
cp mcp-config.example.ts mcp-config.ts
```

Add your MCP servers to the `MCP_SERVERS` object. Both stdio and HTTP transports are supported.

### Change Allowed Paths

Set `ALLOWED_PATHS` in `.env` to control which directories Claude can access:

```bash
ALLOWED_PATHS=/Users/yourname/projects,/Users/yourname/Documents,/Users/yourname/.claude
```

### Deploy on Linux (systemd)

Instead of the macOS LaunchAgent, create a systemd service:

```ini
# /etc/systemd/system/cc-telegram-bot.service
[Unit]
Description=Claude Code Telegram Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/cc-telegram-bot
ExecStart=/home/youruser/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=5
EnvironmentFile=/home/youruser/cc-telegram-bot/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable cc-telegram-bot
sudo systemctl start cc-telegram-bot
sudo journalctl -u cc-telegram-bot -f  # View logs
```

## Contributing

Contributions welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Areas where help is appreciated**:
- Container-based deployment (Dockerfile for isolated operation)
- Automated test suite (unit tests for security checks, integration tests for message flow)
- Additional MCP server examples (calendar, notes, home automation)
- Multi-language system prompt templates
- Webhook mode as alternative to long polling
- Grafana dashboard for audit log analysis

## Credits & Attribution

This project is a derivative work based on [claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot) by [Fabrizio Rinaldi](https://github.com/linuz90), licensed under the MIT License.

The original project provides the Telegram-to-Claude-Code bridge architecture. This derivative adds systematic security hardening (24 layers from two documented audits), credential leak prevention, HMAC audit log integrity, environment isolation, output redaction, alert socket integration, and always-on operation.

Additional dependencies:
- [grammY](https://grammy.dev/) -- Telegram Bot API framework
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) -- Local voice transcription

## License

MIT License - see [LICENSE](LICENSE)

(c) 2025 [Fabrizio Rinaldi](https://github.com/linuz90) (original: claude-telegram-bot)
(c) 2026 [Marc Allgeier](https://github.com/fidpa) (derivative: cc-telegram-bot)

## Author

Marc Allgeier ([@fidpa](https://github.com/fidpa))

**Why I Built This**: I wanted to use Claude Code from my phone -- send a message, get a response, run commands on my Mac Mini remotely. The upstream project gave me the bridge, but running an AI agent with `bypassPermissions` on a machine I care about demanded a systematic security approach. Two security audits uncovered 22 findings across 7 attack vectors, all of which were addressed, resulting in 24 hardening layers. Five architectural limitations remain and are documented transparently. This project demonstrates that security work is as much about honest documentation as it is about writing code.

## See Also

- [lydia-bible-bot](https://github.com/fidpa/lydia-bible-bot) -- Same architecture, Bible study domain (security audit, MCP Bible lookup, GDPR)
- [telegram-multi-device-monitor](https://github.com/fidpa/telegram-multi-device-monitor) -- Multi-device monitoring via Telegram (Python/Bash, alert deduplication)
- [ubuntu-server-security](https://github.com/fidpa/ubuntu-server-security) -- Server hardening (14 components, CIS Benchmark)
- [step-ca-internal-pki](https://github.com/fidpa/step-ca-internal-pki) -- Internal PKI with auto-renewal and monitoring
- [bash-production-toolkit](https://github.com/fidpa/bash-production-toolkit) -- Production-ready Bash libraries

---

**Production-tested since January 2026** | 24 security layers | ~3,500 lines TypeScript | ~1,200 lines documentation
