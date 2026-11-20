/**
 * Pi 工作区级 V4 Topic 注册表、磁盘 `.jsonl` 索引热同步与帧下发枢纽。
 */
import { resolveWorkspaceKey, type ModelSelection } from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  sessionsIndexTopic,
  workspaceConfigTopic,
  type CommandAck,
  type ConversationSnapshot,
  type SessionSummary,
  type SubscribeAck,
  type WireConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentWorkspaceTarget,
} from "#src/zcode-agent/zcodeAgent.js";
import type { PiDiscoveredSessionRecord } from "#src/pi-runtime/contract.js";
import type { HydratedPiSessionResult } from "#src/pi-runtime/domain/piJsonlHydrator.js";
import { buildWorkspaceConfigStateFromPiModels } from "#src/pi-runtime/domain/piModelCapability.js";
import {
  createSessionsIndexSnapshot,
  createWorkspaceConfigSnapshot,
} from "#src/pi-runtime/domain/piSnapshotFactory.js";
import {
  emitSessionsIndexDeltaFrames,
  emitSessionsIndexSnapshotFrames,
  emitWorkspaceConfigDeltaFrames,
  emitWorkspaceConfigSnapshotFrames,
  type PiSessionsIndexDeltaItem,
  type TopicSubscriptionState,
} from "#src/pi-runtime/adapters/piFrameEncoder.js";
import type { PiModelCatalog } from "#src/pi-runtime/adapters/piModelCatalog.js";
import type { PiRpcClient } from "#src/pi-runtime/adapters/piRpcClient.js";
import { PiSessionController } from "#src/pi-runtime/adapters/piSessionController.js";
import {
  buildLegacyReadOnlyArchivePayload,
  buildReconciledSessionsResult,
  createPiWorkspaceBucket,
  diffDiskSessionSummaries,
  loadHydratedPiSessionFromDisk,
  mergePublishedSessionSummaries,
  reloadRewoundPiSessionFromDisk,
  type PiWorkspaceBucket,
} from "#src/pi-runtime/adapters/piSessionHydration.js";
import {
  PiSessionIndexScanner,
  normalizeWorkspacePathKey,
} from "#src/pi-runtime/adapters/piSessionIndexScanner.js";

const TASK_INDEX_SUBSCRIBER_SCOPE = "task-index";
const LIVE_SESSION_REGISTRY_DEBOUNCE_MS = 120;

export type { PiWorkspaceBucket };

export function commandCacheKey(sessionId: string | null, commandId: string): string {
  return `${sessionId ?? "__global__"}\0${commandId}`;
}

export class PiWorkspaceHub {
  private readonly workspaces = new Map<string, PiWorkspaceBucket>();
  private readonly generationByWorkspaceKey = new Map<string, number>();
  private readonly sessionRegistryListeners = new Set<() => void>();
  private readonly catalog: PiModelCatalog;
  private readonly scanner: PiSessionIndexScanner;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly platform: NodeJS.Platform | undefined;
  private readonly managedRuntimeDir: string | undefined;
  private readonly onRuntimeLifecycle:
    | ((event: ZCodeAgentRuntimeLifecycleEvent) => void)
    | undefined;
  private subscriptionSeq = 0;

  constructor(options: {
    catalog: PiModelCatalog;
    env?: NodeJS.ProcessEnv | undefined;
    platform?: NodeJS.Platform | undefined;
    managedRuntimeDir?: string | undefined;
    onRuntimeLifecycle?: ((event: ZCodeAgentRuntimeLifecycleEvent) => void) | undefined;
  }) {
    this.catalog = options.catalog;
    this.env = options.env;
    this.platform = options.platform;
    this.managedRuntimeDir = options.managedRuntimeDir;
    this.onRuntimeLifecycle = options.onRuntimeLifecycle;
    this.scanner = new PiSessionIndexScanner({
      env: options.env,
      platform: options.platform,
    });
  }

  nextSubscriptionId(prefix: string): string {
    this.subscriptionSeq += 1;
    return `${prefix}_${this.subscriptionSeq}`;
  }

  getWorkspace(target: ZCodeAgentWorkspaceTarget): PiWorkspaceBucket | undefined {
    return this.workspaces.get(resolveWorkspaceKey(target));
  }

