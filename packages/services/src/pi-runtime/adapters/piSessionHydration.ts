/**
 * Pi 磁盘历史索引差量合并与单会话离线水合/旧版只读存档加载辅助（adapters 层）。
 *
 * 严格零子进程：仅读取 `.jsonl` 文件或只读旧版 SQLite 存档，绝不拉起 Pi 子进程。
 */
import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import {
  resolveWorkspaceKey,
  type SessionLifecycleSnapshot,
  type ZCodeSessionInfo,
} from "@zcode/shared";
import type {
  CommandAck,
  ConversationSnapshot,
  ConversationTopicWireCandidate,
  SessionSummary,
  SessionsIndexTopicWireCandidate,
  WireConversationRow,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgent.js";
import type { TopicSubscriptionState } from "#src/pi-runtime/adapters/piFrameEncoder.js";
import { createLegacyReadOnlyConversationSnapshot } from "#src/pi-runtime/domain/piArchiveSnapshotFactory.js";
import {
  hydratePiJsonlSession,
  type HydratedPiSessionResult,
} from "#src/pi-runtime/domain/piJsonlHydrator.js";
import { readLegacyZCodeArchiveSession } from "#src/pi-runtime/adapters/legacySessionArchive.js";
import type { PiModelCatalog } from "#src/pi-runtime/adapters/piModelCatalog.js";
import type { PiSessionController } from "#src/pi-runtime/adapters/piSessionController.js";
import type {
  PiDiskSessionRecord,
  PiSessionIndexScanner,
} from "#src/pi-runtime/adapters/piSessionIndexScanner.js";

function areSessionSummariesEqual(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.workspaceId === b.workspaceId &&
    a.title === b.title &&
    a.titleSource === b.titleSource &&
    a.phase === b.phase &&
    a.lastOutcome === b.lastOutcome &&
    a.sessionEnded === b.sessionEnded &&
    a.hasBackgroundWork === b.hasBackgroundWork &&
    a.lastActivityAt === b.lastActivityAt &&
    a.lastAssistantPreview === b.lastAssistantPreview &&
    a.createdAt === b.createdAt
  );
}

/**
 * 计算磁盘扫描前后的外部会话差量：
 * - 已被内存 live controller 接管的会话静默更新缓存而不发盘面 delta，避免自写 `fs.watch` 回声风暴；
 * - 已在本轮删除的 `deletedSessionIds` 不会被外部扫描复活。
 */
export function diffDiskSessionSummaries(input: {
  prev: ReadonlyMap<string, PiDiskSessionRecord>;
  next: readonly PiDiskSessionRecord[];
  ownedSessionIds: ReadonlySet<string>;
  deletedSessionIds: ReadonlySet<string>;
}): {
  nextMap: Map<string, PiDiskSessionRecord>;
  upserted: SessionSummary[];
  removed: string[];
} {
  const nextMap = new Map<string, PiDiskSessionRecord>();
  const upserted: SessionSummary[] = [];

  for (const record of input.next) {
    if (input.deletedSessionIds.has(record.sessionId)) continue;
    nextMap.set(record.sessionId, record);
    if (input.ownedSessionIds.has(record.sessionId)) continue;
    const prevRecord = input.prev.get(record.sessionId);
    if (!prevRecord || !areSessionSummariesEqual(prevRecord.summary, record.summary)) {
      upserted.push(record.summary);
    }
  }

  const removed: string[] = [];
  for (const prevId of input.prev.keys()) {
    if (
      !nextMap.has(prevId) &&
      !input.ownedSessionIds.has(prevId) &&
      !input.deletedSessionIds.has(prevId)
    ) {
      removed.push(prevId);
    }
  }

  return { nextMap, upserted, removed };
}

