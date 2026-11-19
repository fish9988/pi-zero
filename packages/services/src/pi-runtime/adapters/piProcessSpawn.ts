/**
 * Pi 子进程启动与进程树隔离托管适配器。
 * Windows 优先通过 ZCode 原生 `windows-runtime-host`（KILL_ON_JOB_CLOSE + CREATE_SUSPENDED）托管，
 * 缺失 helper 或 POSIX 环境安全回退为独立进程组 + `terminateProcessTreeAndWait`。
 * 严格禁止 `shell: true`。
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";
import {
  spawnWindowsRuntimeHost,
  type WindowsRuntimeHost,
} from "#src/windows-runtime-host/index.js";
import type { PiProcessContainment, PiRpcSpawnOptions } from "#src/pi-runtime/contract.js";
import { formatRedactedPiError } from "#src/pi-runtime/adapters/piDiscover.js";

const logger = createServiceLogger("pi-runtime");

const WINDOWS_HOST_MIN_CLOSE_WINDOW_MS = 3_250;
const DIRECT_GRACE_CAP_MS = 1_800;

export function buildPiRpcArgs(options: PiRpcSpawnOptions): string[] {
  const args: string[] = [...options.launch.prefixArgs, "--mode", "rpc"];
  if (options.noSession === true) {
    args.push("--no-session");
  } else if (options.forkFrom !== undefined && options.forkFrom !== "") {
    args.push("--fork", options.forkFrom);
  } else if (options.sessionFile !== undefined && options.sessionFile !== "") {
    args.push("--session", options.sessionFile);
  }
  if (options.sessionDir !== undefined && options.sessionDir !== "") {
    args.push("--session-dir", options.sessionDir);
  }
  if (options.provider !== undefined && options.provider !== "") {
    args.push("--provider", options.provider);
  }
  if (options.model !== undefined && options.model !== "") {
    args.push("--model", options.model);
  }
  if (options.thinkingLevel !== undefined && options.thinkingLevel !== "") {
    args.push("--thinking", options.thinkingLevel);
  }
  if (options.sessionName !== undefined && options.sessionName !== "") {
    args.push("--name", options.sessionName);
  }
  if (options.extraArgs !== undefined && options.extraArgs.length > 0) {
    args.push(...options.extraArgs);
  }
  return args;
}

export type PiRpcChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface SpawnPiProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
  traceId?: string | undefined;
}

export interface SpawnedPiProcess {
  readonly containment: PiProcessContainment;
  readonly child: PiRpcChildProcess;
  readonly pid: number | undefined;
  /** 安装完 stdout/stderr/exit 监听后调用，恢复 Windows 挂起的子进程。 */
  start(): Promise<void>;
  /** Windows runtime host 报告的真实根进程退出码（区分 helper 退出码）。 */
  getRootExit(): { code: number | null; signal: NodeJS.Signals | null } | undefined;
  /** 先关闭 stdin 宽限退出，再等待整棵 Job / 进程树清空。 */
  closeAndWait(timeoutMs: number): Promise<void>;
}

function isMissingWindowsRuntimeHostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Windows runtime host is missing");
}

function waitForChildClose(child: PiRpcChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(closed);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    child.once("close", onClose);
  });
}

function createWindowsHostedProcess(host: WindowsRuntimeHost, traceId?: string): SpawnedPiProcess {
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  host.onRootExit((code, signal) => {
    if (rootExit === undefined) {
      rootExit = { code, signal };
    }
  });

  return {
    containment: "windows-runtime-host",
    child: host.child,
    get pid() {
      return host.runtimePid;
    },
    async start() {
      await host.start();
    },
    getRootExit() {
      return rootExit;
    },
    async closeAndWait(timeoutMs: number) {
      if (timeoutMs <= 0) {
        try {
          host.child.stdin.destroy();
        } catch {
          // 忽略关闭阶段 stdin 异常。
        }
      }
      // 原生 helper 内部有 1800ms 宽限窗口；给足 deadline 让其完成 TerminateJobObject + empty 核验。
      const effectiveWindowMs = Math.max(timeoutMs, WINDOWS_HOST_MIN_CLOSE_WINDOW_MS);
      try {
        await host.close(Date.now() + effectiveWindowMs);
      } catch (error) {
        logger.warn(traceId, "Windows runtime host close fell back to force tree termination", {
          pid: host.runtimePid,
          error: formatRedactedPiError(error),
        });
        try {
          host.child.kill();
        } catch {
          // 忽略 kill 失败，继续进程树兜底回收。
        }
        await terminateProcessTreeAndWait(host.child, {
          forceAfterMs: 250,
          waitAfterForceMs: 1_500,
          windowsCleanupDeadlineAtMs: Date.now() + 2_000,
          traceId,
          log: logger,
        });
      }
    },
  };
}

