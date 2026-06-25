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
- `EXEC_MODE`: `local` runs Codex inside the bot container; `zeabur` runs Codex in another Zeabur service through `zeabur service exec`.
- `ZEABUR_TOKEN`: required when `EXEC_MODE=zeabur`.
- `CODEX_TARGET_SERVICE_ID`: target Zeabur service ID that already has Codex CLI and auth.
- `CODEX_TARGET_ENV_ID`: target Zeabur environment ID.
- `CODEX_TARGET_WORKDIR`: working directory passed to Codex with `--cd` in the target service.

Start:

```bash
npm start
```

## Commands

- `/start` or `/help`: show help.
- `/status`: show whether a Codex task is running.
- `/history`: choose one of the recent Codex sessions from the target Codex service.
- `/whoami`: show server, workspace, and Codex version.
- `/codex <task>`: run a new non-interactive Codex task.
- `/resume <task>`: continue the last non-interactive Codex session.
- Any normal message: send it directly to Codex. The bot resumes the previous Codex session unless `/new` or `/clear` was used.
- `/new` or `/clear`: make the next normal message start a fresh Codex session.
- `/cancel`: stop the currently running Codex process.

The bot registers Telegram slash commands with `setMyCommands`, so typing `/` in Telegram should show the command menu after the latest deployment starts. In `EXEC_MODE=zeabur`, `/history` reads `~/.codex/history.jsonl` from the target Codex service through `zeabur service exec`; each button uses the first user message as its title and sorts sessions by latest activity.

Codex runs with JSON event output. The bot edits one Telegram message as status/events arrive and replaces it with the final answer, so the temporary processing message does not remain in chat. Token-by-token streaming depends on the Codex CLI event output available from the target service.

## Safety

- Only chats listed in `ALLOWED_CHAT_IDS` can run commands.
- The bot runs `codex exec` with `--sandbox workspace-write` by default.
- In `EXEC_MODE=zeabur`, the bot runs `zeabur service exec` against the target Codex service.
- The bot allows only one active Codex task at a time.
- `.env`, logs, and workspace contents are ignored by git.
