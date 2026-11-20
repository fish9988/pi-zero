/** 单个 Pi 会话的控制器：管理懒加载 PiRpcClient、PiEventProjector、V4 订阅广播与生命周期。 */
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
  type UserInputRow,
  type V4ConversationFileChangesResult,
  type V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { PiModelInfo, PiRpcEvent, PiRpcExitInfo } from "#src/pi-runtime/contract.js";
import type { HydratedPiSessionResult } from "#src/pi-runtime/domain/piJsonlHydrator.js";
import { rewindPiSessionFileBeforeOrdinal } from "#src/pi-runtime/adapters/piSessionRewind.js";
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
import { PiAttachmentStore } from "#src/pi-runtime/adapters/piAttachmentStore.js";
import { formatRedactedPiError } from "#src/pi-runtime/adapters/piDiscover.js";
import {
  PiDeltaCoalescer,
  shouldNotifySessionIndexForCommit,
} from "#src/pi-runtime/adapters/piDeltaCoalescer.js";
import {
  applyPiExtensionUiEvent,
  clearPiSessionExtensionUiState,
} from "#src/pi-runtime/adapters/piExtensionUiStateStore.js";
import {
  emitConversationDeltaFrames,
  emitConversationSnapshotFrames,
  type TopicSubscriptionState,
} from "#src/pi-runtime/adapters/piFrameEncoder.js";
import type { PiModelCatalog } from "#src/pi-runtime/adapters/piModelCatalog.js";
import {
  cancelClientInteractionsAndAbort,
  hydratePiClientInitialState,
  normalizePiExecutionMode,
  resolveInitialControllerConfig,
  resolveModelCostFromCatalog,
  resolveRequestedSelectionSwitch,
  spawnConfiguredPiClient,
  syncPiModelAndThoughtToClient,
  type PiExecutionMode,
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
  private readonly attachments: PiAttachmentStore;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly platform: NodeJS.Platform | undefined;
  private readonly managedRuntimeDir: string | undefined;
  private readonly isBuiltinAskQuestionEnabled: (() => Promise<boolean> | boolean) | undefined;
  private readonly callbacks: PiSessionControllerCallbacks;
  private readonly subscriptions = new Map<string, TopicSubscriptionState>();
  private readonly deltaCoalescer: PiDeltaCoalescer;
  private client: PiRpcClient | null = null;
  private clientEventUnsub: (() => void) | null = null;
  private clientExitUnsub: (() => void) | null = null;
  private spawnPromise: Promise<PiRpcClient> | null = null;
  private activeClientModel: PiModelInfo | undefined;
  private activeClientModelKey = "";
  private activeClientThinking = "";
  private activeClientMode: PiExecutionMode = "build";
  private piSessionFile: string | undefined;
  private inFlightPromptDispatch: Promise<void> | null = null;
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
    this.attachments = options.attachments ?? new PiAttachmentStore();
    this.env = options.env;
    this.platform = options.platform;
    this.managedRuntimeDir = options.managedRuntimeDir;
    this.isBuiltinAskQuestionEnabled = options.isBuiltinAskQuestionEnabled;
    this.callbacks = options.callbacks;

    const { config, contextWindowMax, modelCost } = resolveInitialControllerConfig({
      catalog: this.catalog,
      modelSelection: options.modelSelection,
      thoughtLevel: options.thoughtLevel,
      mode: options.mode,
    });
    this.activeClientMode = normalizePiExecutionMode(config.mode);
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
    this.projector.setModelCost(modelCost);
    this.deltaCoalescer = new PiDeltaCoalescer((batch) => this.emitCommittedBatch(batch));
  }

  isPublishedToIndex = () => this.publishedToIndex;
  getRevision = () => this.projector.getRevision();
  getSessionFilePath = () => this.piSessionFile;
  getLiveClient = () => (this.client?.alive ? this.client : null);
  findTurnForCommand = (commandId: string) => this.projector.findTurnForCommand(commandId);
  getTurnFileChanges = (target: { rowId: number; entityId: string }) =>
    this.projector.getTurnFileChanges(target);
  getSubagentDirectorySnapshot = () => this.projector.getSubagentDirectorySnapshot();
  getAttachmentAuthSource = () => ({
    rows: this.projector.getAllRows(),
    queueItems: this.projector.getSnapshot().queue.items,
  });
  async applyExternalTitle(title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed || this.disposed) return;
    this.broadcastCommit(this.projector.applyRename(trimmed));
    if (this.client?.alive) await this.client.setSessionName(trimmed).catch(() => {});
  }
  unsubscribe = (subscriptionId: string) => this.subscriptions.delete(subscriptionId);
  updateVirtualSubagentSnapshot(
    snapshot: import("@zcode/shared/zcode-protocol-v4").ConversationSnapshot,
    rows: readonly import("@zcode/shared/zcode-protocol-v4").WireConversationRow[],
  ): void {
    this.deltaCoalescer.dispose();
    this.lastActivityAt = Date.now();
    this.projector.replaceWithVirtualSnapshot(snapshot, rows);
    for (const sub of this.subscriptions.values()) this.emitSnapshotToSubscription(sub, "recovery");
  }
  async ensureReady(): Promise<void> {
    if (this.disposed || this.readOnly) return;
    await this.ensureClient();
  }
  reloadFromHydratedDisk(filePath: string, hydrated: HydratedPiSessionResult): void {
    this.deltaCoalescer.dispose();
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
    attachments?: UserInputRow["attachments"] | undefined;
    conversationQuotes?: UserInputRow["conversationQuotes"] | undefined;
    modelSelection?: ModelSelection | undefined;
    mode?: string | undefined;
    inputOrigin?: "desktop" | "mobile" | undefined;
  }): Promise<CommandAck> {
    if (input.mode) {
      const normalizedMode = normalizePiExecutionMode(input.mode);
      const prev = this.projector.getSnapshot().config;
      if (prev.mode !== normalizedMode) {
        this.broadcastCommit(this.projector.applyConfigUpdate({ ...prev, mode: normalizedMode }));
      }
    }
    // 首页首条提交采用“先发布+先回显+立即返回 ACK，后台异步拉起 Pi 并投递 prompt”，
    // 消除侧栏秒出但主界面原地等待 Pi 冷启动 1-2 秒才跳转的割裂感。
    return this.startFreshTurn(input, { nonBlocking: true });
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
    this.deltaCoalescer.dispose();
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
      resolvePromptPayload: (text, attachments) =>
        this.attachments.resolvePromptPayload(text, attachments),
      broadcastCommit: (commit) => this.broadcastCommit(commit),
      applyLiveModelSwitch: (target) => this.applyLiveModelSwitch(target),
      applyModeSwitch: (mode) => this.applyModeSwitch(mode),
      startFreshTurn: (input, options) => this.startFreshTurn(input, options),
      waitForInFlightPromptDispatch: () =>
        this.inFlightPromptDispatch?.catch(() => undefined) ?? Promise.resolve(),
      handleEditUserQuery: (commandId, clientId, payload, inputOrigin) =>
        this.handleEditUserQuery(commandId, clientId, payload, inputOrigin),
      handleDeleteSession: (commandId) => this.handleDeleteSession(commandId),
    };
  }

  private async applyModeSwitch(requestedMode: string): Promise<void> {
    const normalizedMode = normalizePiExecutionMode(requestedMode);
    const prev = this.projector.getSnapshot().config;
    if (prev.mode !== normalizedMode) {
      this.broadcastCommit(this.projector.applyConfigUpdate({ ...prev, mode: normalizedMode }));
    }
    // Pi 工具白名单（--tools）属于进程启动参数：空闲状态下若模式已变更，优雅关闭旧进程，
    // 下次提问时自动按新模式（标准 / 只读）并以同一 sessionFile 无缝重启。
    if (
      this.client?.alive &&
      this.activeClientMode !== normalizedMode &&
      !isSessionRunningPhase(this.projector.getSnapshot().control.phase)
    ) {
      await this.closeClientAndWait();
    }
  }

  private async handleEditUserQuery(
    commandId: string,
    clientId: string,
    payload: CommandPayloadMap["editUserQuery"],
    inputOrigin?: "desktop" | "mobile" | undefined,
  ): Promise<CommandAck> {
    const targetInfo = this.projector.findUserRowInfo(payload.target.rowId);
    if (!targetInfo) {
      return createCommandAck({
        commandId,
        status: "rejected",
        revisionAtDecision: this.projector.getRevision(),
        reasonCode: "proto.targetRowNotFound",
        message: "Target user message not found for edit",
      });
    }

    // 先停止活跃 Pi 进程，防止其 session_shutdown 写回旧叶子造成断链。
    if (isSessionRunningPhase(this.projector.getSnapshot().control.phase) && this.client?.alive) {
      await this.client.clearQueue().catch(() => {});
      await this.client.abort().catch(() => {});
    }
    await this.closeClientAndWait();
    let rewoundFromDisk = false;
    if (this.piSessionFile) {
      try {
        const hydrated = await rewindPiSessionFileBeforeOrdinal({
          filePath: this.piSessionFile,
          sessionId: this.sessionId,
          cwd: this.cwd,
          userOrdinal: targetInfo.userOrdinal,
          catalog: this.catalog,
        });
        if (hydrated) {
          this.reloadFromHydratedDisk(this.piSessionFile, hydrated);
          rewoundFromDisk = true;
        }
      } catch (error) {
        logger.warn(undefined, `Pi editUserQuery 磁盘回退失败: ${formatRedactedPiError(error)}`);
      }
    }
    if (!rewoundFromDisk) {
      this.deltaCoalescer.dispose();
      this.projector.rewindInMemoryBeforeRow(payload.target.rowId, `pi-${randomUUID()}`);
      for (const sub of this.subscriptions.values())
        this.emitSnapshotToSubscription(sub, "recovery");
      if (this.publishedToIndex) this.callbacks.onSessionPublishedOrUpdated(this.getSummary());
    }
    const effectiveMode =
      payload.planEnabled === true
        ? "plan"
        : payload.mode
          ? normalizePiExecutionMode(payload.mode)
          : undefined;
    if (effectiveMode) await this.applyModeSwitch(effectiveMode);
    const startAck = await this.startFreshTurn(
      {
        commandId,
        clientId,
        text: payload.newText,
        attachments:
          payload.attachments !== undefined ? payload.attachments : targetInfo.row.attachments,
        conversationQuotes:
          payload.conversationQuotes !== undefined
            ? payload.conversationQuotes
            : targetInfo.row.conversationQuotes,
        modelSelection: payload.modelSelection ?? targetInfo.row.modelSelection,
        inputOrigin,
      },
      { nonBlocking: true },
    );
    if (startAck.status !== "accepted") return startAck;
    return createCommandAck({
      commandId,
      status: "accepted",
      revisionAtDecision: this.projector.getRevision(),
      result: { type: "editUserQuery", disposition: "rewind", sessionId: this.sessionId },
    });
  }

  private async startFreshTurn(
    input: {
      commandId: string;
      clientId: string;
      text: string;
      attachments?: UserInputRow["attachments"] | undefined;
      conversationQuotes?: UserInputRow["conversationQuotes"] | undefined;
      modelSelection?: ModelSelection | undefined;
      inputOrigin?: "desktop" | "mobile" | undefined;
    },
    options?: { readonly nonBlocking?: boolean | undefined },
  ): Promise<CommandAck> {
    this.publishedToIndex = true;
    this.applyRequestedModelSelection(input.modelSelection);

    this.broadcastCommit(
      this.projector.beginUserTurn({
        commandId: input.commandId,
        clientId: input.clientId,
        text: input.text,
        attachments: input.attachments,
        conversationQuotes: input.conversationQuotes,
        nowMs: Date.now(),
        modelSelection: input.modelSelection,
        inputOrigin: input.inputOrigin,
      }),
    );

    const makeStartAck = () =>
      createCommandAck({
        commandId: input.commandId,
        status: "accepted",
        revisionAtDecision: this.projector.getRevision(),
        result: { type: "inputAccepted", delivery: "startNow", inputId: input.commandId },
      });
    const isTurnInterrupted = () => {
      const snap = this.projector.getSnapshot();
      return (
        this.disposed ||
        snap.control.stopState === "stopping" ||
        !isSessionRunningPhase(snap.control.phase)
      );
    };

    const dispatchToPi = async (): Promise<CommandAck> => {
      try {
        const initialClient = await this.ensureClient();
        if (isTurnInterrupted()) return makeStartAck();
        const activeClient = await this.syncModelConfigToClient(initialClient);
        if (isTurnInterrupted()) return makeStartAck();
        const resolved = await this.attachments.resolvePromptPayload(input.text, input.attachments);
        if (isTurnInterrupted()) return makeStartAck();
        this.projector.replacePendingUserEcho(input.text, resolved.message);
        const seqBefore = this.projector.getAgentLifecycleSeq();
        const ack = await activeClient.prompt(resolved.message, { images: resolved.images });
        this.broadcastCommit(
          ack?.disposition === "handled"
            ? this.projector.completeHandledPrompt(Date.now())
            : this.projector.applyOptimisticRunningIfUnchanged(seqBefore, Date.now()),
        );
        return makeStartAck();
      } catch (error) {
        const redacted = formatRedactedPiError(error);
        logger.warn(undefined, `Pi prompt 执行失败 session=${this.sessionId}: ${redacted}`);
        if (!this.disposed) {
          this.broadcastCommit(this.projector.failActiveTurn(redacted, Date.now(), "runtime"));
        }
        return createCommandAck({
          commandId: input.commandId,
          status: "failed",
          revisionAtDecision: this.projector.getRevision(),
          reasonCode: "fault.pi.promptFailed",
          message: redacted,
        });
      }
    };

    if (options?.nonBlocking) {
      const pending = dispatchToPi()
        .then(() => undefined)
        .finally(() => {
          if (this.inFlightPromptDispatch === pending) this.inFlightPromptDispatch = null;
        });
      this.inFlightPromptDispatch = pending;
      return makeStartAck();
    }

    return dispatchToPi();
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
      const executionMode = normalizePiExecutionMode(config.mode);
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
        mode: executionMode,
        isBuiltinAskQuestionEnabled: this.isBuiltinAskQuestionEnabled,
        isDisposed: () => this.disposed,
      });
      this.activeClientMode = executionMode;
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
      if (hydrated.model) {
        this.activeClientModel = hydrated.model;
        this.projector.setModelCost(resolveModelCostFromCatalog(this.catalog, hydrated.model));
      }
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
    this.projector.setModelCost(
      resolveModelCostFromCatalog(this.catalog, undefined, resolved.provider, resolved.model),
    );
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
    this.projector.setModelCost(
      resolveModelCostFromCatalog(this.catalog, outcome.model, target.provider, target.model),
    );
    return {
      client: outcome.client,
      thought: outcome.thinkingLevel,
      thoughtLevels: outcome.thoughtLevels,
      contextWindow: outcome.contextWindow,
    };
  }

  private async syncModelConfigToClient(client: PiRpcClient): Promise<PiRpcClient> {
    const { provider, model, thought, thoughtLevels } = this.projector.getSnapshot().config;
    if (!provider || !model) return client;
    try {
      const synced = await this.applyLiveModelSwitch(
        { provider, model, thought, thoughtLevels },
        true,
      );
      return synced.client;
    } catch (error: unknown) {
      if (client.alive)
        logger.warn(undefined, `Pi 回合前同步模型失败: ${formatRedactedPiError(error)}`);
      return this.client?.alive ? this.client : client;
    }
  }

  private handlePiEvent(event: PiRpcEvent): void {
    if (this.disposed) return;
    if (event.type === "thinking_level_changed" && event.level.trim()) {
      this.activeClientThinking = event.level.trim();
    }
    if (event.type === "extension_ui_request")
      applyPiExtensionUiEvent(this.sessionId, event, Date.now());
    this.broadcastCommit(this.projector.applyPiEvent(event, Date.now()));
    const dirtySubagents = this.projector.drainDirtyVirtualSubagentSessions();
    if (dirtySubagents.length > 0)
      this.callbacks.onVirtualSubagentSessionsUpdated?.(dirtySubagents);
  }

  private handlePiExit(exitedClient: PiRpcClient, info: PiRpcExitInfo): void {
    if (this.client === exitedClient) {
      this.detachClientListeners();
      this.client = null;
    }
    if (this.disposed) return;
    this.broadcastCommit(this.projector.drainPendingExtensionUiInteractions().commit);
    if (isSessionRunningPhase(this.projector.getSnapshot().control.phase)) {
      const suffix = info.stderr ? `: ${info.stderr}` : "";
      const msg = `Pi process exited unexpectedly (code=${String(info.code)}, signal=${String(info.signal)})${suffix}`;
      this.broadcastCommit(this.projector.failActiveTurn(msg, Date.now(), "runtime"));
    }
  }

  private async closeClientAndWait(): Promise<void> {
    if (this.spawnPromise) await this.spawnPromise.catch(() => {});
    const client = this.client;
    this.detachClientListeners();
    this.client = null;
    clearPiSessionExtensionUiState(this.sessionId);
    if (client) await client.closeAndWait(3_000).catch(() => {});
  }

  private emitSnapshotToSubscription(
    sub: TopicSubscriptionState,
    deliveryKind: "initial" | "recovery",
  ): void {
    this.deltaCoalescer.flushNow();
    emitConversationSnapshotFrames(sub, this.projector.getSnapshot(), deliveryKind, (wire) =>
      this.callbacks.emitConversationFrame(wire),
    );
  }

  private broadcastCommit(commit: ProjectionCommit | null): void {
    if (!commit || commit.deltas.length === 0 || this.disposed) return;
    this.deltaCoalescer.enqueue(commit);
  }

  private emitCommittedBatch(commit: ProjectionCommit): void {
    if (this.disposed) return;
    this.lastActivityAt = Date.now();
    emitConversationDeltaFrames(this.subscriptions.values(), commit, this.lastActivityAt, (wire) =>
      this.callbacks.emitConversationFrame(wire),
    );
    if (this.publishedToIndex && shouldNotifySessionIndexForCommit(commit)) {
      this.callbacks.onSessionPublishedOrUpdated(this.getSummary());
    }
  }
}
