#!/usr/bin/env node
// Deterministic Node ESM fake `pi` v1.5.2 binary for ZCode M1-M4 verification & E2E tests.
// Supports `--version`, `update`, `install`/`remove`/`list`, `--export`, `-p`/`--print`, and `--mode rpc`.
// Strict LF (`\n`) framing; never spawns a shell or touches real user home directories.
import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { createRpcCommandHandler } from "./fake-pi-commands.mjs";
import {
  FAKE_PI_MODELS,
  FAKE_PI_REASONING_LEVELS,
  FAKE_PI_VERSION,
  createSessionStore,
  parseCliArgs,
  writeHtmlExport,
} from "./fake-pi-session.mjs";
import { executeTurn } from "./fake-pi-turns.mjs";

async function readStdinAll() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runPrintMode(opts) {
  let prompt = opts.promptParts.join(" ").trim();
  if (!prompt) {
    prompt = (await readStdinAll()).trim();
  }
  const lower = prompt.toLowerCase();
  if (lower.includes("commit") || lower.includes("diff")) {
    process.stdout.write("chore: update project files\n");
  } else if (lower.includes("title") || lower.includes("summarize")) {
    process.stdout.write("Session Summary\n");
  } else {
    process.stdout.write("Fake Pi side-question response.\n");
  }
}

