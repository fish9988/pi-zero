/**
 * 全局活跃 Pi 子进程注册表：确保桌面 Host 退出时能统一等待并回收全部 `pi` 进程树。
 */
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { formatRedactedPiError } from "#src/pi-runtime/adapters/piDiscover.js";

const logger = createServiceLogger("pi-runtime");
const DEFAULT_DISPOSE_TIMEOUT_MS = 3_000;

export interface DisposablePiProcess {
  closeAndWait(timeoutMs?: number): Promise<void>;
}

const activeProcesses = new Set<DisposablePiProcess>();

export function registerActivePiProcess(proc: DisposablePiProcess): void {
  activeProcesses.add(proc);
}

export function unregisterActivePiProcess(proc: DisposablePiProcess): void {
  activeProcesses.delete(proc);
}

export function getActivePiProcessCount(): number {
  return activeProcesses.size;
}

/** 同步 best-effort 触发所有活跃 Pi 子进程关闭（用于同步 dispose 钩子）。 */
export function disposeAllPiProcesses(timeoutMs = DEFAULT_DISPOSE_TIMEOUT_MS): void {
  if (activeProcesses.size === 0) return;
  void disposeAllPiProcessesAndWait(timeoutMs).catch(() => {});
}

/** 等待全部活跃 Pi 子进程完成优雅关闭及进程树回收（接入 `disposeServiceResourcesAndWait`）。 */
export async function disposeAllPiProcessesAndWait(
  timeoutMs = DEFAULT_DISPOSE_TIMEOUT_MS,
): Promise<void> {
  const snapshot = [...activeProcesses];
  if (snapshot.length === 0) return;

  logger.info(undefined, "Disposing active Pi RPC processes", { count: snapshot.length });
  const results = await Promise.allSettled(snapshot.map((proc) => proc.closeAndWait(timeoutMs)));
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn(undefined, "Pi RPC process disposal reported error", {
        error: formatRedactedPiError(result.reason),
      });
    }
  }
}
