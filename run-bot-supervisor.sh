#!/bin/sh
cd /home/node/codex-telegram-bot || exit 1

while true; do
  npm start >> bot.log 2>&1
  echo "Bot exited at $(date -Is), restarting in 5s" >> bot.log
  sleep 5
done
