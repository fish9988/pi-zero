/**
 * Pi `<agentDir>/sessions/<cwd-bucket>/*.jsonl` 只读快速索引扫描器与目录热监听（adapters 层）。
 *
 * 关键规则：
 * - 零子进程启动：纯 Node fs 分段读写（32KiB 前缀 + 64KiB 尾部，按 `(file, mtimeMs, size)` 缓存）；
 * - 权威归属：严格读取 JSONL `type: "session"` header 里的 `cwd`（绝不解码桶目录名）；
 * - 实时互通：使用去抖 `fs.watch` 监听外部终端 `pi` 新建/追加的 `.jsonl`，
 *   并在 `dispose()` 时 100% 关闭所有 `FSWatcher` 与定时器，杜绝句柄泄漏。
 */
import { existsSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  extractPiSessionIndexSummary,
  parsePiSessionPrefix,
} from "#src/pi-runtime/domain/piJsonlIndexParser.js";
import { resolvePiAgentDir } from "#src/pi-runtime/adapters/piDiscover.js";

const PREFIX_BYTES = 32 * 1024;
const EXTENDED_PREFIX_BYTES = 512 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_FULL_SESSION_BYTES = 256 * 1024 * 1024;
const SCAN_CONCURRENCY = 16;
const WATCH_DEBOUNCE_MS = 150;

export interface PiDiskSessionRecord {
  readonly sessionId: string;
  readonly file: string;
  readonly cwd: string;
  readonly normalizedCwd: string;
  readonly modifiedAt: number;
  readonly size: number;
  readonly summary: SessionSummary;
}

interface FileCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly record:
    | (Omit<PiDiskSessionRecord, "summary"> & {
        readonly summaryTemplate: Omit<SessionSummary, "workspaceId">;
      })
    | null;
}

