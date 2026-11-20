/**
 * Pi 会话生态执行器（`/btw`、`/export`、分支树、`fork`、安全就地 `rewindTo`），
 * 并统一转出运行时探测/安装与本地用量聚合（`piRuntimeManager.ts`）。
 * 严禁 `shell: true`；所有子进程登记至 `piProcessRegistry`；`rewindTo` 写盘前必先关闭子进程并串行化写队列。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PiBtwRequest,
  PiBtwResult,
  PiExportHtmlResult,
  PiForkSessionResult,
  PiRewindSessionResult,
  PiSessionEcosystemAction,
  PiSessionEcosystemResult,
  PiSessionTreeSnapshot,
} from "@zcode/shared/pi-config";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { terminateProcessTreeAndWait } from "#src/process/processTreeTerminator.js";
import type { PiAgentService } from "#src/pi-runtime/contract.js";
import {
  PiSessionIndexScanner,
  discoverPi,
  encodePiSessionBucketDir,
  formatRedactedPiError,
  getPiSessionExtensionUiSnapshot,
  registerActivePiProcess,
  unregisterActivePiProcess,
  type DisposablePiProcess,
} from "#src/pi-runtime/index.js";
import { hasControlChars } from "../domain/piConfigHelpers.js";
import {
  buildPiSessionTreeSnapshot,
  computePiForkJsonl,
  computePiRewindJsonl,
  renderPiSessionToHtml,
} from "../domain/piSessionTreeAndExport.js";
import { atomicWritePiFile, enqueuePiFileWrite } from "./piAtomicFile.js";
import {
  deletePiSessionOnDisk,
  persistPiSessionTitle,
  runPiSmartRename,
} from "./piSessionSmartOps.js";

export {
  inspectPiRuntimeStatus,
  installOrUpgradeManagedPiRuntime,
  resolveDefaultManagedRuntimeDir,
  scanPiLocalUsageSummary,
} from "./piRuntimeManager.js";

const logger = createServiceLogger("pi-runtime-ecosystem");
const MAX_BTW_CHARS = 8_192;
const BTW_TIMEOUT_MS = 120_000;

function isInsideOrSameDir(
  targetPath: string,
  dirPath: string,
  platform: NodeJS.Platform,
): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedDir = path.resolve(dirPath);
  const rel = path.relative(
    platform === "win32" ? resolvedDir.toLowerCase() : resolvedDir,
    platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget,
  );
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** 校验 `/export` 可选落盘路径：禁止控制字符、限定 `.html`/`.htm` 后缀、严禁写入 `<agentDir>` 内。 */
function validateExportHtmlTargetPath(
  rawPath: string,
  agentDir: string,
  platform: NodeJS.Platform,
): string {
  const trimmed = rawPath.trim();
  if (!trimmed || hasControlChars(trimmed)) {
    throw new Error("Invalid HTML export target path");
  }
  const target = path.resolve(trimmed);
  const ext = path.extname(target).toLowerCase();
  if (ext !== ".html" && ext !== ".htm") {
    throw new Error("HTML export path must end with .html or .htm");
  }
  if (isInsideOrSameDir(target, agentDir, platform)) {
    throw new Error("Refusing to write HTML export inside Pi agent directory");
  }
  return target;
}