  getOrCreateWorkspace(target: ZCodeAgentWorkspaceTarget): PiWorkspaceBucket {
    const key = resolveWorkspaceKey(target);
    const existing = this.workspaces.get(key);
    if (existing) return existing;
    const generation = (this.generationByWorkspaceKey.get(key) ?? 0) + 1;
    this.generationByWorkspaceKey.set(key, generation);
    const bucket = createPiWorkspaceBucket(target, key, generation);
    this.workspaces.set(key, bucket);
    // 必须在写入 Map 之后再广播 available：syncer 监听到后可能同步重入订阅 topic。
    this.emitRuntimeLifecycle(bucket, "available");
    return bucket;
  }

  createSessionController(
    bucket: PiWorkspaceBucket,
    input: {
      sessionId: string;
      cwd?: string | undefined;
      parentSessionId?: string | undefined;
      modelSelection?: ModelSelection | undefined;
      thoughtLevel?: string | undefined;
      mode?: string | undefined;
      hydratedFromDisk?:
        | { readonly filePath: string; readonly hydrated: HydratedPiSessionResult }
        | undefined;
      readOnlyArchive?:
        | { readonly snapshot: ConversationSnapshot; readonly rows: readonly WireConversationRow[] }
        | undefined;
    },
  ): PiSessionController {
    const controller = new PiSessionController({
      sessionId: input.sessionId,
      workspaceId: bucket.workspaceKey,
      workspacePath: bucket.workspacePath,
      workspaceIdentity: bucket.workspaceIdentity,
      cwd: input.cwd?.trim() || bucket.workspacePath,
      parentSessionId: input.parentSessionId,
      modelSelection: input.modelSelection,
      thoughtLevel: input.thoughtLevel,
      mode: input.mode,
      catalog: this.catalog,
      env: this.env,
      platform: this.platform,
      managedRuntimeDir: this.managedRuntimeDir,
      hydratedFromDisk: input.hydratedFromDisk,
      readOnlyArchive: input.readOnlyArchive,
      callbacks: {
        emitConversationFrame: (frame) => bucket.conversationFrameEmitter.fire(frame),
        onSessionPublishedOrUpdated: (summary) => {
          bucket.deletedSessionIds.delete(summary.sessionId);
          this.emitSessionsIndexDeltas(bucket, [{ op: "session.upserted", session: summary }]);
          this.notifySessionRegistryChanged();
        },
        onSessionLifecycleChanged: (snapshot) => bucket.sessionLifecycleEmitter.fire(snapshot),
        onSessionDeleted: (deletedSessionId) => {
          bucket.sessions.delete(deletedSessionId);
          bucket.diskSessions.delete(deletedSessionId);
          bucket.deletedSessionIds.add(deletedSessionId);
          this.emitSessionsIndexDeltas(bucket, [
            { op: "session.removed", sessionId: deletedSessionId },
          ]);
          this.notifySessionRegistryChanged();
        },
        onVirtualSubagentSessionsUpdated: (payloads) => {
          for (const payload of payloads) {
            const existing = bucket.sessions.get(payload.childSessionId);
            if (existing) {
              existing.updateVirtualSubagentSnapshot(payload.snapshot, payload.rows);
            } else {
              this.createSessionController(bucket, {
                sessionId: payload.childSessionId,
                parentSessionId: payload.parentSessionId,
                readOnlyArchive: {
                  snapshot: payload.snapshot,
                  rows: payload.rows,
                },
              });
            }
          }
        },
      },
    });
    if (!bucket.disposed) {
      bucket.sessions.set(input.sessionId, controller);
    }
    return controller;
  }

  async ensureInitialDiskScan(bucket: PiWorkspaceBucket): Promise<void> {
    if (bucket.initialScanDone || bucket.disposed) return;
    if (bucket.initialScanPromise) return bucket.initialScanPromise;
    const promise = (async () => {
      try {
        await this.refreshDiskSessions(bucket);
      } catch {
        // 磁盘扫描异常不阻断实时对话；留空集合并继续尝试挂载目录监听。
      }
      if (bucket.disposed) return;
      bucket.initialScanDone = true;
      if (!bucket.watcherDispose) {
        bucket.watcherDispose = this.scanner.watchSessions(() => {
          if (!bucket.disposed) void this.refreshDiskSessions(bucket);
        });
      }
    })().finally(() => {
      if (bucket.initialScanPromise === promise) bucket.initialScanPromise = null;
    });
    bucket.initialScanPromise = promise;
    return promise;
  }

