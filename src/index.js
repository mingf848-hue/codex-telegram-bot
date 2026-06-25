import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
loadDotEnv(path.join(projectRoot, ".env"));

const token = requireEnv("TELEGRAM_BOT_TOKEN");
const allowedChatIds = new Set(
  requireEnv("ALLOWED_CHAT_IDS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const codexWorkdir = path.resolve(
  process.env.CODEX_WORKDIR || path.join(projectRoot, "workspace"),
);
const codexSandbox = process.env.CODEX_SANDBOX || "workspace-write";
const codexApproval = process.env.CODEX_APPROVAL || "never";
const codexModel = process.env.CODEX_MODEL || "";
const execMode = process.env.EXEC_MODE || "local";
const zeaburToken = process.env.ZEABUR_TOKEN || "";
const codexTargetServiceId = process.env.CODEX_TARGET_SERVICE_ID || "";
const codexTargetEnvId = process.env.CODEX_TARGET_ENV_ID || "";
const codexTargetWorkdir = process.env.CODEX_TARGET_WORKDIR || "/home/node";
const maxTaskMs = Number(process.env.MAX_TASK_MS || 15 * 60 * 1000);
const maxOutputChars = Number(process.env.MAX_OUTPUT_CHARS || 32_000);
const apiBase = `https://api.telegram.org/bot${token}`;

fs.mkdirSync(codexWorkdir, { recursive: true });

if (execMode === "zeabur") {
  if (!zeaburToken || !codexTargetServiceId || !codexTargetEnvId) {
    console.error(
      "EXEC_MODE=zeabur requires ZEABUR_TOKEN, CODEX_TARGET_SERVICE_ID, and CODEX_TARGET_ENV_ID.",
    );
    process.exit(1);
  }
  await ensureZeaburLogin();
}

let updateOffset = 0;
let currentTask = null;

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Codex Telegram Bot started. Workspace: ${codexWorkdir}`);
await sendStartupMessage();
await pollLoop();

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function pollLoop() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset: updateOffset,
        timeout: 50,
        allowed_updates: ["message"],
      });

      for (const update of updates.result || []) {
        updateOffset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error(`Polling error: ${error.message}`);
      await sleep(3000);
    }
  }
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message || !message.chat || typeof message.text !== "string") {
    return;
  }

  const chatId = String(message.chat.id);
  if (!allowedChatIds.has(chatId)) {
    await sendMessage(chatId, "Unauthorized chat.");
    return;
  }

  const text = message.text.trim();
  if (text === "/start" || text === "/help") {
    await sendMessage(chatId, helpText());
    return;
  }

  if (text === "/status") {
    await sendMessage(
      chatId,
      currentTask
        ? `Running: ${currentTask.label}\nStarted: ${currentTask.startedAt.toISOString()}`
        : "Idle.",
    );
    return;
  }

  if (text === "/whoami") {
    await sendMessage(chatId, await whoamiText());
    return;
  }

  if (text === "/cancel") {
    await cancelTask(chatId);
    return;
  }

  if (text.startsWith("/codex ")) {
    await runCodex(chatId, text.slice("/codex ".length).trim(), false);
    return;
  }

  if (text.startsWith("/resume ")) {
    await runCodex(chatId, text.slice("/resume ".length).trim(), true);
    return;
  }

  await sendMessage(chatId, "Unknown command. Use /help.");
}

function helpText() {
  return [
    "Codex Telegram Bot",
    "",
    "/status - show current task",
    "/whoami - show server and Codex info",
    "/codex <task> - run a new Codex task",
    "/resume <task> - continue the last Codex exec session",
    "/cancel - stop the running task",
    "",
    `Workspace: ${codexWorkdir}`,
  ].join("\n");
}

async function whoamiText() {
  const codexVersion = await execFileText("codex", ["--version"]);
  return [
    `Host: ${os.hostname()}`,
    `User: ${os.userInfo().username}`,
    `Node: ${process.version}`,
    `Codex: ${codexVersion.trim() || "unknown"}`,
    `Exec mode: ${execMode}`,
    `Workspace: ${codexWorkdir}`,
    execMode === "zeabur" ? `Target service: ${codexTargetServiceId}` : "",
    execMode === "zeabur" ? `Target workdir: ${codexTargetWorkdir}` : "",
    `Sandbox: ${codexSandbox}`,
    `Approval: ${codexApproval}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function execFileText(command, args) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 10_000, env: runtimeEnv() },
      (error, stdout, stderr) => {
        resolve(error ? stderr || error.message : stdout);
      },
    );
  });
}