/** 执行 `/btw` 一次性侧边问答（`pi -p --no-session --no-tools`，零会话污染，进程登记防孤儿）。 */
export async function runPiBtwQuestion(
  request: PiBtwRequest,
  options: {
    env?: NodeJS.ProcessEnv | undefined;
    platform?: NodeJS.Platform | undefined;
    managedRuntimeDir: string;
  },
): Promise<PiBtwResult> {
  const question = request.question.trim();
  const id = `btw_${randomUUID().slice(0, 8)}`;
  const createdAt = Date.now();
  if (!question) throw new Error("Side question cannot be empty");
  if (question.length > MAX_BTW_CHARS) {
    throw new Error(`Side question exceeds ${MAX_BTW_CHARS} characters`);
  }

  const launch = await discoverPi({
    env: options.env,
    platform: options.platform,
    managedRuntimeDir: options.managedRuntimeDir,
  });
  if (!launch) {
    return {
      id,
      question,
      answer: "",
      status: "error",
      error: "Pi CLI not found",
      durationMs: Date.now() - createdAt,
      createdAt,
    };
  }

  const args = [...launch.prefixArgs, "-p", "--no-session", "--no-tools"];
  const provider = request.provider?.trim();
  if (provider && !provider.startsWith("-") && !hasControlChars(provider)) {
    args.push("--provider", provider);
  }
  const model = request.model?.trim();
  if (model && !model.startsWith("-") && !hasControlChars(model)) {
    args.push("--model", model);
  }
  args.push("--", question);
  const cwd =
    request.workspacePath && existsSync(request.workspacePath)
      ? request.workspacePath
      : os.tmpdir();

  return new Promise<PiBtwResult>((resolve) => {
    const child = spawn(launch.command, args, {
      cwd,
      env: { ...(options.env ?? process.env), ...launch.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const procHandle: DisposablePiProcess = {
      closeAndWait: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await terminateProcessTreeAndWait(child, {
          ownedProcessStartedAtMs: createdAt,
          forceAfterMs: 250,
          waitAfterForceMs: 1_500,
          windowsCleanupDeadlineAtMs: Date.now() + 2_000,
          log: logger,
        });
      },
    };
    registerActivePiProcess(procHandle);

    const done = (result: PiBtwResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregisterActivePiProcess(procHandle);
      resolve(result);
    };

    const timer = setTimeout(() => {
      void procHandle.closeAndWait();
      done({
        id,
        question,
        answer: stdout.trim(),
        status: "aborted",
        error: "Side question timed out",
        durationMs: Date.now() - createdAt,
        createdAt,
      });
    }, BTW_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr += c;
      if (stderr.length > 4_096) stderr = stderr.slice(-4_096);
    });
    child.on("error", (err) => {
      done({
        id,
        question,
        answer: "",
        status: "error",
        error: formatRedactedPiError(err),
        durationMs: Date.now() - createdAt,
        createdAt,
      });
    });
    child.on("close", (code) => {
      const ok = (code ?? 1) === 0;
      done({
        id,
        question,
        answer: stdout.trim(),
        status: ok ? "completed" : "error",
        ...(ok
          ? {}
          : { error: formatRedactedPiError(stderr.trim() || `Pi exited with code ${code}`) }),
        durationMs: Date.now() - createdAt,
        createdAt,
      });
    });
  });
}

async function resolveSessionJsonlFile(input: {
  workspacePath: string;
  sessionId: string;
  agentService?: PiAgentService | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
}): Promise<string | null> {
  const fromAgent = await input.agentService?.getSessionFilePath?.(
    input.workspacePath,
    input.sessionId,
  );
  if (fromAgent && existsSync(fromAgent)) return fromAgent;
  const scanner = new PiSessionIndexScanner({ env: input.env, platform: input.platform });
  try {
    const found = await scanner.findBySessionId(input.sessionId);
    return found?.file ?? null;
  } finally {
    scanner.dispose();
  }
}

/** 统一分发会话生态动作：`/btw`、`/export`、分支树 `getTree`、`fork` 与安全就地 `rewindTo`。 */
export async function executePiSessionEcosystemAction(
  op: PiSessionEcosystemAction,
  deps: {
    agentDir: string;
    managedRuntimeDir: string;
    env?: NodeJS.ProcessEnv | undefined;
    platform?: NodeJS.Platform | undefined;
    agentService?: PiAgentService | undefined;
  },
): Promise<PiSessionEcosystemResult> {
  if (op.op === "getExtensionUiState") {
    return {
      op: "getExtensionUiState",
      state: getPiSessionExtensionUiSnapshot(op.sessionId),
    };
  }
  if (op.op === "btw") {
    const result = await runPiBtwQuestion(op.request, {
      env: deps.env,
      platform: deps.platform,
      managedRuntimeDir: deps.managedRuntimeDir,
    });
    return { op: "btw", result };
  }

  const platform = deps.platform ?? process.platform;
  const smartOpsDeps = {
    agentDir: deps.agentDir,
    managedRuntimeDir: deps.managedRuntimeDir,
    env: deps.env,
    platform,
    agentService: deps.agentService,
    resolveSessionFile: (workspacePath: string, sessionId: string) =>
      resolveSessionJsonlFile({
        workspacePath,
        sessionId,
        agentService: deps.agentService,
        env: deps.env,
        platform,
      }),
  };

  if (op.op === "smartRename") {
    const result = await runPiSmartRename(op, smartOpsDeps);
    return { op: "smartRename", result };
  }
  if (op.op === "persistTitle") {
    const persisted = await persistPiSessionTitle(op, smartOpsDeps);
    return { op: "persistTitle", persisted };
  }
  if (op.op === "deleteSession") {
    const result = await deletePiSessionOnDisk(op, smartOpsDeps);
    return { op: "deleteSession", result };
  }

  const sessionFile = await resolveSessionJsonlFile({
    workspacePath: op.workspacePath,
    sessionId: op.sessionId,
    agentService: deps.agentService,
    env: deps.env,
    platform,
  });

  if (op.op === "getTree") {
    if (!sessionFile) {
      const empty: PiSessionTreeSnapshot = {
        sessionId: op.sessionId,
        sessionFile: null,
        leafId: null,
        nodes: [],
      };
      return { op: "getTree", tree: empty };
    }
    const raw = await readFile(sessionFile, "utf8");
    return {
      op: "getTree",
      tree: buildPiSessionTreeSnapshot({ sessionId: op.sessionId, sessionFile, rawContent: raw }),
    };
  }

  if (!sessionFile) {
    throw new Error(`No Pi .jsonl session file found for session "${op.sessionId}"`);
  }

  if (op.op === "exportHtml") {
    const raw = await readFile(sessionFile, "utf8");
    const rendered = renderPiSessionToHtml({
      rawContent: raw,
      sessionId: op.sessionId,
      exportedAtIso: new Date().toISOString(),
    });
    const safeName = `${rendered.title.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]+/g, "_").slice(0, 60) || op.sessionId}.html`;
    let savedPath: string | undefined;
    if (op.saveToPath?.trim()) {
      const target = validateExportHtmlTargetPath(op.saveToPath, deps.agentDir, platform);
      await atomicWritePiFile(target, rendered.html, { tag: "pi-export" });
      savedPath = target;
    }
    const result: PiExportHtmlResult = {
      html: rendered.html,
      suggestedFileName: safeName,
      ...(savedPath ? { savedPath } : {}),
      messageCount: rendered.messageCount,
    };
    return { op: "exportHtml", result };
  }

  if (op.op === "fork") {
    const raw = await readFile(sessionFile, "utf8");
    const newSessionId = `pi_${randomUUID()}`;
    const forked = computePiForkJsonl({
      rawContent: raw,
      newSessionId,
      fallbackCwd: op.workspacePath,
      nowIso: new Date().toISOString(),
      parentSession: sessionFile,
      entryId: op.entryId,
      title: op.title,
    });
    const bucketDir = path.join(deps.agentDir, "sessions", encodePiSessionBucketDir(forked.cwd));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const newFile = path.join(bucketDir, `${stamp}_${newSessionId}.jsonl`);
    await atomicWritePiFile(newFile, forked.content, { tag: "pi-fork" });
    const result: PiForkSessionResult = {
      sessionId: newSessionId,
      sessionFile: newFile,
      title: forked.title,
    };
    return { op: "fork", result };
  }

  // 安全就地回退（rewindTo）：严格先停活跃 pi 子进程，再串行化备份 + 原子截断，最后重载水合。
  await deps.agentService?.stopSessionRuntime({
    workspacePath: op.workspacePath,
    sessionId: op.sessionId,
  });
  const rewound = await enqueuePiFileWrite(sessionFile, async () => {
    const raw = await readFile(sessionFile, "utf8");
    const computed = computePiRewindJsonl(raw, op.entryId);
    let backupFile: string | null = null;
    if (computed.backupText) {
      backupFile = `${sessionFile}.rewound-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
      await atomicWritePiFile(backupFile, computed.backupText, { tag: "pi-rewind-bak" });
    }
    await atomicWritePiFile(sessionFile, computed.nextText, { tag: "pi-rewind" });
    return { droppedLines: computed.droppedLines, leafId: computed.leafId, backupFile };
  });
  await deps.agentService?.reloadSessionAfterRewind?.(op.workspacePath, op.sessionId);

  const result: PiRewindSessionResult = {
    sessionId: op.sessionId,
    droppedLines: rewound.droppedLines,
    leafId: rewound.leafId,
    backupFile: rewound.backupFile,
  };
  return { op: "rewindTo", result };
}