  async refreshDiskSessions(bucket: PiWorkspaceBucket): Promise<void> {
    if (bucket.disposed) return;
    if (bucket.refreshPromise) {
      bucket.refreshPending = true;
      return bucket.refreshPromise;
    }
    const run = (async () => {
      do {
        bucket.refreshPending = false;
        const records = await this.scanner.scanWorkspace(bucket.workspacePath, bucket.workspaceKey);
        if (bucket.disposed) return;
        const diff = diffDiskSessionSummaries({
          prev: bucket.diskSessions,
          next: records,
          ownedSessionIds: new Set(bucket.sessions.keys()),
          deletedSessionIds: bucket.deletedSessionIds,
        });
        bucket.diskSessions = diff.nextMap;
        const deltas: PiSessionsIndexDeltaItem[] = [
          ...diff.upserted.map((session) => ({ op: "session.upserted" as const, session })),
          ...diff.removed.map((sessionId) => ({ op: "session.removed" as const, sessionId })),
        ];
        if (deltas.length > 0 && bucket.sessionsIndexSubs.size > 0) {
          this.emitSessionsIndexDeltas(bucket, deltas);
        }
      } while (bucket.refreshPending && !bucket.disposed);
    })().finally(() => {
      if (bucket.refreshPromise === run) bucket.refreshPromise = null;
    });
    bucket.refreshPromise = run;
    return run;
  }

  getMergedPublishedSummaries(bucket: PiWorkspaceBucket): SessionSummary[] {
    return mergePublishedSessionSummaries(
      bucket.sessions,
      bucket.diskSessions,
      bucket.deletedSessionIds,
    );
  }

  /** 尝试按 `sessionId` 从 Pi 磁盘 `.jsonl` 离线水合会话（不存在返回 null，零子进程）。 */
  async tryHydrateDiskSession(
    bucket: PiWorkspaceBucket,
    sessionId: string,
  ): Promise<PiSessionController | null> {
    const existing = bucket.sessions.get(sessionId);
    if (existing) return existing;
    if (bucket.disposed || bucket.deletedSessionIds.has(sessionId)) return null;
    const inflight = bucket.hydratingDiskSessions.get(sessionId);
    if (inflight) return inflight;

    const promise = (async () => {
      const record =
        bucket.diskSessions.get(sessionId) ??
        (await this.scanner.findBySessionId(sessionId, bucket.workspaceKey));
      if (!record || bucket.disposed) return null;
      const loaded = await loadHydratedPiSessionFromDisk({
        scanner: this.scanner,
        record,
        workspacePath: bucket.workspacePath,
        catalog: this.catalog,
      });
      if (!loaded || bucket.disposed) return null;
      return (
        bucket.sessions.get(sessionId) ??
        this.createSessionController(bucket, {
          sessionId,
          cwd: loaded.hydrated.cwd || bucket.workspacePath,
          hydratedFromDisk: loaded,
        })
      );
    })().finally(() => {
      bucket.hydratingDiskSessions.delete(sessionId);
    });
    bucket.hydratingDiskSessions.set(sessionId, promise);
    return promise;
  }

  /**
   * 打开历史会话（零子进程）：
   * 1. 优先命中内存控制器；
   * 2. 否则尝试离线水合磁盘 Pi `.jsonl`；
   * 3. 仍未找到则回落旧版 ZCode 只读历史存档快照。
   */
  async hydrateOrOpenSession(
    bucket: PiWorkspaceBucket,
    sessionId: string,
  ): Promise<PiSessionController> {
    const existing = bucket.sessions.get(sessionId);
    if (existing) return existing;
    const inflight = bucket.hydratingOpenSessions.get(sessionId);
    if (inflight) return inflight;

    const promise = (async () => {
      const fromDisk = await this.tryHydrateDiskSession(bucket, sessionId);
      if (fromDisk) return fromDisk;
      const readOnlyArchive = await buildLegacyReadOnlyArchivePayload({
        sessionId,
        env: this.env,
      });
      return (
        bucket.sessions.get(sessionId) ??
        this.createSessionController(bucket, {
          sessionId,
          readOnlyArchive,
        })
      );
    })().finally(() => {
      bucket.hydratingOpenSessions.delete(sessionId);
    });
    bucket.hydratingOpenSessions.set(sessionId, promise);
    return promise;
  }

