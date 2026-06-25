# Codex Telegram Bot

Telegram long-polling bridge for Codex CLI. It lets an allowlisted Telegram chat run one Codex task at a time on this server without opening the Codex web UI.

## Setup

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Required values:

- `TELEGRAM_BOT_TOKEN`: token from BotFather.
- `ALLOWED_CHAT_IDS`: comma-separated Telegram chat IDs allowed to use the bot.
- `CODEX_WORKDIR`: directory where Codex runs. Defaults to `./workspace`.

Start:

```bash
npm start
```

## Commands

- `/start` or `/help`: show help.
- `/status`: show whether a Codex task is running.
- `/whoami`: show server, workspace, and Codex version.
- `/codex <task>`: run a new non-interactive Codex task.
- `/resume <task>`: continue the last non-interactive Codex session.
- `/cancel`: stop the currently running Codex process.

## Safety

- Only chats listed in `ALLOWED_CHAT_IDS` can run commands.
- The bot runs `codex exec` with `--sandbox workspace-write` by default.
- The bot allows only one active Codex task at a time.
- `.env`, logs, and workspace contents are ignored by git.