/** Pi v1.5.2 规范的 cwd 桶目录名编码（仅用于写新会话，绝不用于反向解码）。 */
export function encodePiSessionBucketDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** 跨平台路径归一化键（Windows 大小写不敏感，POSIX 解析软链如 /var -> /private/var）。 */
export function normalizeWorkspacePathKey(
  rawPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  const pathMod = platform === "win32" ? path.win32 : path.posix;
  let resolved = pathMod.resolve(trimmed);
  if (platform === process.platform) {
    try {
      resolved = realpathSync(resolved);
    } catch {
      // 目录尚未存在时保持 resolve 结果。
    }
  }
  const parsedRoot = pathMod.parse(resolved).root;
  const normalized =
    resolved === parsedRoot
      ? resolved
      : resolved.replace(/[\\/]+$/, (match) => (match.length === resolved.length ? match : ""));
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 首次真正拉起新 Pi 会话前，在 `<agentDir>/sessions/--<encoded-cwd>--/` 预写标准 v3 header 文件，
 * 使 ZCode `sessionId` 与 Pi `.jsonl` 的 `header.id` 严格一致，重启零重复且终端 `pi` 可直接续聊。
 * 绝不在 draft 阶段调用。
 */
export async function preparePiSessionFileForSpawn(input: {
  cwd: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<string> {
  const sessionsDir = path.join(
    resolvePiAgentDir(input.env),
    "sessions",
    encodePiSessionBucketDir(input.cwd),
  );
  await mkdir(sessionsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeId = input.sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(sessionsDir, `${stamp}_${safeId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: input.sessionId,
    timestamp: new Date().toISOString(),
    cwd: input.cwd,
  };
  try {
    await writeFile(filePath, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  return filePath;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function isTransient(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

async function readByteSlice(
  file: string,
  offset: number,
  length: number,
): Promise<{ text: string; bytesRead: number }> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { text: buffer.toString("utf8", 0, bytesRead), bytesRead };
  } finally {
    await handle.close();
  }
}

async function readPrefixAndSuffix(
  file: string,
  size: number,
  mtimeMs: number,
): Promise<{
  prefixText: string;
  prefixTruncated: boolean;
  suffixText: string;
  suffixTruncated: boolean;
} | null> {
  if (size <= 0) return null;
  const firstLen = Math.min(size, PREFIX_BYTES);
  let prefix = await readByteSlice(file, 0, firstLen);
  let prefixTruncated = size > prefix.bytesRead;

  const quickHead = parsePiSessionPrefix(prefix.text, prefixTruncated, mtimeMs);
  if (!quickHead) return null;
  if (prefixTruncated && quickHead.title === null && quickHead.firstPrompt === null) {
    const extLen = Math.min(size, EXTENDED_PREFIX_BYTES);
    prefix = await readByteSlice(file, 0, extLen);
    prefixTruncated = size > prefix.bytesRead;
  }

  if (!prefixTruncated) {
    return {
      prefixText: prefix.text,
      prefixTruncated: false,
      suffixText: prefix.text,
      suffixTruncated: false,
    };
  }
  const tailLen = Math.min(size, TAIL_BYTES);
  const tail = await readByteSlice(file, Math.max(0, size - tailLen), tailLen);
  return {
    prefixText: prefix.text,
    prefixTruncated,
    suffixText: tail.text,
    suffixTruncated: size > tail.bytesRead,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await fn(items[idx] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class PiSessionIndexScanner {
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly cache = new Map<string, FileCacheEntry>();
  private readonly activeWatchDisposers = new Set<() => void>();

  constructor(options?: {
    env?: NodeJS.ProcessEnv | undefined;
    platform?: NodeJS.Platform | undefined;
  }) {
    this.env = options?.env;
    this.platform = options?.platform ?? process.platform;
  }

  getSessionsRootDir(): string {
    return path.join(resolvePiAgentDir(this.env), "sessions");
  }

  async scanAll(workspaceIdForSummary = ""): Promise<PiDiskSessionRecord[]> {
    const files = await this.listJsonlFiles();
    const seen = new Set(files);
    for (const cachedPath of this.cache.keys()) {
      if (!seen.has(cachedPath)) this.cache.delete(cachedPath);
    }

    const loaded = await mapWithConcurrency(files, SCAN_CONCURRENCY, (file) =>
      this.loadFileRecord(file),
    );
    const bestBySessionId = new Map<string, PiDiskSessionRecord>();
    for (const entry of loaded) {
      if (!entry?.record) continue;
      const summary: SessionSummary = {
        ...entry.record.summaryTemplate,
        workspaceId: workspaceIdForSummary,
      };
      const candidate: PiDiskSessionRecord = {
        sessionId: entry.record.sessionId,
        file: entry.record.file,
        cwd: entry.record.cwd,
        normalizedCwd: entry.record.normalizedCwd,
        modifiedAt: entry.record.modifiedAt,
        size: entry.record.size,
        summary,
      };
      const prev = bestBySessionId.get(candidate.sessionId);
      if (!prev || candidate.modifiedAt > prev.modifiedAt) {
        bestBySessionId.set(candidate.sessionId, candidate);
      }
    }
    return [...bestBySessionId.values()].sort(
      (a, b) => b.summary.lastActivityAt - a.summary.lastActivityAt,
    );
  }

  async scanWorkspace(workspacePath: string, workspaceId: string): Promise<PiDiskSessionRecord[]> {
    const targetKey = normalizeWorkspacePathKey(workspacePath, this.platform);
    if (!targetKey) return [];
    const all = await this.scanAll(workspaceId);
    return all.filter((item) => item.normalizedCwd === targetKey);
  }

  async findBySessionId(sessionId: string, workspaceId = ""): Promise<PiDiskSessionRecord | null> {
    const all = await this.scanAll(workspaceId);
    return all.find((item) => item.sessionId === sessionId) ?? null;
  }

  async readFullSessionFile(filePath: string): Promise<string | null> {
    try {
      const info = await stat(filePath);
      if (info.size > MAX_FULL_SESSION_BYTES) return null;
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /**
   * 监听 `<agentDir>/sessions` 目录树变更（支持外部终端 `pi` 实时写入同步），
   * 返回幂等清理函数；`dispose()` 会统一关闭全部未释放监听。
   */
  watchSessions(onChange: () => void): () => void {
    const agentDir = resolvePiAgentDir(this.env);
    const sessionsRoot = this.getSessionsRootDir();
    const watchers = new Map<string, FSWatcher>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const triggerDebounced = (): void => {
      if (closed) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (closed) return;
        attachMissingWatchers();
        onChange();
      }, WATCH_DEBOUNCE_MS);
      debounceTimer.unref?.();
    };

    const tryWatchDir = (dir: string, recursive: boolean): boolean => {
      if (closed || watchers.has(dir) || !existsSync(dir)) return false;
      try {
        const watcher = watch(dir, { recursive }, () => {
          triggerDebounced();
        });
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
        return true;
      } catch {
        return false;
      }
    };

    const attachMissingWatchers = (): void => {
      if (closed) return;
      const supportsRecursive = this.platform === "win32" || this.platform === "darwin";
      if (existsSync(sessionsRoot)) {
        const watchedRecursively = supportsRecursive && tryWatchDir(sessionsRoot, true);
        if (!watchedRecursively) {
          tryWatchDir(sessionsRoot, false);
          void readdir(sessionsRoot, { withFileTypes: true })
            .then((entries) => {
              if (closed) return;
              for (const entry of entries) {
                if (entry.isDirectory()) {
                  tryWatchDir(path.join(sessionsRoot, entry.name), false);
                }
              }
            })
            .catch(() => {});
        }
      } else if (existsSync(agentDir)) {
        tryWatchDir(agentDir, false);
      }
    };

    attachMissingWatchers();

    const stop = (): void => {
      if (closed) return;
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {
          // 忽略已关闭句柄错误。
        }
      }
      watchers.clear();
      this.activeWatchDisposers.delete(stop);
    };

    this.activeWatchDisposers.add(stop);
    return stop;
  }

  dispose(): void {
    const disposers = Array.from(this.activeWatchDisposers);
    for (const stop of disposers) {
      stop();
    }
    this.activeWatchDisposers.clear();
    this.cache.clear();
  }

  private async listJsonlFiles(): Promise<string[]> {
    const root = this.getSessionsRootDir();
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    const directFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(root, entry.name));

    const bucketDirs = entries.filter((entry) => entry.isDirectory());
    const nested = await mapWithConcurrency(bucketDirs, SCAN_CONCURRENCY, async (bucket) => {
      const dir = path.join(root, bucket.name);
      try {
        const children = await readdir(dir, { withFileTypes: true });
        return children
          .filter((child) => child.isFile() && child.name.endsWith(".jsonl"))
          .map((child) => path.join(dir, child.name));
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    });

    return [...directFiles, ...nested.flat()];
  }

  private async loadFileRecord(file: string): Promise<FileCacheEntry | null> {
    let info;
    try {
      info = await stat(file);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }

    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached;
    }

    try {
      const slices = await readPrefixAndSuffix(file, info.size, info.mtimeMs);
      const extracted = slices
        ? extractPiSessionIndexSummary({
            ...slices,
            fallbackMtimeMs: info.mtimeMs,
            workspaceId: "",
          })
        : null;
      const entry: FileCacheEntry = {
        mtimeMs: info.mtimeMs,
        size: info.size,
        record: extracted
          ? {
              sessionId: extracted.sessionId,
              file,
              cwd: extracted.cwd,
              normalizedCwd: normalizeWorkspacePathKey(extracted.cwd, this.platform),
              modifiedAt: info.mtimeMs,
              size: info.size,
              summaryTemplate: {
                sessionId: extracted.summary.sessionId,
                title: extracted.summary.title,
                titleSource: extracted.summary.titleSource,
                ...(extracted.summary.lastOutcome
                  ? { lastOutcome: extracted.summary.lastOutcome }
                  : {}),
                phase: extracted.summary.phase,
                sessionEnded: extracted.summary.sessionEnded,
                hasBackgroundWork: extracted.summary.hasBackgroundWork,
                lastActivityAt: extracted.summary.lastActivityAt,
                ...(extracted.summary.lastAssistantPreview
                  ? { lastAssistantPreview: extracted.summary.lastAssistantPreview }
                  : {}),
                createdAt: extracted.summary.createdAt,
              },
            }
          : null,
      };
      this.cache.set(file, entry);
      return entry;
    } catch (error) {
      if (isMissing(error)) return null;
      if (isTransient(error)) return { mtimeMs: info.mtimeMs, size: info.size, record: null };
      throw error;
    }
  }
}
