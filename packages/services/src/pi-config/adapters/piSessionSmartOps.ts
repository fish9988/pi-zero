/**
 * Pi 会话智能重命名、离线标题落盘与真删会话文件（回收站 / 永久删除）执行器。
 * 严禁 `shell: true`；所有子进程登记到 `piProcessRegistry`；文件写入串行化原子落盘。
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  PiDeleteSessionMode,
  PiDeleteSessionResult,
  PiSmartRenameResult,
  PiThinkingLevel,
} from "@zcode/shared/pi-config";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { terminateProcessTreeAndWait } from "#src/process/processTreeTerminator.js";
import type { PiAgentService } from "#src/pi-runtime/contract.js";
import {
  discoverPi,
  formatRedactedPiError,
  registerActivePiProcess,
  unregisterActivePiProcess,
  type DisposablePiProcess,
} from "#src/pi-runtime/index.js";
import { hasControlChars } from "../domain/piConfigHelpers.js";
import {
  buildPiSessionInfoJsonlLine,
  buildSmartRenamePromptText,
  extractSmartRenameContextFromJsonl,
  extractSmartRenameContextFromMessages,
  findActiveJsonlLeafId,
  sanitizeSmartRenameTitle,
} from "../domain/piSmartRenameDomain.js";
import { atomicWritePiFile, enqueuePiFileWrite } from "./piAtomicFile.js";

const execFileAsync = promisify(execFile);
const logger = createServiceLogger("pi-session-smart-ops");
const SMART_RENAME_TIMEOUT_MS = 60_000;
const VALID_THINKING_LEVELS = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface PiSessionSmartOpsDeps {
  readonly agentDir: string;
  readonly managedRuntimeDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly agentService?: PiAgentService | undefined;
  readonly resolveSessionFile: (workspacePath: string, sessionId: string) => Promise<string | null>;
}

/** 跨平台安全移入系统回收站（零 `shell: true`，通过环境变量或 argv 传递路径防注入）。 */
export async function trashFileCrossPlatform(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const resolved = path.resolve(filePath);
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName Microsoft.VisualBasic;",
      "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:PI_TRASH_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    ].join(" ");
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      {
        env: { ...process.env, PI_TRASH_TARGET: resolved },
        windowsHide: true,
        timeout: 15_000,
      },
    );
    return !existsSync(resolved);
  }
  if (platform === "darwin") {
    await execFileAsync(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        'tell application "Finder" to delete POSIX file (item 1 of argv)',
        "-e",
        "end run",
        "--",
        resolved,
      ],
      { timeout: 15_000 },
    );
    return !existsSync(resolved);
  }
  await execFileAsync("gio", ["trash", "--", resolved], { timeout: 15_000 });
  return !existsSync(resolved);
}

/** 将标题原子追加写入 Pi `.jsonl` 的 `session_info` 行，并同步内存控制器。 */
export async function persistPiSessionTitle(
  input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly title: string;
  },
  deps: PiSessionSmartOpsDeps,
): Promise<boolean> {
  const trimmed = input.title.trim();
  if (!trimmed) return false;

  await deps.agentService?.applyExternalSessionTitle?.(
    input.workspacePath,
    input.sessionId,
    trimmed,
  );

  const sessionFile = await deps.resolveSessionFile(input.workspacePath, input.sessionId);
  if (!sessionFile || !existsSync(sessionFile)) return false;

  await enqueuePiFileWrite(sessionFile, async () => {
    const raw = await readFile(sessionFile, "utf8");
    const lastNonEmptyLine = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    if (lastNonEmptyLine) {
      try {
        const parsed = JSON.parse(lastNonEmptyLine) as Record<string, unknown>;
        if (parsed["type"] === "session_info" && parsed["name"] === trimmed) return;
      } catch {
        // 继续追加
      }
    }
    const leafId = findActiveJsonlLeafId(raw);
    const line = buildPiSessionInfoJsonlLine({
      id: randomUUID().slice(0, 8),
      parentId: leafId,
      timestampIso: new Date().toISOString(),
      title: trimmed,
    });
    const suffix = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
    await atomicWritePiFile(sessionFile, `${raw}${suffix}${line}\n`, { tag: "pi-title" });
  });
  return true;
}