function runRpcServer(opts) {
  const cwd = process.cwd();
  let activeModel = FAKE_PI_MODELS[0];
  if (opts.model) {
    let prov = opts.provider;
    let modId = opts.model;
    if (!prov && modId.includes("/")) {
      const slashIdx = modId.indexOf("/");
      prov = modId.slice(0, slashIdx);
      modId = modId.slice(slashIdx + 1);
    }
    const found = FAKE_PI_MODELS.find((model) =>
      prov ? model.provider === prov && model.id === modId : model.id === modId,
    );
    if (found) activeModel = found;
  }

  let initialThinking =
    opts.thinking && FAKE_PI_REASONING_LEVELS.includes(opts.thinking) ? opts.thinking : "medium";
  if (!activeModel.reasoning) initialThinking = "off";

  const state = {
    activeModel,
    thinkingLevel: initialThinking,
    autoCompactionEnabled: true,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    isStreaming: false,
    isCompacting: false,
    abortCurrentRun: false,
    useCrlf: false,
    steeringQueue: [],
    followUpQueue: [],
    pendingUiResolvers: new Map(),
  };

  const session = createSessionStore(opts, cwd);

  function serializeRecord(obj) {
    const eol = state.useCrlf ? "\r\n" : "\n";
    return `${JSON.stringify(obj)}${eol}`;
  }

  function sendJson(obj) {
    process.stdout.write(serializeRecord(obj));
  }

  function buildResponse(id, command, success, data, error) {
    const payload = { type: "response", command, success };
    if (id !== undefined) payload.id = id;
    if (success && data !== undefined) payload.data = data;
    if (!success) payload.error = error ?? `Command ${command} failed`;
    return payload;
  }

  function sendResponse(id, command, success, data, error) {
    sendJson(buildResponse(id, command, success, data, error));
  }

  function emitQueueUpdate() {
    sendJson({
      type: "queue_update",
      steering: [...state.steeringQueue],
      followUp: [...state.followUpQueue],
    });
  }

  function waitForExtensionUiResponse(reqId) {
    return new Promise((resolve) => {
      state.pendingUiResolvers.set(reqId, resolve);
    });
  }

  function runCoalescedPrompt(id, messageText, images) {
    const userContent = [{ type: "text", text: messageText }];
    for (const img of images) {
      if (img && img.type === "image") userContent.push(img);
    }
    const now = Date.now();
    const userMsg = { role: "user", content: userContent, timestamp: now };
    const replyText = `Fake Pi coalesced reply to: ${messageText}`;
    const finalAsst = {
      role: "assistant",
      content: [{ type: "text", text: replyText }],
      api: state.activeModel.api,
      provider: state.activeModel.provider,
      model: state.activeModel.id,
      stopReason: "stop",
      usage: {
        input: 50,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 70,
        cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
      },
      timestamp: now,
    };
    session.appendEntry({ type: "message", message: userMsg });
    session.appendEntry({ type: "message", message: finalAsst });

    const records = [
      buildResponse(id, "prompt", true, { disposition: "started" }),
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: userMsg },
      { type: "message_end", message: userMsg },
      { type: "message_start", message: { ...finalAsst, content: [], stopReason: "pending" } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: replyText },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: replyText },
      },
      { type: "message_end", message: finalAsst },
      { type: "turn_end", message: finalAsst, toolResults: [] },
      { type: "agent_end", messages: [userMsg, finalAsst] },
      { type: "agent_settled", aborted: false },
    ];
    // Write every frame in a single stdout chunk to reproduce POSIX pipe coalescing deterministically.
    process.stdout.write(records.map(serializeRecord).join(""));
  }

  const turnContext = {
    sendJson,
    appendEntry: session.appendEntry,
    waitForExtensionUiResponse,
    getActiveModel: () => state.activeModel,
    getThinkingLevel: () => state.thinkingLevel,
    getLeafId: () => session.store.leafId,
    isAborted: () => state.abortCurrentRun,
    setUseCrlf: (next) => {
      state.useCrlf = next;
    },
    setCompacting: (next) => {
      state.isCompacting = next;
    },
  };

  async function runAgentLoop(initialPrompt, initialImages) {
    state.isStreaming = true;
    state.abortCurrentRun = false;
    sendJson({ type: "agent_start" });

    const runMessages = [];
    try {
      const firstMsgs = await executeTurn(initialPrompt, initialImages, turnContext);
      runMessages.push(...firstMsgs);

      while (
        !state.abortCurrentRun &&
        (state.steeringQueue.length > 0 || state.followUpQueue.length > 0)
      ) {
        const nextPrompt =
          state.steeringQueue.length > 0
            ? state.steeringQueue.shift()
            : state.followUpQueue.shift();
        emitQueueUpdate();
        if (nextPrompt !== undefined) {
          const nextMsgs = await executeTurn(nextPrompt, [], turnContext);
          runMessages.push(...nextMsgs);
        }
      }
    } finally {
      const wasAborted = state.abortCurrentRun;
      state.isStreaming = false;
      state.abortCurrentRun = false;
      sendJson({ type: "agent_end", messages: runMessages });
      sendJson({ type: "agent_settled", aborted: wasAborted });
    }
  }

  const handleCommand = createRpcCommandHandler({
    opts,
    cwd,
    state,
    session,
    sendJson,
    sendResponse,
    emitQueueUpdate,
    runCoalescedPrompt,
    runAgentLoop,
  });

  // Strict LF (`\n`) stdin framing — never splits on U+2028 / U+2029.
  const decoder = new StringDecoder("utf8");
  let stdinBuf = "";

  process.stdin.on("data", (chunk) => {
    stdinBuf += decoder.write(chunk);
    let nl = stdinBuf.indexOf("\n");
    while (nl !== -1) {
      let line = stdinBuf.slice(0, nl);
      stdinBuf = stdinBuf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim() !== "") {
        try {
          const parsed = JSON.parse(line);
          handleCommand(parsed);
        } catch (err) {
          sendResponse(undefined, "parse", false, undefined, `Invalid JSON: ${err.message}`);
        }
      }
      nl = stdinBuf.indexOf("\n");
    }
  });

  process.stdin.on("end", () => {
    const shutdown = session.shutdownEntry();
    if (shutdown) appendFileSync(shutdown.file, `${JSON.stringify(shutdown.entry)}\n`, "utf8");
    process.exit(0);
  });
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.version) {
    process.stdout.write(`${FAKE_PI_VERSION}\n`);
    process.exit(0);
  }
  if (opts.subcommand === "update") {
    process.stdout.write(`Updated @earendil-works/pi-coding-agent to ${FAKE_PI_VERSION}\n`);
    process.exit(0);
  }
  if (opts.subcommand === "install") {
    const pkg = opts.subcommandArgs[0] ?? "package";
    process.stdout.write(`Installed ${pkg}\n`);
    process.exit(0);
  }
  if (opts.subcommand === "remove") {
    const pkg = opts.subcommandArgs[0] ?? "package";
    process.stdout.write(`Removed ${pkg}\n`);
    process.exit(0);
  }
  if (opts.subcommand === "list") {
    process.stdout.write(`@earendil-works/pi-coding-agent@${FAKE_PI_VERSION} (installed)\n`);
    process.exit(0);
  }
  if (opts.exportSource) {
    const outPath = writeHtmlExport(opts.exportSource, opts.exportOutput);
    process.stdout.write(`Exported session to ${outPath}\n`);
    process.exit(0);
  }
  if (opts.mode === "rpc") {
    runRpcServer(opts);
    return;
  }
  if (opts.print) {
    await runPrintMode(opts);
    process.exit(0);
  }

  process.stdout.write(`pi ${FAKE_PI_VERSION}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
