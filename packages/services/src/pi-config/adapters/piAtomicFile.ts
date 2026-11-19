/**
 * Pi 配置文件串行队列与原子落盘辅助（adapters 层）：
 * - 同一路径读写串行排队，杜绝并发覆盖；
 * - 写前按需保留 `.bak` 备份；临时文件写完后以 Windows EBUSY/EPERM 重试原子替换；
 * - 凭据文件统一 `0o600` 权限落盘。
 */
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPlainRecord, stripBom, stripJsonComments } from "../domain/piConfigHelpers.js";

const fileQueues = new Map<string, Promise<unknown>>();
let tmpSeq = 0;

export function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRetryableRename(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES";
}

/** 按规范化路径串行化文件读改写操作。 */
export function enqueuePiFileWrite<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prev = fileQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  fileQueues.set(key, settled);
  void settled.finally(() => {
    if (fileQueues.get(key) === settled) fileQueues.delete(key);
  });
  return next;
}

async function renameWithWindowsRetry(from: string, to: string): Promise<void> {
  const delays = [15, 40, 100, 200];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt === delays.length || !isRetryableRename(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]!));
    }
  }
}

export interface AtomicWriteOptions {
  readonly mode?: number | undefined;
  readonly backup?: boolean | undefined;
  readonly tag?: string | undefined;
}

/** 原子写入文件（可选写前 `.bak` 备份与 `0o600` 凭据权限）。 */
export async function atomicWritePiFile(
  targetPath: string,
  content: string,
  options?: AtomicWriteOptions,
): Promise<void> {
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true });
  if (options?.backup) {
    await copyFile(targetPath, `${targetPath}.bak`).catch((err: unknown) => {
      if (!isEnoent(err)) throw err;
    });
    if (options.mode !== undefined) {
      await chmod(`${targetPath}.bak`, options.mode).catch(() => undefined);
    }
  }
  const tag = options?.tag ?? "pi-cfg";
  const tmpPath = `${targetPath}.${tag}-${process.pid}-${++tmpSeq}.tmp`;
  try {
    await writeFile(tmpPath, content, {
      encoding: "utf8",
      ...(options?.mode !== undefined ? { mode: options.mode } : {}),
    });
    if (options?.mode !== undefined) {
      await chmod(tmpPath, options.mode).catch(() => undefined);
    }
    await renameWithWindowsRetry(tmpPath, targetPath);
    if (options?.mode !== undefined) {
      await chmod(targetPath, options.mode).catch(() => undefined);
    }
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

export async function readPiTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function readPiJsonObject(
  filePath: string,
  strict = false,
): Promise<{ exists: boolean; data: Record<string, unknown> }> {
  const raw = await readPiTextIfExists(filePath);
  if (raw === null) return { exists: false, data: {} };
  const cleaned = stripJsonComments(stripBom(raw)).trim();
  if (!cleaned) return { exists: true, data: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    if (strict) {
      throw new Error(
        `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return { exists: true, data: {} };
  }
  if (!isPlainRecord(parsed)) {
    if (strict) throw new Error(`Expected JSON object root in ${filePath}`);
    return { exists: true, data: {} };
  }
  return { exists: true, data: { ...parsed } };
}
