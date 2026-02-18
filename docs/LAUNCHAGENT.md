# macOS LaunchAgent Setup

Run cc-telegram-bot as a persistent background service on macOS using `launchd`.

## Overview

A LaunchAgent starts the bot automatically on login and restarts it if it crashes. This is the macOS equivalent of a Linux systemd service.

## Setup

### 1. Customize the plist Template

```bash
cd cc-telegram-bot/launchagent

# Copy the template
cp com.cc-telegram-bot.plist.template ~/Library/LaunchAgents/com.cc-telegram-bot.plist
```

Edit `~/Library/LaunchAgents/com.cc-telegram-bot.plist` and replace:
- `/Users/USERNAME/` with your actual home directory path
- Bot token and allowed users with your values
- Working directory with your preferred Claude working directory

### 2. Customize the Start Script

```bash
# Edit launchagent/start.sh
# Update the cd path to your bot installation directory
```

### 3. Create the Log Directory

```bash
mkdir -p ~/.cc-telegram-bot
chmod 700 ~/.cc-telegram-bot
```

### 4. Load the LaunchAgent

```bash
launchctl load ~/Library/LaunchAgents/com.cc-telegram-bot.plist
```

## Managing the Service

### Start

```bash
launchctl start com.cc-telegram-bot
```

### Stop

```bash
launchctl stop com.cc-telegram-bot
```

### Restart

```bash
launchctl stop com.cc-telegram-bot && launchctl start com.cc-telegram-bot
```

### Unload (Disable)

```bash
launchctl unload ~/Library/LaunchAgents/com.cc-telegram-bot.plist
```

### Check Status

```bash
launchctl list | grep cc-telegram-bot
```

The output shows: PID, last exit status, and label. A PID of `-` means the service is not running.

### View Logs

```bash
tail -f ~/.cc-telegram-bot/bot.log
```

## Shell Aliases

Add these to your `~/.zshrc` or `~/.bashrc` for convenience:

```bash
alias ccbot-start='launchctl start com.cc-telegram-bot'
alias ccbot-stop='launchctl stop com.cc-telegram-bot'
alias ccbot-restart='launchctl stop com.cc-telegram-bot && sleep 1 && launchctl start com.cc-telegram-bot'
alias ccbot-logs='tail -f ~/.cc-telegram-bot/bot.log'
alias ccbot-status='launchctl list | grep cc-telegram-bot'
```

## Log Files

| File | Description |
|------|-------------|
| `~/.cc-telegram-bot/bot.log` | stdout (bot output, startup messages) |
| `~/.cc-telegram-bot/bot.err` | stderr (errors, warnings) |
| `~/.cc-telegram-bot/audit.log` | Audit log (all interactions, HMAC-signed) |

All log files are in a directory with 0o700 permissions (owner-only access).

## Security Considerations

The plist template includes environment variables for the bot token and allowed users. Since LaunchAgent plist files are stored in `~/Library/LaunchAgents/` (user-readable only), this is acceptable for personal use.

For additional security:
- The `start.sh` script sources `.env` from the project directory, so you can keep secrets in `.env` instead of the plist
- The log directory uses restricted permissions (0o700)
- Logs are not written to world-readable `/tmp`

## Troubleshooting

### Bot doesn't start

1. Check the error log: `cat ~/.cc-telegram-bot/bot.err`
2. Verify the plist is loaded: `launchctl list | grep cc-telegram-bot`
3. Verify bun is in the PATH specified in the plist
4. Test manually: `bash launchagent/start.sh`

### Bot starts but crashes immediately

1. Check for missing environment variables in `.env`
2. Verify the Telegram bot token is valid
3. Check if another instance is already running: `pgrep -f "bun.*cc-telegram-bot"`

### Changes to .env not picked up

The LaunchAgent caches environment variables. After changing `.env`:

```bash
launchctl stop com.cc-telegram-bot && launchctl start com.cc-telegram-bot
```

If using environment variables directly in the plist, you need to unload and reload:

```bash
launchctl unload ~/Library/LaunchAgents/com.cc-telegram-bot.plist
launchctl load ~/Library/LaunchAgents/com.cc-telegram-bot.plist
```

## Linux Alternative (systemd)

On Linux, use a systemd service instead. See the [Customization Guide](../README.md#deploy-on-linux-systemd) in the README.