  async reconcileSessionsIndex(target: ZCodeAgentWorkspaceTarget, sessionIds: readonly string[]) {
    const bucket = this.getOrCreateWorkspace(target);
    await this.ensureInitialDiskScan(bucket);
    return buildReconciledSessionsResult({
      sessionIds,
      sessions: bucket.sessions,
      diskSessions: bucket.diskSessions,
      deletedSessionIds: bucket.deletedSessionIds,
    });
  }

  rememberCommandAck(
    bucket: PiWorkspaceBucket,
    sessionId: string | null,
    commandId: string,
    ack: CommandAck,
  ): void {
    bucket.commandAckCache.set(commandCacheKey(sessionId, commandId), ack);
    const cap = PROTOCOL_V4_LIMITS.idempotencyTablePerSession * 4;
    if (bucket.commandAckCache.size > cap) {
      const oldest = bucket.commandAckCache.keys().next().value;
      if (oldest !== undefined) bucket.commandAckCache.delete(oldest);
    }
  }

  async subscribeSessionsIndex(
    target: ZCodeAgentWorkspaceTarget,
    options?: { readonly subscriberScope?: string | undefined },
  ): Promise<SubscribeAck> {
    const bucket = this.getOrCreateWorkspace(target);
    const subscriptionId = this.nextSubscriptionId("pi_idx");
    const sub: TopicSubscriptionState = {
      subscriptionId,
      topic: sessionsIndexTopic(bucket.workspaceKey),
      logicalFrameOrdinal: 0,
    };

    if (options?.subscriberScope === TASK_INDEX_SUBSCRIBER_SCOPE) {
      // task-index syncer 的首帧快照静默写库不发侧栏刷新广播；
      // 先下发空基线快照，再通过 session.upserted delta 触发 workspace_task_list_changed 立即点亮侧栏。
      bucket.sessionsIndexSubs.set(subscriptionId, sub);
      this.emitSessionsIndexSnapshot(bucket, sub, "initial", []);
      const seqAtSubscribe = bucket.sessionsIndexSeq;
      const scheduleDeferredUpsert = () => {
        const timer = setTimeout(() => {
          bucket.deferredTimers.delete(timer);
          if (bucket.disposed || !bucket.sessionsIndexSubs.has(subscriptionId)) return;
          if (bucket.sessionsIndexSeq !== seqAtSubscribe) return;
          const latest = this.getMergedPublishedSummaries(bucket);
          if (latest.length > 0) {
            this.emitSessionsIndexDeltas(
              bucket,
              latest.map((session) => ({ op: "session.upserted" as const, session })),
            );
          }
        }, 0);
        timer.unref?.();
        bucket.deferredTimers.add(timer);
      };
      if (!bucket.initialScanDone) {
        // #42 跟进：若首次扫描在 1 个微任务窗内已填充 diskSessions 且未发过 delta，补发一次合并 upsert。
        void this.ensureInitialDiskScan(bucket).then(() => {
          if (
            !bucket.disposed &&
            bucket.sessionsIndexSubs.has(subscriptionId) &&
            bucket.sessionsIndexSeq === seqAtSubscribe
          ) {
            scheduleDeferredUpsert();
          }
        });
      } else if (this.getMergedPublishedSummaries(bucket).length > 0) {
        scheduleDeferredUpsert();
      }
      return { subscriptionId, mode: "snapshot", logEpoch: bucket.sessionsIndexLogEpoch };
    }

    await this.ensureInitialDiskScan(bucket);
    if (!bucket.disposed) {
      bucket.sessionsIndexSubs.set(subscriptionId, sub);
      this.emitSessionsIndexSnapshot(bucket, sub, "initial");
    }
    return { subscriptionId, mode: "snapshot", logEpoch: bucket.sessionsIndexLogEpoch };
  }

