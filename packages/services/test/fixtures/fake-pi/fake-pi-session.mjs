// Deterministic fake Pi v1.5.2 model catalog, CLI option parser, and v3 JSONL session manager.
// Zero external dependencies; never writes to real user home directories.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const FAKE_PI_VERSION = "1.5.2";

export const FAKE_PI_MODELS = [
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 16384,
  },
  {
    id: "gpt-5",
    name: "GPT-5",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 32768,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.04, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
];

export const FAKE_PI_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const FAKE_PI_COMMANDS = [
  {
    name: "review",
    description: "Review recent code changes",
    source: "skill",
    sourceInfo: {
      path: "/skills/review/SKILL.md",
      source: "local",
      scope: "project",
      origin: "top-level",
    },
  },
  {
    name: "explain",
    description: "Explain selected architecture",
    source: "prompt",
    sourceInfo: {
      path: "/prompts/explain.md",
      source: "local",
      scope: "user",
      origin: "top-level",
    },
  },
  {
    name: "deploy-check",
    description: "Run pre-deploy checklist",
    source: "extension",
    sourceInfo: {
      path: "/extensions/deploy.ts",
      source: "local",
      scope: "project",
      origin: "top-level",
    },
  },
];

export function shortId() {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export function extractMsgText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function writeHtmlExport(sourcePath, outputPath) {
  const resolvedOut = outputPath ?? `${sourcePath ?? "session"}.html`;
  mkdirSync(path.dirname(path.resolve(resolvedOut)), { recursive: true });
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>Pi Session Export</title></head><body><h1>Pi Session Export</h1></body></html>\n';
  writeFileSync(resolvedOut, html, "utf8");
  return path.resolve(resolvedOut);
}

export function parseCliArgs(argv) {
  const opts = {
    version: false,
    subcommand: null,
    subcommandArgs: [],
    print: false,
    mode: null,
    noSession: false,
    noTools: false,
    sessionFile: null,
    sessionDir: null,
    forkFrom: null,
    exportSource: null,
    exportOutput: null,
    provider: null,
    model: null,
    thinking: null,
    name: null,
    promptParts: [],
  };

  if (argv[0] === "update" || argv[0] === "install" || argv[0] === "remove" || argv[0] === "list") {
    opts.subcommand = argv[0];
    opts.subcommandArgs = argv.slice(1);
    return opts;
  }

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      opts.promptParts.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--version" || arg === "-v") {
      opts.version = true;
      i += 1;
    } else if (arg === "-p" || arg === "--print") {
      opts.print = true;
      i += 1;
    } else if (arg === "--no-session") {
      opts.noSession = true;
      i += 1;
    } else if (arg === "--no-tools") {
      opts.noTools = true;
      i += 1;
    } else if (arg === "--mode" && i + 1 < argv.length) {
      opts.mode = argv[i + 1];
      i += 2;
    } else if (arg === "--session" && i + 1 < argv.length) {
      opts.sessionFile = argv[i + 1];
      i += 2;
    } else if (arg === "--session-dir" && i + 1 < argv.length) {
      opts.sessionDir = argv[i + 1];
      i += 2;
    } else if (arg === "--fork" && i + 1 < argv.length) {
      opts.forkFrom = argv[i + 1];
      i += 2;
    } else if (arg === "--export" && i + 1 < argv.length) {
      opts.exportSource = argv[i + 1];
      if (i + 2 < argv.length && !argv[i + 2].startsWith("-")) {
        opts.exportOutput = argv[i + 2];
        i += 3;
      } else {
        i += 2;
      }
    } else if (arg === "--provider" && i + 1 < argv.length) {
      opts.provider = argv[i + 1];
      i += 2;
    } else if (arg === "--model" && i + 1 < argv.length) {
      opts.model = argv[i + 1];
      i += 2;
    } else if (arg === "--thinking" && i + 1 < argv.length) {
      opts.thinking = argv[i + 1];
      i += 2;
    } else if (arg === "--name" && i + 1 < argv.length) {
      opts.name = argv[i + 1];
      i += 2;
    } else if ((arg === "--skill" || arg === "--append-system-prompt") && i + 1 < argv.length) {
      i += 2;
    } else if (arg.startsWith("-")) {
      i += 1;
    } else {
      opts.promptParts.push(arg);
      i += 1;
    }
  }
  return opts;
}