/** 合并内存活跃控制器与磁盘扫描索引（live 控制器优先，按最近活跃时间倒序）。 */
export function mergePublishedSessionSummaries(
  sessions: ReadonlyMap<string, PiSessionController>,
  diskSessions: ReadonlyMap<string, PiDiskSessionRecord>,
  deletedSessionIds: ReadonlySet<string>,
): SessionSummary[] {
  const merged = new Map<string, SessionSummary>();
  for (const [sessionId, record] of diskSessions) {
    if (deletedSessionIds.has(sessionId)) continue;
    merged.set(sessionId, record.summary);
  }
  for (const [sessionId, controller] of sessions) {
    if (deletedSessionIds.has(sessionId)) continue;
    if (controller.isPublishedToIndex()) {
      merged.set(sessionId, controller.getSummary());
    }
  }
  return [...merged.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/** 由磁盘摘要直接构造 `ZCodeSessionInfo`，供 `listSessions` 零子进程返回。 */
export function buildDiskSummaryLegacySessionInfo(
  summary: SessionSummary,
  workspacePath: string,
  workspaceIdentity?: string | undefined,
): ZCodeSessionInfo {
  const status: ZCodeSessionInfo["status"] =
    summary.phase === "error"
      ? "error"
      : summary.phase === "completedSuccess" || summary.phase === "completedInterrupted"
        ? "completed"
        : "idle";
  return {
    sessionId: summary.sessionId,
    workspace: {
      workspacePath,
      workspaceKey: resolveWorkspaceKey({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      }),
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    },
    ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
    sessionKind: "interactive",
    title: summary.title,
    titleSource: summary.titleSource ?? "default",
    mode: "build",
    status,
    createdAt: summary.createdAt,
    updatedAt: summary.lastActivityAt,
  };
}

/** 离线读取单个 Pi `.jsonl` 文件并水合为可直接装入 `PiSessionController` 的结果。 */
export async function loadHydratedPiSessionFromDisk(input: {
  scanner: PiSessionIndexScanner;
  record: PiDiskSessionRecord;
  workspacePath: string;
  catalog: PiModelCatalog;
}): Promise<{ readonly filePath: string; readonly hydrated: HydratedPiSessionResult } | null> {
  return loadHydratedPiSessionFileFromDisk({
    scanner: input.scanner,
    filePath: input.record.file,
    sessionId: input.record.sessionId,
    fallbackCwd: input.record.cwd || input.workspacePath,
    fallbackMtimeMs: input.record.modifiedAt,
    catalog: input.catalog,
  });
}

/** 按指定 `.jsonl` 文件路径直接离线水合（兼容首轮 `rewindTo` 后仅剩 1 行 header 的空壳会话）。 */
export async function loadHydratedPiSessionFileFromDisk(input: {
  scanner: PiSessionIndexScanner;
  filePath: string;
  sessionId: string;
  fallbackCwd: string;
  fallbackMtimeMs?: number | undefined;
  catalog: PiModelCatalog;
}): Promise<{ readonly filePath: string; readonly hydrated: HydratedPiSessionResult } | null> {
  const rawContent = await input.scanner.readFullSessionFile(input.filePath);
  if (rawContent === null) return null;
  const snap = input.catalog.getSnapshot();
  const hydrated = hydratePiJsonlSession({
    rawContent,
    fallbackSessionId: input.sessionId,
    fallbackCwd: input.fallbackCwd,
    fallbackMtimeMs: input.fallbackMtimeMs ?? Date.now(),
    catalogModels: snap.models,
    defaultModel: snap.defaultModel,
    defaultThinkingLevel: snap.defaultThinkingLevel,
  });
  return { filePath: input.filePath, hydrated };
}

/** 回退后重新加载会话：兼容末轮回退与首轮回退（1 行 header 空壳，不在侧栏索引里）。 */
export async function reloadRewoundPiSessionFromDisk(input: {
  scanner: PiSessionIndexScanner;
  bucket: PiWorkspaceBucket;
  sessionId: string;
  fallbackFilePath: string | null;
  catalog: PiModelCatalog;
}): Promise<{ readonly filePath: string; readonly hydrated: HydratedPiSessionResult } | null> {
  const record = await input.scanner.findBySessionId(input.sessionId, input.bucket.workspaceKey);
  if (input.bucket.disposed) return null;
  if (record) {
    input.bucket.diskSessions.set(input.sessionId, record);
    return loadHydratedPiSessionFromDisk({
      scanner: input.scanner,
      record,
      workspacePath: input.bucket.workspacePath,
      catalog: input.catalog,
    });
  }
  input.bucket.diskSessions.delete(input.sessionId);
  if (!input.fallbackFilePath) return null;
  return loadHydratedPiSessionFileFromDisk({
    scanner: input.scanner,
    filePath: input.fallbackFilePath,
    sessionId: input.sessionId,
    fallbackCwd: input.bucket.workspacePath,
    catalog: input.catalog,
  });
}

/** 为不存在于 Pi `.jsonl` 磁盘索引的旧版 ZCode 历史会话构造只读存档快照（零子进程）。 */
export async function buildLegacyReadOnlyArchivePayload(input: {
  sessionId: string;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<{ readonly snapshot: ConversationSnapshot; readonly rows: WireConversationRow[] }> {
  const recovered = await readLegacyZCodeArchiveSession(input.sessionId, { env: input.env });
  return createLegacyReadOnlyConversationSnapshot({
    sessionId: input.sessionId,
    logEpoch: `pi-legacy-${randomUUID()}`,
    attemptId: `legacy-${randomUUID()}`,
    nowMs: Date.now(),
    title: recovered?.title,
    recoveredRows: recovered?.recoveredRows,
  });
}

/** 对照 live 控制器与磁盘索引核对会话存在性；未知/旧版 ID 一律返回 `exists: false, deleted: false`。 */
export function buildReconciledSessionsResult(input: {
  sessionIds: readonly string[];
  sessions: ReadonlyMap<string, PiSessionController>;
  diskSessions: ReadonlyMap<string, PiDiskSessionRecord>;
  deletedSessionIds: ReadonlySet<string>;
}) {
  return {
    sessions: input.sessionIds.map((sessionId) => {
      const controller = input.sessions.get(sessionId);
      let summary: SessionSummary | undefined;
      if (controller && controller.isPublishedToIndex()) {
        summary = controller.getSummary();
      } else if (!input.deletedSessionIds.has(sessionId)) {
        summary = input.diskSessions.get(sessionId)?.summary;
      }
      if (!summary) {
        return { sessionId, exists: false as const, deleted: false as const };
      }
      return {
        sessionId,
        exists: true as const,
        deleted: false,
        ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
        title: summary.title,
        titleSource: summary.titleSource ?? "default",
        createdAt: summary.createdAt,
        updatedAt: summary.lastActivityAt,
        ...(summary.lastOutcome ? { lastOutcome: summary.lastOutcome } : {}),
      };
    }),
  };
}

export interface PiWorkspaceBucket {
  readonly workspaceKey: string;
  readonly workspacePath: string;
  readonly workspaceIdentity: string | undefined;
  readonly generation: number;
  readonly identity: string;
  readonly sessions: Map<string, PiSessionController>;
  diskSessions: Map<string, PiDiskSessionRecord>;
  readonly deletedSessionIds: Set<string>;
  readonly hydratingDiskSessions: Map<string, Promise<PiSessionController | null>>;
  readonly hydratingOpenSessions: Map<string, Promise<PiSessionController>>;
  initialScanDone: boolean;
  initialScanPromise: Promise<void> | null;
  refreshPromise: Promise<void> | null;
  refreshPending: boolean;
  watcherDispose: (() => void) | null;
  readonly deferredTimers: Set<ReturnType<typeof setTimeout>>;
  disposed: boolean;
  readonly conversationFrameEmitter: Emitter<ConversationTopicWireCandidate>;
  readonly sessionsIndexFrameEmitter: Emitter<SessionsIndexTopicWireCandidate>;
  readonly workspaceConfigFrameEmitter: Emitter<WorkspaceConfigTopicWireCandidate>;
  readonly sessionLifecycleEmitter: Emitter<SessionLifecycleSnapshot>;
  readonly sessionsIndexLogEpoch: string;
  sessionsIndexSeq: number;
  readonly sessionsIndexSubs: Map<string, TopicSubscriptionState>;
  readonly workspaceConfigLogEpoch: string;
  workspaceConfigSeq: number;
  readonly workspaceConfigSubs: Map<string, TopicSubscriptionState>;
  readonly commandAckCache: Map<string, CommandAck>;
}

export function createPiWorkspaceBucket(
  target: ZCodeAgentWorkspaceTarget,
  workspaceKey: string,
  generation: number,
): PiWorkspaceBucket {
  return {
    workspaceKey,
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    generation,
    identity: `pi-ws-${randomUUID()}`,
    sessions: new Map(),
    diskSessions: new Map(),
    deletedSessionIds: new Set(),
    hydratingDiskSessions: new Map(),
    hydratingOpenSessions: new Map(),
    initialScanDone: false,
    initialScanPromise: null,
    refreshPromise: null,
    refreshPending: false,
    watcherDispose: null,
    deferredTimers: new Set(),
    disposed: false,
    conversationFrameEmitter: new Emitter(),
    sessionsIndexFrameEmitter: new Emitter(),
    workspaceConfigFrameEmitter: new Emitter(),
    sessionLifecycleEmitter: new Emitter(),
    sessionsIndexLogEpoch: `pi-idx-${randomUUID()}`,
    sessionsIndexSeq: 0,
    sessionsIndexSubs: new Map(),
    workspaceConfigLogEpoch: `pi-cfg-${randomUUID()}`,
    workspaceConfigSeq: 0,
    workspaceConfigSubs: new Map(),
    commandAckCache: new Map(),
  };
}