  resyncSessionsIndex(target: ZCodeAgentWorkspaceTarget, subscriptionId: string): SubscribeAck {
    const bucket = this.getOrCreateWorkspace(target);
    const sub = bucket.sessionsIndexSubs.get(subscriptionId);
    if (!sub) throw new Error("fault.subscription.notOwned");
    this.emitSessionsIndexSnapshot(bucket, sub, "recovery");
    return {
      subscriptionId: sub.subscriptionId,
      mode: "snapshot",
      logEpoch: bucket.sessionsIndexLogEpoch,
    };
  }

  subscribeWorkspaceConfig(target: ZCodeAgentWorkspaceTarget): SubscribeAck {
    const bucket = this.getOrCreateWorkspace(target);
    const subscriptionId = this.nextSubscriptionId("pi_cfg");
    const sub: TopicSubscriptionState = {
      subscriptionId,
      topic: workspaceConfigTopic(bucket.workspaceKey),
      logicalFrameOrdinal: 0,
    };
    bucket.workspaceConfigSubs.set(subscriptionId, sub);
    this.emitWorkspaceConfigSnapshot(bucket, sub, "initial");
    return { subscriptionId, mode: "snapshot", logEpoch: bucket.workspaceConfigLogEpoch };
  }

  resyncWorkspaceConfig(target: ZCodeAgentWorkspaceTarget, subscriptionId: string): SubscribeAck {
    const bucket = this.getOrCreateWorkspace(target);
    const sub = bucket.workspaceConfigSubs.get(subscriptionId);
    if (!sub) throw new Error("fault.subscription.notOwned");
    this.emitWorkspaceConfigSnapshot(bucket, sub, "recovery");
    return {
      subscriptionId: sub.subscriptionId,
      mode: "snapshot",
      logEpoch: bucket.workspaceConfigLogEpoch,
    };
  }

  broadcastCatalogConfigUpdate(): void {
    const config = this.buildCurrentWorkspaceConfig();
    const sentAt = Date.now();
    for (const bucket of this.workspaces.values()) {
      if (bucket.workspaceConfigSubs.size === 0) continue;
      const fromSeq = bucket.workspaceConfigSeq;
      bucket.workspaceConfigSeq += 1;
      emitWorkspaceConfigDeltaFrames(
        bucket.workspaceConfigSubs.values(),
        { fromSeq, toSeq: bucket.workspaceConfigSeq, config },
        sentAt,
        (wire) => bucket.workspaceConfigFrameEmitter.fire(wire),
      );
    }
  }

  async getSessionFilePath(
    target: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): Promise<string | null> {
    const bucket = this.getWorkspace(target);
    const liveFile = bucket?.sessions.get(sessionId)?.getSessionFilePath();
    if (liveFile) return liveFile;
    const disk = bucket?.diskSessions.get(sessionId);
    if (disk) return disk.file;
    const scanned = await this.scanner.findBySessionId(sessionId, bucket?.workspaceKey ?? "");
    return scanned?.file ?? null;
  }

  async reloadSessionAfterRewind(
    target: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): Promise<void> {
    const bucket = this.getOrCreateWorkspace(target);
    const existing = bucket.sessions.get(sessionId);
    const fallbackFilePath =
      existing?.getSessionFilePath() ?? bucket.diskSessions.get(sessionId)?.file ?? null;
    if (existing) await existing.stopRuntime();
    const loaded = await reloadRewoundPiSessionFromDisk({
      scanner: this.scanner,
      bucket,
      sessionId,
      fallbackFilePath,
      catalog: this.catalog,
    });
    if (!loaded || bucket.disposed) return;
    if (existing) {
      existing.reloadFromHydratedDisk(loaded.filePath, loaded.hydrated);
    } else {
      this.createSessionController(bucket, {
        sessionId,
        cwd: loaded.hydrated.cwd || bucket.workspacePath,
        hydratedFromDisk: loaded,
      });
    }
  }

