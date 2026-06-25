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
const chatState = new Map();

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Codex Telegram Bot started. Workspace: ${codexWorkdir}`);
await configureBotCommands();
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
        allowed_updates: ["message", "callback_query"],
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
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

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
    const state = chatState.get(chatId);
    await sendMessage(
      chatId,
      currentTask
        ? `Running: ${currentTask.label}\nStarted: ${currentTask.startedAt.toISOString()}`
        : `Idle.${state?.activeSessionId ? `\nActive session: ${shortId(state.activeSessionId)}` : ""}`,
    );
    return;
  }

  if (text === "/whoami") {
    await sendMessage(chatId, await whoamiText());
    return;
  }

  if (text === "/new" || text === "/clear") {
    setChatState(chatId, { shouldResume: false, activeSessionId: "" });
    await sendMessage(chatId, "New Codex conversation ready.");
    return;
  }

  if (text === "/history") {
    await sendHistory(chatId);
    return;
  }

  if (text === "/cancel") {
    await cancelTask(chatId);
    return;
  }

  if (text.startsWith("/codex ")) {
    await runCodex(chatId, text.slice("/codex ".length).trim(), { resume: false });
    return;
  }

  if (text.startsWith("/resume ")) {
    const state = getChatState(chatId);
    await runCodex(chatId, text.slice("/resume ".length).trim(), {
      resume: true,
      sessionId: state.activeSessionId,
    });
    return;
  }

  if (text.startsWith("/")) {
    await sendMessage(chatId, "Unknown command. Use /help.");
    return;
  }

  const state = getChatState(chatId);
  await runCodex(chatId, text, {
    resume: state.shouldResume,
    sessionId: state.activeSessionId,
  });
}

function helpText() {
  return [
    "Codex Telegram Bot",
    "",
    "/new - start a fresh Codex conversation on the next message",
    "/clear - same as /new",
    "/history - choose a recorded Codex session",
    "/status - show current task",
    "/whoami - show server and Codex info",
    "/codex <task> - force a new Codex task",
    "/resume <task> - force resume of the last Codex exec session",
    "/cancel - stop the running task",
    "",
    "Send any normal message to talk to Codex.",
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
      { timeout: 30_000, env: runtimeEnv() },
      (error, stdout, stderr) => {
        resolve(error ? stderr || error.message : stdout);
      },
    );
  });
}

async function runCodex(chatId, prompt, options = {}) {
  const { resume = false, sessionId = "" } = options;
  if (!prompt) {
    await sendMessage(chatId, resume ? "Usage: /resume <task>" : "Usage: /codex <task>");
    return;
  }

  if (currentTask) {
    await sendMessage(chatId, "A Codex task is already running. Use /cancel first.");
    return;
  }

  const { command, args, cwd } = buildCodexCommand(prompt, { resume, sessionId });

  const statusMessage = await sendMessage(chatId, "思考中...");
  const statusMessageId = statusMessage?.result?.message_id;

  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  let streamedReply = "";
  let streamSessionId = sessionId;
  let lastStatusEditAt = 0;
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
    const text = chunk.toString();
    stdout = appendBounded(stdout, text, maxOutputChars);
    lineBuffer = processCodexJsonLines({
      chatId,
      messageId: statusMessageId,
      input: lineBuffer + text,
      onReply: (reply) => {
        streamedReply = reply;
      },
      onSession: (nextSessionId) => {
        streamSessionId = nextSessionId;
      },
      onStatus: (status) => {
        const now = Date.now();
        if (now - lastStatusEditAt < 1200) {
          return;
        }
        lastStatusEditAt = now;
        void editMessage(chatId, statusMessageId, status);
      },
    });
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
      const reply = streamedReply || extractCodexReply(finalOutput);
      const sessionIdFromOutput = streamSessionId || extractSessionId(finalOutput) || sessionId;
      const state = getChatState(chatId);
      if (sessionIdFromOutput) {
        rememberSession(state, sessionIdFromOutput, prompt);
      }
      setChatState(chatId, {
        shouldResume: true,
        activeSessionId: sessionIdFromOutput || state.activeSessionId,
        history: state.history,
      });
      if (reply && reply.length <= 3900 && statusMessageId) {
        await editMessage(chatId, statusMessageId, reply);
      } else {
        await deleteMessage(chatId, statusMessageId);
        await sendLongMessage(chatId, reply || header);
      }
    } else if (diagnostic) {
      await deleteMessage(chatId, statusMessageId);
      await sendLongMessage(chatId, `${header}\n\n${tail(diagnostic, 3000)}`);
    } else {
      if (statusMessageId) {
        await editMessage(chatId, statusMessageId, header);
      } else {
        await sendMessage(chatId, header);
      }
    }
  });
}

function buildCodexCommand(prompt, options = {}) {
  const { resume = false, sessionId = "" } = options;
  if (execMode === "zeabur") {
    const codexArgs = resume
      ? [
          "--cd",
          codexTargetWorkdir,
          "--ask-for-approval",
          codexApproval,
          "exec",
          "--skip-git-repo-check",
          "--json",
          "resume",
          ...(sessionId ? [sessionId] : ["--last"]),
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
          "--json",
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
      ? [
          "--ask-for-approval",
          codexApproval,
          "exec",
          "--skip-git-repo-check",
          "--json",
          "resume",
          ...(sessionId ? [sessionId] : ["--last"]),
          prompt,
        ]
      : [
          "--ask-for-approval",
          codexApproval,
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          codexSandbox,
          "--json",
          ...(codexModel ? ["--model", codexModel] : []),
          prompt,
        ],
    cwd: codexWorkdir,
  };
}

function getChatState(chatId) {
  const state = chatState.get(chatId);
  if (state) {
    return state;
  }
  const next = { shouldResume: false, activeSessionId: "", history: [] };
  chatState.set(chatId, next);
  return next;
}

function setChatState(chatId, patch) {
  const state = getChatState(chatId);
  chatState.set(chatId, { ...state, ...patch });
}

function rememberSession(state, sessionId, prompt) {
  const current = state.history.find((item) => item.id === sessionId);
  const existing = state.history.filter((item) => item.id !== sessionId);
  existing.unshift({
    id: sessionId,
    title: current?.title || prompt.replace(/\s+/g, " ").slice(0, 60) || "Codex session",
    updatedAt: new Date().toISOString(),
  });
  state.history = existing.slice(0, 10);
}

async function sendHistory(chatId) {
  const state = getChatState(chatId);
  const remoteHistory = await loadCodexHistory();
  const knownIds = new Set(state.history.map((item) => item.id));
  for (const item of remoteHistory) {
    if (!knownIds.has(item.id)) {
      state.history.push(item);
      knownIds.add(item.id);
    }
  }
  state.history.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  state.history = state.history.slice(0, 20);

  if (!state.history.length) {
    await sendMessage(chatId, "No recorded sessions yet.");
    return;
  }

  await sendMessage(chatId, "Choose a Codex session:", {
    reply_markup: {
      inline_keyboard: state.history.map((item) => [
        {
          text: `${shortId(item.id)} ${item.title}`,
          callback_data: `history:${item.id}`,
        },
      ]),
    },
  });
}

async function loadCodexHistory() {
  const output =
    execMode === "zeabur"
      ? await execFileText("zeabur", [
          "service",
          "exec",
          "--id",
          codexTargetServiceId,
          "--env-id",
          codexTargetEnvId,
          "--",
          "sh",
          "-lc",
          "cat ~/.codex/history.jsonl 2>/dev/null || true",
        ])
      : await execFileText("sh", [
          "-lc",
          "cat ~/.codex/history.jsonl 2>/dev/null || true",
        ]);

  const bySession = new Map();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const entry = JSON.parse(trimmed);
      if (!entry.session_id || !entry.text) {
        continue;
      }

      const updatedAt = new Date(Number(entry.ts || 0) * 1000).toISOString();
      const current = bySession.get(entry.session_id);
      if (current) {
        current.updatedAt = updatedAt;
      } else {
        bySession.set(entry.session_id, {
          id: entry.session_id,
          title: String(entry.text).replace(/\s+/g, " ").slice(0, 60),
          updatedAt,
        });
      }
    } catch {
      // Ignore partial or non-JSON log lines emitted around service exec.
    }
  }

  return [...bySession.values()]
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, 20);
}

async function handleCallbackQuery(query) {
  const chatId = String(query.message?.chat?.id || "");
  if (!chatId || !allowedChatIds.has(chatId)) {
    await telegram("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Unauthorized chat.",
      show_alert: true,
    });
    return;
  }

  const data = query.data || "";
  if (data.startsWith("history:")) {
    const sessionId = data.slice("history:".length);
    setChatState(chatId, { shouldResume: true, activeSessionId: sessionId });
    await telegram("answerCallbackQuery", {
      callback_query_id: query.id,
      text: `Selected ${shortId(sessionId)}`,
    });
    await sendMessage(chatId, `Selected session ${shortId(sessionId)}. Send a message to continue.`);
    return;
  }

  await telegram("answerCallbackQuery", {
    callback_query_id: query.id,
    text: "Unknown action.",
  });
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

function extractSessionId(output) {
  const clean = stripAnsi(output);
  const match = clean.match(/session id:\s*([0-9a-f-]{36})/i);
  return match ? match[1] : "";
}

function extractCodexReply(output) {
  const jsonReply = extractCodexJsonReply(output);
  if (jsonReply) {
    return jsonReply;
  }

  const clean = stripAnsi(output).trim();
  const lines = clean.split(/\r?\n/);
  const markerIndex = findLastLine(lines, "codex");

  if (markerIndex === -1) {
    return clean;
  }

  const replyLines = [];
  for (const line of lines.slice(markerIndex + 1)) {
    if (line.trim() === "tokens used") {
      break;
    }
    replyLines.push(line);
  }

  return replyLines.join("\n").trim() || clean;
}

function extractCodexJsonReply(output) {
  let reply = "";
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed);
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        reply = event.item.text || reply;
      }
    } catch {
      // Ignore non-JSON wrapper output.
    }
  }
  return reply.trim();
}

function processCodexJsonLines({ chatId, messageId, input, onReply, onSession, onStatus }) {
  const lines = input.split(/\r?\n/);
  const rest = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed);
      if (event.type === "thread.started" && event.thread_id) {
        onSession(event.thread_id);
        onStatus(`已连接会话 ${shortId(event.thread_id)}，思考中...`);
      } else if (event.type === "turn.started") {
        onStatus("已开始处理...");
      } else if (event.type === "item.started") {
        onStatus(describeStartedItem(event.item));
      } else if (event.type === "item.completed") {
        if (event.item?.type === "agent_message" && event.item.text) {
          onReply(event.item.text.trim());
          void editMessage(chatId, messageId, event.item.text.trim().slice(0, 3900));
        } else {
          onStatus(describeCompletedItem(event.item));
        }
      }
    } catch {
      // Ignore non-JSON wrapper output.
    }
  }

  return rest;
}

function describeStartedItem(item) {
  if (!item?.type) {
    return "处理中...";
  }
  if (item.type === "command_execution") {
    return `执行命令中: ${item.command || ""}`.slice(0, 3900);
  }
  if (item.type === "reasoning") {
    return "思考中...";
  }
  return `处理中: ${item.type}`;
}

function describeCompletedItem(item) {
  if (!item?.type) {
    return "处理中...";
  }
  if (item.type === "command_execution") {
    return `命令完成: ${item.command || ""}`.slice(0, 3900);
  }
  if (item.type === "reasoning") {
    return "思考完成，整理回复...";
  }
  return `已完成: ${item.type}`;
}

function findLastLine(lines, target) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === target) {
      return index;
    }
  }
  return -1;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function shortId(sessionId) {
  return sessionId ? sessionId.slice(0, 8) : "";
}

async function configureBotCommands() {
  try {
    await telegram("setMyCommands", {
      commands: [
        { command: "new", description: "Start a fresh Codex conversation" },
        { command: "clear", description: "Start a fresh Codex conversation" },
        { command: "history", description: "Choose a recorded Codex session" },
        { command: "status", description: "Show current task" },
        { command: "cancel", description: "Stop the running task" },
        { command: "whoami", description: "Show server and Codex info" },
        { command: "help", description: "Show help" },
      ],
    });
  } catch (error) {
    console.error(`Failed to configure bot commands: ${error.message}`);
  }
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

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
}

async function editMessage(chatId, messageId, text) {
  if (!messageId || !text) {
    return null;
  }

  try {
    return await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, 3900),
      disable_web_page_preview: true,
    });
  } catch (error) {
    if (!/message is not modified/i.test(error.message)) {
      console.error(`Failed to edit message: ${error.message}`);
    }
    return null;
  }
}

async function deleteMessage(chatId, messageId) {
  if (!messageId) {
    return null;
  }

  try {
    return await telegram("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (error) {
    console.error(`Failed to delete message: ${error.message}`);
    return null;
  }
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
