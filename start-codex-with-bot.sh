#!/bin/sh
set -eu

cd /home/node/codex-telegram-bot

if ! pgrep -f "node src/index.js" >/dev/null 2>&1; then
  setsid ./run-bot-supervisor.sh >/dev/null 2>&1 &
fi

exec /opt/startup.sh