  findLiveClientForWorkspace(workspacePath?: string): PiRpcClient | null {
    if (workspacePath?.trim()) {
      const bucket = this.getWorkspace({ workspacePath });
      if (!bucket) return null;
      for (const ctrl of bucket.sessions.values()) {
        const client = ctrl.getLiveClient();
        if (client) return client;
      }
      return null;
    }
    for (const bucket of this.workspaces.values()) {
      for (const ctrl of bucket.sessions.values()) {
        const client = ctrl.getLiveClient();
        if (client) return client;
      }
    }
    return null;
  }

  async listAllPiSessions(): Promise<PiDiscoveredSessionRecord[]> {
    const deletedIds = new Set<string>();
    for (const bucket of this.workspaces.values()) {
      for (const deletedId of bucket.deletedSessionIds) deletedIds.add(deletedId);
    }

    const diskRecords = await this.scanner.scanAll("");
    const bySessionId = new Map<string, PiDiscoveredSessionRecord>();
    for (const record of diskRecords) {
      if (deletedIds.has(record.sessionId)) continue;
      bySessionId.set(record.sessionId, {
        sessionId: record.sessionId,
        cwd: record.cwd,
        normalizedCwd: record.normalizedCwd,
        file: record.file,
        title: record.summary.title,
        titleSource: record.summary.titleSource === "custom" ? "custom" : "default",
        createdAt: record.summary.createdAt,
        lastActivityAt: record.summary.lastActivityAt,
        ...(record.summary.lastOutcome ? { lastOutcome: record.summary.lastOutcome } : {}),
        ...(record.summary.parentSessionId
          ? { parentSessionId: record.summary.parentSessionId }
          : {}),
        live: false,
      });
    }

    for (const bucket of this.workspaces.values()) {
      if (bucket.disposed) continue;
      for (const [sessionId, controller] of bucket.sessions) {
        if (deletedIds.has(sessionId) || controller.readOnly || !controller.isPublishedToIndex()) {
          continue;
        }
        const summary = controller.getSummary();
        const cwd = controller.cwd || bucket.workspacePath;
        const normalizedCwd = normalizeWorkspacePathKey(cwd, this.platform);
        if (!normalizedCwd) continue;
        const existing = bySessionId.get(sessionId);
        const file = controller.getSessionFilePath() ?? existing?.file;
        bySessionId.set(sessionId, {
          sessionId,
          cwd,
          normalizedCwd,
          ...(file ? { file } : {}),
          title: summary.title || existing?.title || "",
          titleSource: summary.titleSource === "custom" ? "custom" : "default",
          createdAt: summary.createdAt,
          lastActivityAt: Math.max(summary.lastActivityAt, existing?.lastActivityAt ?? 0),
          ...(summary.lastOutcome ? { lastOutcome: summary.lastOutcome } : {}),
          ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
          live: true,
        });
      }
    }

    return [...bySessionId.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  watchAllPiSessions(onChange: () => void): () => void {
    let closed = false;
    let liveTimer: ReturnType<typeof setTimeout> | null = null;
    const stopDiskWatch = this.scanner.watchSessions(() => {
      if (!closed) onChange();
    });
    const onLiveChange = () => {
      if (closed) return;
      if (liveTimer) clearTimeout(liveTimer);
      liveTimer = setTimeout(() => {
        liveTimer = null;
        if (!closed) onChange();
      }, LIVE_SESSION_REGISTRY_DEBOUNCE_MS);
      liveTimer.unref?.();
    };
    this.sessionRegistryListeners.add(onLiveChange);
    return () => {
      if (closed) return;
      closed = true;
      if (liveTimer) {
        clearTimeout(liveTimer);
        liveTimer = null;
      }
      this.sessionRegistryListeners.delete(onLiveChange);
      stopDiskWatch();
    };
  }

  async disposeWorkspace(target: ZCodeAgentWorkspaceTarget): Promise<void> {
    const key = resolveWorkspaceKey(target);
    const bucket = this.workspaces.get(key);
    if (!bucket) return;
    this.workspaces.delete(key);
    await this.disposeBucket(bucket);
  }

  async disposeAllAndWait(): Promise<void> {
    this.sessionRegistryListeners.clear();
    const allBuckets = [...this.workspaces.values()];
    this.workspaces.clear();
    await Promise.all(allBuckets.map((bucket) => this.disposeBucket(bucket)));
    this.scanner.dispose();
  }

  private notifySessionRegistryChanged(): void {
    for (const listener of this.sessionRegistryListeners) {
      listener();
    }
  }

  private emitSessionsIndexDeltas(
    bucket: PiWorkspaceBucket,
    deltas: readonly PiSessionsIndexDeltaItem[],
  ): void {
    if (deltas.length === 0 || bucket.disposed) return;
    const fromSeq = bucket.sessionsIndexSeq;
    bucket.sessionsIndexSeq += 1;
    emitSessionsIndexDeltaFrames(
      bucket.sessionsIndexSubs.values(),
      { fromSeq, toSeq: bucket.sessionsIndexSeq, deltas },
      Date.now(),
      (wire) => bucket.sessionsIndexFrameEmitter.fire(wire),
    );
  }

  private emitSessionsIndexSnapshot(
    bucket: PiWorkspaceBucket,
    sub: TopicSubscriptionState,
    deliveryKind: "initial" | "recovery",
    sessionsOverride?: readonly SessionSummary[],
  ): void {
    const snapshot = createSessionsIndexSnapshot({
      workspaceId: bucket.workspaceKey,
      logEpoch: bucket.sessionsIndexLogEpoch,
      sessions: sessionsOverride ?? this.getMergedPublishedSummaries(bucket),
    });
    emitSessionsIndexSnapshotFrames(sub, snapshot, bucket.sessionsIndexSeq, deliveryKind, (wire) =>
      bucket.sessionsIndexFrameEmitter.fire(wire),
    );
  }

  private buildCurrentWorkspaceConfig() {
    const snap = this.catalog.getSnapshot();
    return buildWorkspaceConfigStateFromPiModels(
      snap.models,
      snap.defaultModel,
      snap.defaultThinkingLevel,
    );
  }

  private emitWorkspaceConfigSnapshot(
    bucket: PiWorkspaceBucket,
    sub: TopicSubscriptionState,
    deliveryKind: "initial" | "recovery",
  ): void {
    const snapshot = createWorkspaceConfigSnapshot({
      workspaceId: bucket.workspaceKey,
      logEpoch: bucket.workspaceConfigLogEpoch,
      config: this.buildCurrentWorkspaceConfig(),
    });
    emitWorkspaceConfigSnapshotFrames(
      sub,
      snapshot,
      bucket.workspaceConfigSeq,
      deliveryKind,
      (wire) => bucket.workspaceConfigFrameEmitter.fire(wire),
    );
  }

  private emitRuntimeLifecycle(
    bucket: PiWorkspaceBucket,
    state: "available" | "unavailable",
  ): void {
    this.onRuntimeLifecycle?.({
      workspacePath: bucket.workspacePath,
      ...(bucket.workspaceIdentity ? { workspaceIdentity: bucket.workspaceIdentity } : {}),
      workspaceKey: bucket.workspaceKey,
      runtimeIdentity: {
        generation: bucket.generation,
        identity: bucket.identity,
        workspaceKey: bucket.workspaceKey,
      },
      state,
    });
  }

  private async disposeBucket(bucket: PiWorkspaceBucket): Promise<void> {
    bucket.disposed = true;
    bucket.watcherDispose?.();
    bucket.watcherDispose = null;
    for (const timer of bucket.deferredTimers) clearTimeout(timer);
    bucket.deferredTimers.clear();
    const controllers = [...bucket.sessions.values()];
    bucket.sessions.clear();
    bucket.diskSessions.clear();
    bucket.sessionsIndexSubs.clear();
    bucket.workspaceConfigSubs.clear();
    this.emitRuntimeLifecycle(bucket, "unavailable");
    await Promise.all(controllers.map((controller) => controller.disposeAndWait()));
    bucket.conversationFrameEmitter.dispose();
    bucket.sessionsIndexFrameEmitter.dispose();
    bucket.workspaceConfigFrameEmitter.dispose();
    bucket.sessionLifecycleEmitter.dispose();
  }
}
