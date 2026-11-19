/**
 * 单个 Pi 会话的控制器：管理懒加载 PiRpcClient、PiEventProjector、V4 订阅广播与生命周期。
 *
 * 关键不变量：
 * - draft 空会话绝不拉起 Pi 子进程，也不发布到 sessions-index；首条有效输入到达后才 promote + spawn；
 * - POSIX 管道合帧竞态通过 `agentLifecycleSeq` 防护，且 `disposition === "handled"` 立即收口；
 * - `stop` 一律先 `clear_queue` 再 `abort`，并将队列置为 `autoDrain = false, pauseReason = "stopped"`；
 * - 所有 V4 帧经 `encodeV4TopicFrames`（wireVersion=3 + 物理字节计量）下发。
 */
import { randomUUID } from "node:crypto";
import type {
  ModelSelection,
  SessionLifecycleSnapshot,
  ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  conversationTopic,
  type CommandAck,
  type CommandEnvelope,
  type CommandPayloadMap,
  type SessionSummary,
  type SubscribeAck,
  type V4ConversationFileChangesResult,
  type V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { PiModelInfo, PiRpcEvent, PiRpcExitInfo } from "#src/pi-runtime/contract.js";
import type { HydratedPiSessionResult } from "#src/pi-runtime/domain/piJsonlHydrator.js";
import {
  PiEventProjector,
  type ProjectionCommit,
} from "#src/pi-runtime/domain/piEventProjector.js";
import {
  buildLegacySessionStateSnapshot,
  buildSessionSummary,
  createCommandAck,
  isSessionRunningPhase,
} from "#src/pi-runtime/domain/piSnapshotFactory.js";
import { formatRedactedPiError } from "#src/pi-runtime/adapters/piDiscover.js";
import {
  emitConversationDeltaFrames,
  emitConversationSnapshotFrames,
  type TopicSubscriptionState,
} from "#src/pi-runtime/adapters/piFrameEncoder.js";
import type { PiModelCatalog } from "#src/pi-runtime/adapters/piModelCatalog.js";
import {
  cancelClientInteractionsAndAbort,
  hydratePiClientInitialState,
  resolveInitialControllerConfig,
  resolveRequestedSelectionSwitch,
  spawnConfiguredPiClient,
  syncPiModelAndThoughtToClient,
  type PiSessionControllerCallbacks,
  type PiSessionControllerOptions,
  type ResolvedModelTarget,
} from "#src/pi-runtime/adapters/piModelSync.js";
import type { PiRpcClient } from "#src/pi-runtime/adapters/piRpcClient.js";
import {
  dispatchPiAuxCommand,
  dispatchPiSendText,
  type PiSessionCommandHost,
} from "#src/pi-runtime/adapters/piSessionCommands.js";

const logger = createServiceLogger("pi-session-controller");

export type { PiSessionControllerCallbacks, PiSessionControllerOptions };

export class PiSessionController {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly workspaceIdentity: string | undefined;
  readonly cwd: string;
  readonly parentSessionId: string | undefined;
  readonly createdAt: number;
  readonly readOnly: boolean;

  private lastActivityAt: number;
  private publishedToIndex = false;
  private readonly projector: PiEventProjector;
  private readonly catalog: PiModelCatalog;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly platform: NodeJS.Platform | undefined;
  private readonly managedRuntimeDir: string | undefined;
  private readonly callbacks: PiSessionControllerCallbacks;
  private readonly subscriptions = new Map<string, TopicSubscriptionState>();
  private client: PiRpcClient | null = null;
  private clientEventUnsub: (() => void) | null = null;
  private clientExitUnsub: (() => void) | null = null;
  private spawnPromise: Promise<PiRpcClient> | null = null;
  private activeClientModel: PiModelInfo | undefined;
  private activeClientModelKey = "";
  private activeClientThinking = "";
  private piSessionFile: string | undefined;
  private disposed = false;

  constructor(options: PiSessionControllerOptions) {
    this.sessionId = options.sessionId;
    this.workspaceId = options.workspaceId;
    this.workspacePath = options.workspacePath;
    this.workspaceIdentity = options.workspaceIdentity;
    this.cwd = options.cwd;
    this.parentSessionId = options.parentSessionId;
    this.readOnly = Boolean(options.readOnlyArchive);
    const now = Date.now();
    this.createdAt = options.hydratedFromDisk?.hydrated.createdAt ?? now;
    this.lastActivityAt = options.hydratedFromDisk?.hydrated.lastActivityAt ?? this.createdAt;
    this.publishedToIndex = Boolean(options.hydratedFromDisk);
    this.piSessionFile = options.hydratedFromDisk?.filePath;
    this.catalog = options.catalog;
    this.env = options.env;
    this.platform = options.platform;
    this.managedRuntimeDir = options.managedRuntimeDir;
    this.callbacks = options.callbacks;

    const { config, contextWindowMax } = resolveInitialControllerConfig({
      catalog: this.catalog,
      modelSelection: options.modelSelection,
      thoughtLevel: options.thoughtLevel,
    });
    this.projector = new PiEventProjector({
      sessionId: this.sessionId,
      workspacePath: this.workspacePath,
      logEpoch: `pi-${randomUUID()}`,
      attemptId: `init-${randomUUID()}`,
      config,
      contextWindowMax,
      hydrated: options.hydratedFromDisk?.hydrated,
      readOnlyArchive: options.readOnlyArchive,
    });
  }

  isPublishedToIndex(): boolean {
    return this.publishedToIndex;
  }
  getRevision(): number {
    return this.projector.getRevision();
  }
  getSessionFilePath(): string | undefined {
    return this.piSessionFile;
  }
  getLiveClient(): PiRpcClient | null {
    return this.client?.alive ? this.client : null;
  }
  findTurnForCommand(commandId: string) {
    return this.projector.findTurnForCommand(commandId);
  }
  getTurnFileChanges(target: { rowId: number; entityId: string }): V4ConversationFileChangesResult {
    return this.projector.getTurnFileChanges(target);
  }
  unsubscribe(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);
  }
  async ensureReady(): Promise<void> {
    if (this.disposed || this.readOnly) return;
    await this.ensureClient();
  }
  reloadFromHydratedDisk(filePath: string, hydrated: HydratedPiSessionResult): void {
    this.piSessionFile = filePath;
    this.lastActivityAt = hydrated.lastActivityAt;
    this.publishedToIndex = true;
    this.projector.replaceWithHydratedSession(hydrated, `pi-${randomUUID()}`);
    for (const sub of this.subscriptions.values()) {
      this.emitSnapshotToSubscription(sub, "recovery");
    }
    this.callbacks.onSessionPublishedOrUpdated(this.getSummary());
  }

  getSummary(): SessionSummary {
    return buildSessionSummary(this.projector.getSnapshot(), {
      workspaceId: this.workspaceId,
      parentSessionId: this.parentSessionId,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      lastAssistantPreview: this.projector.getLastAssistantPreview(),
    });
  }

  getLegacySnapshot(): ZCodeSessionStateSnapshot {
    return buildLegacySessionStateSnapshot(
      this.projector.getSnapshot(),
      this.projector.getAllRows(),
      {
        workspacePath: this.workspacePath,
        workspaceIdentity: this.workspaceIdentity,
        parentSessionId: this.parentSessionId,
        createdAt: this.createdAt,
        updatedAt: this.lastActivityAt,
      },
    );
  }

  getLifecycleSnapshot(): SessionLifecycleSnapshot {
    return {
      sessionId: this.sessionId,
      state: this.disposed ? "unloaded" : "ready",
      generation: 1,
      revision: this.projector.getRevision(),
      lastError: null,
    };
  }

  getRowsRange(beforeRowId: number | undefined, limit: number): V4ConversationRowsRangeResult {
    const { rows, hasMore } = this.projector.getRowsRange(beforeRowId, limit);
    return {
      rows,
      atSeq: this.projector.getSeq(),
      atRevision: this.projector.getRevision(),
      atLogEpoch: this.projector.getLogEpoch(),
      hasMore,
    };
  }

  subscribe(subscriptionId: string): SubscribeAck {
    const sub: TopicSubscriptionState = {
      subscriptionId,
      topic: conversationTopic(this.sessionId),
      logicalFrameOrdinal: 0,
    };
    this.subscriptions.set(subscriptionId, sub);
    this.emitSnapshotToSubscription(sub, "initial");
    return { subscriptionId, mode: "snapshot", logEpoch: this.projector.getLogEpoch() };
  }

  resync(subscriptionId: string): SubscribeAck {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) throw new Error("fault.subscription.notOwned");
    this.emitSnapshotToSubscription(sub, "recovery");
    return { subscriptionId, mode: "snapshot", logEpoch: this.projector.getLogEpoch() };
  }

  async stopRuntime(): Promise<void> {
    const drained = this.projector.drainPendingExtensionUiInteractions();
    this.broadcastCommit(drained.commit);
    await cancelClientInteractionsAndAbort(this.client, drained.cancelledIds);
    await this.closeClientAndWait();
  }

  async runFirstInput(input: {
    commandId: string;
    clientId: string;
    text: string;
    modelSelection?: ModelSelection | undefined;
    inputOrigin?: "desktop" | "mobile" | undefined;
  }): Promise<CommandAck> {
    return this.startFreshTurn(input);
  }

  async executeCommand(envelope: CommandEnvelope): Promise<CommandAck> {
    if (this.disposed) {
      return createCommandAck({
        commandId: envelope.commandId,
        status: "rejected",
        revisionAtDecision: this.projector.getRevision(),
        reasonCode: "fault.session.disposed",
      });
    }
    if (this.readOnly && envelope.type !== "deleteSession") {
      return createCommandAck({
        commandId: envelope.commandId,
        status: "rejected",
        revisionAtDecision: this.projector.getRevision(),
        reasonCode: "guard.legacySessionReadOnly",
        message: "Legacy ZCode session is read-only archive",
      });
    }

    if (
      COMMANDS_REQUIRING_BASE_REVISION.has(envelope.type) &&
      envelope.baseRevision !== undefined &&
      envelope.baseRevision !== this.projector.getRevision()
    ) {
      return createCommandAck({
        commandId: envelope.commandId,
        status: "stale",
        revisionAtDecision: this.projector.getRevision(),
        reasonCode: "proto.staleRevision",
      });
    }

    const host = this.createCommandHost();
    if (envelope.type === "sendText") {
      return dispatchPiSendText(host, envelope, envelope.payload as CommandPayloadMap["sendText"]);
    }
    return dispatchPiAuxCommand(host, envelope);
  }

  async disposeAndWait(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const drained = this.projector.drainPendingExtensionUiInteractions();
    if (this.client?.alive) {
      for (const id of drained.cancelledIds) {
        this.client.sendExtensionUiResponse({ id, cancelled: true });
      }
    }
    this.subscriptions.clear();
    await this.closeClientAndWait();
    this.callbacks.onSessionLifecycleChanged(this.getLifecycleSnapshot());
  }

  // ───────── 内部实现 ─────────

  private createCommandHost(): PiSessionCommandHost {
    return {
      sessionId: this.sessionId,
      projector: this.projector,
      catalog: this.catalog,
      getLiveClient: () => (this.client?.alive ? this.client : null),
      ensureClient: () => this.ensureClient(),
      broadcastCommit: (commit) => this.broadcastCommit(commit),
      applyLiveModelSwitch: (target) => this.applyLiveModelSwitch(target),
      startFreshTurn: (input) => this.startFreshTurn(input),
      handleDeleteSession: (commandId) => this.handleDeleteSession(commandId),
    };
  }

  private async startFreshTurn(input: {
    commandId: string;
    clientId: string;
    text: string;
    modelSelection?: ModelSelection | undefined;
    inputOrigin?: "desktop" | "mobile" | undefined;
  }): Promise<CommandAck> {
    this.publishedToIndex = true;
    this.applyRequestedModelSelection(input.modelSelection);

    this.broadcastCommit(
      this.projector.beginUserTurn({
        commandId: input.commandId,
        clientId: input.clientId,
        text: input.text,
        nowMs: Date.now(),
        modelSelection: input.modelSelection,
        inputOrigin: input.inputOrigin,
      }),
    );

    try {
      const initialClient = await this.ensureClient();
      const activeClient = await this.syncModelConfigToClient(initialClient);
      const seqBefore = this.projector.getAgentLifecycleSeq();
      const ack = await activeClient.prompt(input.text);
      if (ack?.disposition === "handled") {
        this.broadcastCommit(this.projector.completeHandledPrompt(Date.now()));
      } else {
        this.broadcastCommit(
          this.projector.applyOptimisticRunningIfUnchanged(seqBefore, Date.now()),
        );
      }
      return createCommandAck({
        commandId: input.commandId,
        status: "accepted",
        revisionAtDecision: this.projector.getRevision(),
        result: { type: "inputAccepted", delivery: "startNow", inputId: input.commandId },
      });
    } catch (error) {
      const redacted = formatRedactedPiError(error);
      logger.warn(undefined, `Pi prompt 执行失败 session=${this.sessionId}: ${redacted}`);
      this.broadcastCommit(this.projector.failActiveTurn(redacted, Date.now(), "runtime"));
      return createCommandAck({
        commandId: input.commandId,
        status: "failed",
        revisionAtDecision: this.projector.getRevision(),
        reasonCode: "fault.pi.promptFailed",
        message: redacted,
      });
    }
  }

  private async handleDeleteSession(commandId: string): Promise<CommandAck> {
    const rev = this.projector.getRevision();
    await this.disposeAndWait();
    this.callbacks.onSessionDeleted(this.sessionId);
    return createCommandAck({ commandId, status: "accepted", revisionAtDecision: rev });
  }

  private async ensureClient(override?: {
    provider?: string | undefined;
    model?: string | undefined;
    thought?: string | undefined;
  }): Promise<PiRpcClient> {
    if (this.client?.alive) return this.client;
    if (this.spawnPromise) return this.spawnPromise;
    if (this.disposed) throw new Error("Session disposed before starting Pi");
    if (this.readOnly) throw new Error("Legacy ZCode archive session is read-only");

    // 先同步占位 spawnPromise 再 await discoverPi，防止并发调用或关闭期间 discoverPi 竞态泄漏双进程。
    const promise = (async () => {
      const config = this.projector.getSnapshot().config;
      const spawned = await spawnConfiguredPiClient({
        sessionId: this.sessionId,
        cwd: this.cwd,
        env: this.env,
        platform: this.platform,
        managedRuntimeDir: this.managedRuntimeDir,
        sessionFile: this.piSessionFile,
        provider: override?.provider ?? config.provider,
        model: override?.model ?? config.model,
        thought: override?.thought ?? config.thought,
        isDisposed: () => this.disposed,
      });
      if (spawned.sessionFile) this.piSessionFile = spawned.sessionFile;
      this.attachClient(spawned.client);
      await this.hydrateFromClientState(spawned.client);
      return spawned.client;
    })().finally(() => {
      if (this.spawnPromise === promise) this.spawnPromise = null;
    });

    this.spawnPromise = promise;
    return promise;
  }

  private attachClient(client: PiRpcClient): void {
    const previous = this.client;
    this.detachClientListeners();
    this.client = client;
    if (previous && previous !== client && previous.alive) {
      void previous.closeAndWait(2_000).catch(() => {});
    }
    this.clientEventUnsub = client.onEvent((event) => this.handlePiEvent(event));
    this.clientExitUnsub = client.onExit((info) => this.handlePiExit(client, info));
  }

  private detachClientListeners(): void {
    this.clientEventUnsub?.();
    this.clientEventUnsub = null;
    this.clientExitUnsub?.();
    this.clientExitUnsub = null;
  }

  private async hydrateFromClientState(client: PiRpcClient): Promise<void> {
    try {
      const hydrated = await hydratePiClientInitialState(
        client,
        this.catalog,
        this.projector.getSnapshot().config,
      );
      if (hydrated.sessionFile) this.piSessionFile = hydrated.sessionFile;
      if (hydrated.model) this.activeClientModel = hydrated.model;
      if (hydrated.modelKey) this.activeClientModelKey = hydrated.modelKey;
      this.activeClientThinking = hydrated.thinkingLevel;
      this.projector.setContextWindowMax(hydrated.contextWindow);
      if (hydrated.initialConfigPatch) {
        this.broadcastCommit(this.projector.applyConfigUpdate(hydrated.initialConfigPatch));
      }
    } catch (error) {
      logger.warn(undefined, `Pi 初始状态同步失败: ${formatRedactedPiError(error)}`);
    }
  }

  private applyRequestedModelSelection(selection: ModelSelection | undefined): void {
    const resolved = resolveRequestedSelectionSwitch(
      this.catalog,
      this.projector.getSnapshot().config,
      selection,
    );
    if (!resolved) return;
    this.projector.setContextWindowMax(resolved.contextWindow);
    this.broadcastCommit(
      this.projector.applyModelSwitch({
        provider: resolved.provider,
        model: resolved.model,
        thought: resolved.thought,
        thoughtLevels: resolved.thoughtLevels,
        nowMs: Date.now(),
      }),
    );
  }

  private async applyLiveModelSwitch(
    target: ResolvedModelTarget,
    allowIdleRespawn = false,
  ): Promise<{
    readonly client: PiRpcClient;
    readonly thought: string;
    readonly thoughtLevels: readonly string[];
    readonly contextWindow?: number | undefined;
  }> {
    const client = this.client?.alive ? this.client : await this.ensureClient(target);
    const outcome = await syncPiModelAndThoughtToClient({
      client,
      target,
      activeClientModelKey: this.activeClientModelKey,
      activeClientThinking: this.activeClientThinking,
      isRunning:
        !allowIdleRespawn && isSessionRunningPhase(this.projector.getSnapshot().control.phase),
      respawnIdleClient: async (nextTarget) => {
        await this.closeClientAndWait();
        this.activeClientModel = undefined;
        this.activeClientModelKey = "";
        this.activeClientThinking = "";
        const fresh = await this.ensureClient(nextTarget);
        return {
          client: fresh,
          model: this.activeClientModel,
          modelKey: this.activeClientModelKey,
          thinkingLevel: this.activeClientThinking,
        };
      },
    });
    if (outcome.model) this.activeClientModel = outcome.model;
    this.activeClientModelKey = outcome.modelKey;
    this.activeClientThinking = outcome.thinkingLevel;
    this.projector.setContextWindowMax(outcome.contextWindow);
    return {
      client: outcome.client,
      thought: outcome.thinkingLevel,
      thoughtLevels: outcome.thoughtLevels,
      contextWindow: outcome.contextWindow,
    };
  }

  private async syncModelConfigToClient(client: PiRpcClient): Promise<PiRpcClient> {
    const config = this.projector.getSnapshot().config;
    if (!config.provider || !config.model) return client;
    try {
      // 回合 prompt 尚未下发给 Pi，子进程仍空闲，允许 /model not found/i 时空闲重启一次。
      const synced = await this.applyLiveModelSwitch(
        {
          provider: config.provider,
          model: config.model,
          thought: config.thought,
          thoughtLevels: config.thoughtLevels,
        },
        true,
      );
      return synced.client;
    } catch (error: unknown) {
      if (client.alive) {
        logger.warn(undefined, `Pi 回合前同步模型失败: ${formatRedactedPiError(error)}`);
      }
      return this.client?.alive ? this.client : client;
    }
  }

  private handlePiEvent(event: PiRpcEvent): void {
    if (this.disposed) return;
    if (event.type === "thinking_level_changed") {
      const trimmed = event.level.trim();
      if (trimmed) this.activeClientThinking = trimmed;
    }
    this.broadcastCommit(this.projector.applyPiEvent(event, Date.now()));
  }

  private handlePiExit(exitedClient: PiRpcClient, info: PiRpcExitInfo): void {
    if (this.client === exitedClient) {
      this.detachClientListeners();
      this.client = null;
    }
    if (this.disposed) return;
    const drained = this.projector.drainPendingExtensionUiInteractions();
    this.broadcastCommit(drained.commit);
    if (isSessionRunningPhase(this.projector.getSnapshot().control.phase)) {
      const suffix = info.stderr ? `: ${info.stderr}` : "";
      this.broadcastCommit(
        this.projector.failActiveTurn(
          `Pi process exited unexpectedly (code=${String(info.code)}, signal=${String(info.signal)})${suffix}`,
          Date.now(),
          "runtime",
        ),
      );
    }
  }

  private async closeClientAndWait(): Promise<void> {
    if (this.spawnPromise) await this.spawnPromise.catch(() => {});
    const client = this.client;
    this.detachClientListeners();
    this.client = null;
    if (client) await client.closeAndWait(3_000).catch(() => {});
  }

  private emitSnapshotToSubscription(
    sub: TopicSubscriptionState,
    deliveryKind: "initial" | "recovery",
  ): void {
    emitConversationSnapshotFrames(sub, this.projector.getSnapshot(), deliveryKind, (wire) =>
      this.callbacks.emitConversationFrame(wire),
    );
  }

  private broadcastCommit(commit: ProjectionCommit | null): void {
    if (!commit || commit.deltas.length === 0 || this.disposed) return;
    this.lastActivityAt = Date.now();
    emitConversationDeltaFrames(this.subscriptions.values(), commit, this.lastActivityAt, (wire) =>
      this.callbacks.emitConversationFrame(wire),
    );
    if (this.publishedToIndex) {
      this.callbacks.onSessionPublishedOrUpdated(this.getSummary());
    }
  }
}