/** 使用 Pi 无会话无工具一次性执行模式根据对话上下文生成简洁标题并落盘。 */
export async function runPiSmartRename(
  input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly provider?: string | undefined;
    readonly model?: string | undefined;
    readonly thinkingLevel?: PiThinkingLevel | undefined;
    readonly prompt?: string | undefined;
    readonly currentTitle?: string | undefined;
  },
  deps: PiSessionSmartOpsDeps,
): Promise<PiSmartRenameResult> {
  const startedAt = Date.now();
  const sessionFile = await deps.resolveSessionFile(input.workspacePath, input.sessionId);
  let context = "";
  if (sessionFile && existsSync(sessionFile)) {
    const raw = await readFile(sessionFile, "utf8");
    context = extractSmartRenameContextFromJsonl(raw);
  }
  if (!context && deps.agentService) {
    try {
      const legacy = await deps.agentService.readSession({
        workspacePath: input.workspacePath,
        sessionId: input.sessionId,
      });
      if (legacy?.messages?.length) {
        const simplified = legacy.messages.map((m) => ({
          role: m.info.role,
          text: m.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        }));
        context = extractSmartRenameContextFromMessages(simplified);
      }
    } catch {
      // 忽略回退快照失败
    }
  }
  if (!context) {
    throw new Error("当前会话暂无可用对话上下文，无法执行智能重命名");
  }

  const launch = await discoverPi({
    env: deps.env,
    platform: deps.platform,
    managedRuntimeDir: deps.managedRuntimeDir,
  });
  if (!launch) {
    throw new Error("未检测到 Pi CLI，请先在设置中安装或配置 Pi 运行时");
  }

  const args = [...launch.prefixArgs, "-p", "--no-session", "--no-tools"];
  const provider = input.provider?.trim();
  if (provider && !provider.startsWith("-") && !hasControlChars(provider)) {
    args.push("--provider", provider);
  }
  const model = input.model?.trim();
  if (model && !model.startsWith("-") && !hasControlChars(model)) {
    args.push("--model", model);
  }
  if (input.thinkingLevel && VALID_THINKING_LEVELS.has(input.thinkingLevel)) {
    args.push("--thinking", input.thinkingLevel);
  }
  const finalPrompt = buildSmartRenamePromptText(input.prompt, context);
  args.push("--", finalPrompt);

  const cwd =
    input.workspacePath && existsSync(input.workspacePath) ? input.workspacePath : os.tmpdir();

  const rawOutput = await new Promise<string>((resolve, reject) => {
    const child = spawn(launch.command, args, {
      cwd,
      env: { ...(deps.env ?? process.env), ...launch.env },
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
          ownedProcessStartedAtMs: startedAt,
          forceAfterMs: 250,
          waitAfterForceMs: 1_500,
          windowsCleanupDeadlineAtMs: Date.now() + 2_000,
          log: logger,
        });
      },
    };
    registerActivePiProcess(procHandle);

    const cleanup = () => {
      clearTimeout(timer);
      unregisterActivePiProcess(procHandle);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void procHandle.closeAndWait();
      cleanup();
      reject(new Error("智能重命名请求超时（60s），请切换更快的模型或降低思考强度"));
    }, SMART_RENAME_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(formatRedactedPiError(err)));
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        const msg = stderr.trim() || stdout.trim() || `Pi 进程退出码 ${String(code)}`;
        reject(new Error(formatRedactedPiError(msg)));
      }
    });
  });

  const nextTitle = sanitizeSmartRenameTitle(rawOutput);
  if (!nextTitle) {
    throw new Error("模型未返回有效的会话标题");
  }

  await persistPiSessionTitle(
    {
      workspacePath: input.workspacePath,
      sessionId: input.sessionId,
      title: nextTitle,
    },
    deps,
  );

  return {
    sessionId: input.sessionId,
    title: nextTitle,
    durationMs: Date.now() - startedAt,
  };
}

/** 停止活跃会话并删除磁盘上的 Pi `.jsonl` 文件（支持系统回收站或永久删除）。 */
export async function deletePiSessionOnDisk(
  input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly mode: PiDeleteSessionMode;
  },
  deps: PiSessionSmartOpsDeps,
): Promise<PiDeleteSessionResult> {
  const platform = deps.platform ?? process.platform;
  const resolvedBefore = await deps.resolveSessionFile(input.workspacePath, input.sessionId);
  const removedFile =
    (await deps.agentService?.removeSessionFromHub?.(input.workspacePath, input.sessionId)) ?? null;
  const targetFile = resolvedBefore ?? removedFile;

  if (!targetFile || !existsSync(targetFile)) {
    return {
      sessionId: input.sessionId,
      deletedFile: null,
      trashed: false,
      mode: input.mode,
    };
  }

  // 安全护栏：仅允许删除 `<agentDir>/sessions` 目录下的 `.jsonl` 文件。
  const sessionsRoot = path.resolve(deps.agentDir, "sessions");
  const resolvedTarget = path.resolve(targetFile);
  const rel = path.relative(
    platform === "win32" ? sessionsRoot.toLowerCase() : sessionsRoot,
    platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget,
  );
  if (
    rel.startsWith("..") ||
    path.isAbsolute(rel) ||
    !resolvedTarget.toLowerCase().endsWith(".jsonl")
  ) {
    throw new Error("Refusing to delete file outside Pi sessions directory");
  }

  if (input.mode === "trash") {
    const trashed = await trashFileCrossPlatform(resolvedTarget, platform);
    if (!trashed && existsSync(resolvedTarget)) {
      throw new Error("未能将会话文件移入系统回收站");
    }
    return {
      sessionId: input.sessionId,
      deletedFile: resolvedTarget,
      trashed: true,
      mode: "trash",
    };
  }

  await unlink(resolvedTarget);
  return {
    sessionId: input.sessionId,
    deletedFile: resolvedTarget,
    trashed: false,
    mode: "permanent",
  };
}
