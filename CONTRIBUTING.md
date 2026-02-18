# Contributing to cc-telegram-bot

Thank you for considering contributing to cc-telegram-bot! Contributions are welcome, whether it's bug reports, feature requests, documentation improvements, or code changes.

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainer.

## Getting Started

### Development Setup

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/cc-telegram-bot.git
   cd cc-telegram-bot
   ```
3. **Install dependencies**:
   ```bash
   bun install
   ```
4. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your Telegram bot token and user ID
   ```

### Project Structure

```
cc-telegram-bot/
+-- src/               # TypeScript source code
|   +-- handlers/      # Message type handlers
|   +-- config.ts      # Environment & safety configuration
|   +-- security.ts    # Rate limiting, path validation, command safety
|   +-- session.ts     # Claude Agent SDK session management
|   +-- ...
+-- ask_user_mcp/      # MCP server for Telegram inline keyboards
+-- launchagent/       # macOS LaunchAgent for always-on operation
+-- docs/              # Documentation (security, audit report)
+-- CLAUDE.md          # System prompt (loaded by Claude)
```

## How to Contribute

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When you create a bug report, include:

- A clear and descriptive title
- Exact steps to reproduce the problem
- Expected vs. actual behavior
- Your environment (Bun version, OS, Node version)
- Relevant logs or error messages

### Suggesting Features

Feature requests are welcome. Please provide:

- A clear description of the problem you're trying to solve
- Your proposed solution
- Any alternative solutions you've considered

### Pull Requests

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following the coding standards below

3. **Run type checking**:
   ```bash
   bun run typecheck
   ```

4. **Commit your changes** with a conventional commit message:
   ```bash
   git commit -m "feat: add your feature description"
   ```

5. **Push to your fork** and **open a Pull Request**

## Coding Standards

- **TypeScript**: Strict mode enabled, fix all type errors before committing
- **Immutability**: Create new objects instead of mutating existing ones
- **Error handling**: Wrap risky operations in try/catch with descriptive messages
- **File size**: Keep files under 800 lines, extract when growing beyond
- **Functions**: Keep under 50 lines, single responsibility
- **No `console.log`**: Use the audit logging utilities in `src/utils.ts`

### Commit Message Format

```
<type>: <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`

## Security Contributions

If you discover a security vulnerability, please do NOT open a public issue. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## Questions?

- **GitHub Issues**: For project-related questions
- **Pull Request comments**: For implementation details