async function runCodex(chatId, prompt, resume) {
  if (!prompt) {
    await sendMessage(chatId, resume ? "Usage: /resume <task>" : "Usage: /codex <task>");
    return;
  }

  if (currentTask) {
    await sendMessage(chatId, "A Codex task is already running. Use /cancel first.");
    return;
  }

  const { command, args, cwd } = buildCodexCommand(prompt, resume);

  await sendMessage(
    chatId,
    execMode === "zeabur"
      ? `Starting Codex task in Zeabur service ${codexTargetServiceId}`
      : `Starting Codex task in ${codexWorkdir}`,
  );

  let stdout = "";
  let stderr = "";
  const child = spawn(command, args, {
    cwd,
    env: runtimeEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, maxTaskMs);

  currentTask = {
    child,
    label: prompt.slice(0, 120),
    startedAt: new Date(),
  };

  child.stdout.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk.toString(), maxOutputChars);
  });

  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk.toString(), maxOutputChars);
  });

  child.on("error", async (error) => {
    clearTimeout(timeout);
    currentTask = null;
    await sendMessage(chatId, `Failed to start Codex: ${error.message}`);
  });

  child.on("close", async (code, signal) => {
    clearTimeout(timeout);
    currentTask = null;

    const finalOutput = stdout.trim();
    const diagnostic = stderr.trim();
    const header =
      code === 0
        ? "Codex completed."
        : `Codex exited with code ${code}${signal ? `, signal ${signal}` : ""}.`;

    if (finalOutput) {
      await sendLongMessage(chatId, `${header}\n\n${finalOutput}`);
    } else if (diagnostic) {
      await sendLongMessage(chatId, `${header}\n\n${tail(diagnostic, 3000)}`);
    } else {
      await sendMessage(chatId, header);
    }
  });
}

function buildCodexCommand(prompt, resume) {
  if (execMode === "zeabur") {
    const codexArgs = resume
      ? [
          "--cd",
          codexTargetWorkdir,
          "--ask-for-approval",
          codexApproval,
          "exec",
          "resume",
          "--last",
          prompt,
        ]
      : [
          "--cd",
          codexTargetWorkdir,
          "--ask-for-approval",
          codexApproval,
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          codexSandbox,
          "--color",
          "never",
          ...(codexModel ? ["--model", codexModel] : []),
          prompt,
        ];

    return {
      command: "zeabur",
      args: [
        "service",
        "exec",
        "--id",
        codexTargetServiceId,
        "--env-id",
        codexTargetEnvId,
        "--",
        "codex",
        ...codexArgs,
      ],
      cwd: projectRoot,
    };
  }

  return {
    command: "codex",
    args: resume
      ? ["--ask-for-approval", codexApproval, "exec", "resume", "--last", prompt]
      : [
          "--ask-for-approval",
          codexApproval,
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          codexSandbox,
          "--color",
          "never",
          ...(codexModel ? ["--model", codexModel] : []),
          prompt,
        ],
    cwd: codexWorkdir,
  };
}

async function ensureZeaburLogin() {
  const output = await execFileText("zeabur", ["auth", "login", "--token", zeaburToken]);
  if (/error|failed|invalid/i.test(output)) {
    console.error(`Zeabur login failed: ${output}`);
    process.exit(1);
  }
}

function runtimeEnv() {
  return {
    ...process.env,
    PATH: `${path.join(projectRoot, "node_modules", ".bin")}:${process.env.PATH || ""}`,
  };
}

async function cancelTask(chatId) {
  if (!currentTask) {
    await sendMessage(chatId, "No task is running.");
    return;
  }

  currentTask.child.kill("SIGTERM");
  await sendMessage(chatId, "Cancellation requested.");
}

function appendBounded(existing, next, limit) {
  const value = existing + next;
  if (value.length <= limit) {
    return value;
  }
  return value.slice(value.length - limit);
}

function tail(value, limit) {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

async function sendStartupMessage() {
  for (const chatId of allowedChatIds) {
    try {
      await sendMessage(chatId, "Codex Telegram Bot is online. Use /help.");
    } catch (error) {
      console.error(`Startup message failed for ${chatId}: ${error.message}`);
    }
  }
}

async function sendLongMessage(chatId, text) {
  const chunkSize = 3900;
  for (let index = 0; index < text.length; index += chunkSize) {
    await sendMessage(chatId, text.slice(index, index + chunkSize));
  }
}

async function sendMessage(chatId, text) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function telegram(method, payload) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.description || `Telegram API ${response.status}`);
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown() {
  if (currentTask) {
    currentTask.child.kill("SIGTERM");
  }
  process.exit(0);
}