export function createSessionStore(opts, cwd) {
  const store = {
    sessionId: randomUUID(),
    sessionName: opts.name ?? undefined,
    sessionFile: undefined,
    entries: [],
    leafId: null,
  };

  function ensureSessionDir() {
    if (opts.sessionDir) {
      mkdirSync(opts.sessionDir, { recursive: true });
      return opts.sessionDir;
    }
    const agentDir = process.env["PI_CODING_AGENT_DIR"];
    if (agentDir && agentDir.trim() !== "") {
      const resolvedCwd = path.resolve(cwd);
      const bucket = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
      const dir = path.join(agentDir.trim(), "sessions", bucket);
      mkdirSync(dir, { recursive: true });
      return dir;
    }
    const dir = path.join(os.tmpdir(), "fake-pi-sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function createFreshSessionFile(parentSession) {
    const dir = ensureSessionDir();
    store.sessionId = randomUUID();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}_${store.sessionId}.jsonl`);
    const header = {
      type: "session",
      version: 3,
      id: store.sessionId,
      timestamp: new Date().toISOString(),
      cwd,
      ...(parentSession ? { parentSession } : {}),
    };
    writeFileSync(file, `${JSON.stringify(header)}\n`, "utf8");
    store.sessionFile = file;
    store.entries = [];
    store.leafId = null;
  }

  function loadSessionFromDisk(filePath) {
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
    const loadedEntries = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "session") {
          store.sessionId = parsed.id ?? randomUUID();
        } else {
          loadedEntries.push(parsed);
          if (typeof parsed.id === "string") {
            store.leafId = parsed.id;
          }
          if (parsed.type === "session_info" && typeof parsed.name === "string") {
            store.sessionName = parsed.name;
          }
        }
      } catch {
        // Ignore malformed lines.
      }
    }
    store.sessionFile = filePath;
    store.entries = loadedEntries;
  }

  function appendEntry(entry) {
    const full = {
      id: shortId(),
      parentId: store.leafId,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    store.entries.push(full);
    store.leafId = full.id;
    if (!opts.noSession && store.sessionFile) {
      appendFileSync(store.sessionFile, `${JSON.stringify(full)}\n`, "utf8");
    }
    return full;
  }

  function shutdownEntry() {
    if (process.env["FAKE_PI_SHUTDOWN_ENTRY"] !== "1" || opts.noSession || !store.sessionFile) {
      return null;
    }
    return {
      file: store.sessionFile,
      entry: {
        type: "custom",
        id: shortId(),
        parentId: store.leafId,
        customType: "shutdown-state",
        data: {},
      },
    };
  }

  function getActiveBranchEntries() {
    if (store.entries.length === 0 || store.leafId === null) return [];
    const byId = new Map(store.entries.map((entry) => [entry.id, entry]));
    const chain = [];
    const seen = new Set();
    let cur = store.leafId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const item = byId.get(cur);
      if (!item) break;
      chain.push(item);
      cur = item.parentId ?? null;
    }
    chain.reverse();
    return chain;
  }

  function getActiveMessages() {
    return getActiveBranchEntries()
      .filter((entry) => entry.type === "message" && entry.message)
      .map((entry) => entry.message);
  }

  function getEntriesSince(sinceId) {
    if (!sinceId) return store.entries;
    const idx = store.entries.findIndex((entry) => entry.id === sinceId);
    if (idx === -1) return store.entries;
    return store.entries.slice(idx + 1);
  }

  function buildTreeNodes() {
    const byParent = new Map();
    for (const entry of store.entries) {
      const pid = entry.parentId ?? null;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(entry);
    }
    const toNode = (entry) => ({
      entry,
      children: (byParent.get(entry.id) ?? []).map(toNode),
    });
    return (byParent.get(null) ?? []).map(toNode);
  }

  function computeStats(activeModel) {
    const msgs = getActiveMessages();
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;

    for (const msg of msgs) {
      if (msg.role === "user") userMessages += 1;
      else if (msg.role === "assistant") {
        assistantMessages += 1;
        if (Array.isArray(msg.content)) {
          toolCalls += msg.content.filter((block) => block.type === "toolCall").length;
        }
        if (msg.usage) {
          input += msg.usage.input ?? 0;
          output += msg.usage.output ?? 0;
          cacheRead += msg.usage.cacheRead ?? 0;
          cacheWrite += msg.usage.cacheWrite ?? 0;
          cost += msg.usage.cost?.total ?? 0;
        }
      } else if (msg.role === "toolResult") {
        toolResults += 1;
      }
    }

    const total = input + output + cacheRead + cacheWrite;
    const contextWindow = activeModel.contextWindow ?? 200000;
    const percent =
      contextWindow > 0 ? Math.min(100, Number(((total / contextWindow) * 100).toFixed(2))) : 0;

    return {
      sessionFile: store.sessionFile,
      sessionId: store.sessionId,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: msgs.length,
      tokens: { input, output, cacheRead, cacheWrite, total },
      cost,
      contextUsage: { tokens: total, contextWindow, percent },
    };
  }

  if (!opts.noSession) {
    if (opts.forkFrom && existsSync(opts.forkFrom)) {
      loadSessionFromDisk(opts.forkFrom);
      const copied = [...store.entries];
      const copiedLeaf = store.leafId;
      createFreshSessionFile(opts.forkFrom);
      for (const item of copied) {
        store.entries.push(item);
        appendFileSync(store.sessionFile, `${JSON.stringify(item)}\n`, "utf8");
      }
      store.leafId = copiedLeaf;
    } else if (opts.sessionFile && existsSync(opts.sessionFile)) {
      loadSessionFromDisk(opts.sessionFile);
    } else if (opts.sessionFile) {
      mkdirSync(path.dirname(path.resolve(opts.sessionFile)), { recursive: true });
      store.sessionFile = path.resolve(opts.sessionFile);
      const header = {
        type: "session",
        version: 3,
        id: store.sessionId,
        timestamp: new Date().toISOString(),
        cwd,
      };
      writeFileSync(store.sessionFile, `${JSON.stringify(header)}\n`, "utf8");
    } else {
      createFreshSessionFile();
    }

    if (
      store.sessionName &&
      !store.entries.some(
        (entry) => entry.type === "session_info" && entry.name === store.sessionName,
      )
    ) {
      appendEntry({ type: "session_info", name: store.sessionName });
    }
  }

  return {
    store,
    ensureSessionDir,
    createFreshSessionFile,
    loadSessionFromDisk,
    appendEntry,
    shutdownEntry,
    getActiveBranchEntries,
    getActiveMessages,
    getEntriesSince,
    buildTreeNodes,
    computeStats,
  };
}