function createDirectProcess(
  child: PiRpcChildProcess,
  startedAtMs: number,
  detachedGroup: boolean,
  traceId?: string,
): SpawnedPiProcess {
  const sharedTerminatorBase = {
    ownedProcessStartedAtMs: startedAtMs,
    ...(detachedGroup && child.pid !== undefined ? { ownedProcessGroupId: child.pid } : {}),
    traceId,
    log: logger,
  };

  return {
    containment: "direct-process-tree",
    child,
    get pid() {
      return child.pid;
    },
    start() {
      return Promise.resolve();
    },
    getRootExit() {
      return undefined;
    },
    async closeAndWait(timeoutMs: number) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      if (timeoutMs <= 0) {
        try {
          child.stdin.destroy();
        } catch {
          // 忽略关闭阶段 stdin 异常。
        }
        await terminateProcessTreeAndWait(child, {
          ...sharedTerminatorBase,
          forceAfterMs: 0,
          waitAfterForceMs: 1_500,
          windowsCleanupDeadlineAtMs: Date.now() + 2_000,
        });
        return;
      }

      const graceMs = Math.min(timeoutMs, DIRECT_GRACE_CAP_MS);
      const closePromise = waitForChildClose(child, graceMs);
      try {
        child.stdin.end();
      } catch {
        // 忽略关闭阶段 stdin 异常。
      }

      const closedGracefully = await closePromise;
      if (closedGracefully) {
        return;
      }

      const remainingMs = Math.max(500, timeoutMs - graceMs);
      await terminateProcessTreeAndWait(child, {
        ...sharedTerminatorBase,
        forceAfterMs: Math.min(remainingMs, 500),
        waitAfterForceMs: 1_500,
        windowsCleanupDeadlineAtMs: Date.now() + Math.max(remainingMs, 2_000),
      });
    },
  };
}

export async function spawnPiProcess(options: SpawnPiProcessOptions): Promise<SpawnedPiProcess> {
  if (process.platform === "win32") {
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    let host: WindowsRuntimeHost | null = null;
    try {
      host = await spawnWindowsRuntimeHost({
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        env: options.env,
        signal: controller.signal,
      });
      await host.ready();
      return createWindowsHostedProcess(host, options.traceId);
    } catch (error) {
      // 若 helper 已拉起但 ready() 超时或失败，必须先中止并关闭 Job，避免残留挂起的子进程。
      controller.abort();
      if (host !== null) {
        await host.close(Date.now() + 1_500).catch(() => {});
      }
      if (options.signal?.aborted) {
        throw error;
      }
      if (!isMissingWindowsRuntimeHostError(error)) {
        logger.warn(
          options.traceId,
          "Windows runtime host spawn failed, falling back to direct process tree containment",
          { error: formatRedactedPiError(error) },
        );
      } else {
        logger.debug(
          options.traceId,
          "Windows runtime host binary unavailable, using direct process tree containment",
        );
      }
    } finally {
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  // 非 Windows 或未部署 helper 时走直接 spawn（禁用 shell，POSIX 启用独立进程组）。
  const detachedGroup = shouldSpawnInDetachedProcessGroup();
  const startedAtMs = Date.now();
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
    detached: detachedGroup,
  });
  return createDirectProcess(child, startedAtMs, detachedGroup, options.traceId);
}
