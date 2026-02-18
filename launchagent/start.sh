#!/bin/bash
set -e

# Change to your bot installation directory
cd "$(dirname "$0")/.."

# Source environment variables
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

# Run the bot
exec bun run src/index.ts
