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
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
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
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
  type SessionSummary,
  type SubscribeAck,
  type V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { PiModelInfo, PiRpcEvent, PiRpcExitInfo } from "#src/pi-runtime/contract.js";
import {
  getSupportedThinkingLevels,
  pickDefaultThinkingLevel,
} from "#src/pi-runtime/domain/piModelCapability.js";
import {
  PiEventProjector,
  type ProjectionCommit,
} from "#src/pi-runtime/domain/piEventProjector.js";
import {
  buildLegacySessionStateSnapshot,
  buildSessionSummary,
  createCommandAck,
  createInitialSessionConfig,
  isSessionRunningPhase,
} from "#src/pi-runtime/domain/piSnapshotFactory.js";
import { discoverPi, formatRedactedPiError } from "#src/pi-runtime/adapters/piDiscover.js";
import {
  encodeV4TopicFrames,
  type TopicSubscriptionState,
} from "#src/pi-runtime/adapters/piFrameEncoder.js";
import type { PiModelCatalog } from "#src/pi-runtime/adapters/piModelCatalog.js";
import { PiRpcClient } from "#src/pi-runtime/adapters/piRpcClient.js";
import {
  dispatchPiAuxCommand,
  dispatchPiSendText,
  type PiSessionCommandHost,
} from "#src/pi-runtime/adapters/piSessionCommands.js";

const logger = createServiceLogger("pi-session-controller");

export interface PiSessionControllerCallbacks {
  emitConversationFrame(frame: ConversationTopicWireCandidate): void;
  onSessionPublishedOrUpdated(summary: SessionSummary): void;
  onSessionLifecycleChanged(snapshot: SessionLifecycleSnapshot): void;
  onSessionDeleted(sessionId: string): void;
}

export interface PiSessionControllerOptions {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string | undefined;
  readonly cwd: string;
  readonly parentSessionId?: string | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly thoughtLevel?: string | undefined;
  readonly catalog: PiModelCatalog;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly managedRuntimeDir?: string | undefined;
  readonly callbacks: PiSessionControllerCallbacks;
}

export class PiSessionController {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly workspaceIdentity: string | undefined;
  readonly cwd: string;
  readonly parentSessionId: string | undefined;
  readonly createdAt: number;

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
  private activeClientModelKey = "";
  private activeClientThinking = "";
  private disposed = false;

  constructor(options: PiSessionControllerOptions) {
    this.sessionId = options.sessionId;
    this.workspaceId = options.workspaceId;
    this.workspacePath = options.workspacePath;
    this.workspaceIdentity = options.workspaceIdentity;
    this.cwd = options.cwd;
    this.parentSessionId = options.parentSessionId;
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
    this.catalog = options.catalog;
    this.env = options.env;
    this.platform = options.platform;
    this.managedRuntimeDir = options.managedRuntimeDir;
    this.callbacks = options.callbacks;

    const catalogSnapshot = this.catalog.getSnapshot();
    const effectiveModelSelection: ModelSelection | undefined = options.modelSelection
      ? {
          ...options.modelSelection,
          ...(options.thoughtLevel ? { options: { reasoningLevel: options.thoughtLevel } } : {}),
        }
      : undefined;
    const config = createInitialSessionConfig({
      modelSelection: effectiveModelSelection,
      catalogModels: catalogSnapshot.models,
      defaultModel: catalogSnapshot.defaultModel,
      defaultThinkingLevel: options.thoughtLevel ?? catalogSnapshot.defaultThinkingLevel,
    });
    const matched = catalogSnapshot.models.find(
      (model) => model.provider === config.provider && model.id === config.model,
    );
    this.projector = new PiEventProjector({
      sessionId: this.sessionId,
      logEpoch: `pi-${randomUUID()}`,
      attemptId: `init-${randomUUID()}`,
      config,
      contextWindowMax: matched?.contextWindow,
    });
  }

  isPublishedToIndex(): boolean {
    return this.publishedToIndex;
  }

  getRevision(): number {
    return this.projector.getRevision();
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

  findTurnForCommand(commandId: string) {
    return this.projector.findTurnForCommand(commandId);
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

  unsubscribe(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);
  }

  async ensureReady(): Promise<void> {
    if (this.disposed) return;
    await this.ensureClient();
  }

  async stopRuntime(): Promise<void> {
    if (this.client?.alive) {
      await this.client.clearQueue().catch(() => {});
      await this.client.abort().catch(() => {});
    }
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

    if (envelope.type === "stop") return this.handleStop(envelope.commandId);

    const host = this.createCommandHost();
    if (envelope.type === "sendText") {
      return dispatchPiSendText(host, envelope, envelope.payload as CommandPayloadMap["sendText"]);
    }
    return dispatchPiAuxCommand(host, envelope);
  }

  async disposeAndWait(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
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
      syncModelConfigToClient: (client) => this.syncModelConfigToClient(client),
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
      const client = await this.ensureClient();
      await this.syncModelConfigToClient(client);
      const seqBefore = this.projector.getAgentLifecycleSeq();
      const ack = await client.prompt(input.text);
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

  private async handleStop(commandId: string): Promise<CommandAck> {
    this.broadcastCommit(this.projector.markStopping());
    if (this.client?.alive) {
      await this.client.clearQueue().catch(() => {});
      await this.client.abort().catch(() => {});
    } else {
      this.broadcastCommit(this.projector.settleAfterStopWithoutProcess(Date.now()));
    }
    return createCommandAck({
      commandId,
      status: "accepted",
      revisionAtDecision: this.projector.getRevision(),
    });
  }

  private async handleDeleteSession(commandId: string): Promise<CommandAck> {
    const rev = this.projector.getRevision();
    await this.disposeAndWait();
    this.callbacks.onSessionDeleted(this.sessionId);
    return createCommandAck({ commandId, status: "accepted", revisionAtDecision: rev });
  }

  private async ensureClient(): Promise<PiRpcClient> {
    if (this.client?.alive) return this.client;
    if (this.spawnPromise) return this.spawnPromise;
    if (this.disposed) throw new Error("Session disposed before starting Pi");

    // 先同步占位 spawnPromise 再 await discoverPi，防止并发调用或关闭期间 discoverPi 竞态泄漏双进程。
    const promise = (async () => {
      const launch = await discoverPi({
        env: this.env,
        platform: this.platform,
        managedRuntimeDir: this.managedRuntimeDir,
      });
      if (this.disposed) throw new Error("Session disposed while discovering Pi");
      if (!launch) throw new Error("Pi CLI (pi) not found on PATH");

      const config = this.projector.getSnapshot().config;
      const effectiveCwd = this.cwd && existsSync(this.cwd) ? this.cwd : tmpdir();
      const client = await PiRpcClient.spawn({
        launch,
        cwd: effectiveCwd,
        env: this.env,
        ...(config.provider ? { provider: config.provider } : {}),
        ...(config.model ? { model: config.model } : {}),
        ...(config.thought ? { thinkingLevel: config.thought } : {}),
      });
      if (this.disposed) {
        await client.closeAndWait(2_000).catch(() => {});
        throw new Error("Session disposed while starting Pi");
      }
      this.attachClient(client);
      await this.hydrateFromClientState(client);
      return client;
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
      const [state, modelsResult] = await Promise.all([
        client.getState(),
        client.getAvailableModels().catch(() => ({ models: [] as PiModelInfo[] })),
      ]);
      const models = Array.isArray(modelsResult.models) ? modelsResult.models : [];
      if (models.length > 0) {
        this.catalog.seedFromLiveSession({
          models,
          defaultModel: state.model ?? models[0],
          defaultThinkingLevel: state.thinkingLevel,
        });
      }
      if (state.model) {
        this.activeClientModelKey = `${state.model.provider}/${state.model.id}`;
        this.projector.setContextWindowMax(state.model.contextWindow);
      }
      this.activeClientThinking = state.thinkingLevel || "";
      const prev = this.projector.getSnapshot().config;
      if (!prev.provider && state.model) {
        const thoughtLevels = getSupportedThinkingLevels(state.model);
        const thought = pickDefaultThinkingLevel(state.model, state.thinkingLevel);
        this.broadcastCommit(
          this.projector.applyConfigUpdate({
            ...prev,
            provider: state.model.provider,
            model: state.model.id,
            thought,
            thoughtLevels,
            modelSelection: {
              providerId: state.model.provider,
              modelId: state.model.id,
              options: { reasoningLevel: thought },
            },
          }),
        );
      }
    } catch (error) {
      logger.warn(undefined, `Pi 初始状态同步失败: ${formatRedactedPiError(error)}`);
    }
  }

  private applyRequestedModelSelection(selection: ModelSelection | undefined): void {
    if (!selection) return;
    const prev = this.projector.getSnapshot().config;
    const nextThought = selection.options?.reasoningLevel ?? prev.thought;
    if (
      prev.provider === selection.providerId &&
      prev.model === selection.modelId &&
      prev.thought === nextThought
    ) {
      return;
    }
    const matched = this.catalog
      .getSnapshot()
      .models.find((m) => m.provider === selection.providerId && m.id === selection.modelId);
    this.projector.setContextWindowMax(matched?.contextWindow);
    this.broadcastCommit(
      this.projector.applyConfigUpdate({
        ...prev,
        provider: selection.providerId,
        model: selection.modelId,
        thought: nextThought,
        thoughtLevels: matched ? getSupportedThinkingLevels(matched) : prev.thoughtLevels,
        modelSelection: {
          providerId: selection.providerId,
          modelId: selection.modelId,
          ...(nextThought ? { options: { reasoningLevel: nextThought } } : {}),
        },
      }),
    );
  }

  private async syncModelConfigToClient(client: PiRpcClient): Promise<void> {
    const config = this.projector.getSnapshot().config;
    if (config.provider && config.model) {
      const targetKey = `${config.provider}/${config.model}`;
      if (targetKey !== this.activeClientModelKey) {
        const updated = await client.setModel(config.provider, config.model).catch(() => null);
        if (updated) {
          this.activeClientModelKey = targetKey;
          this.projector.setContextWindowMax(updated.contextWindow);
        }
      }
    }
    if (config.thought && config.thought !== this.activeClientThinking) {
      await client.setThinkingLevel(config.thought).catch(() => {});
      this.activeClientThinking = config.thought;
    }
  }

  private handlePiEvent(event: PiRpcEvent): void {
    if (this.disposed) return;
    this.broadcastCommit(this.projector.applyPiEvent(event, Date.now()));
  }

  private handlePiExit(exitedClient: PiRpcClient, info: PiRpcExitInfo): void {
    if (this.client === exitedClient) {
      this.detachClientListeners();
      this.client = null;
    }
    if (this.disposed) return;
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
    const snapshot = this.projector.getSnapshot();
    const logicalFrame: ConversationTopicFrame = {
      topic: sub.topic,
      subscriptionId: sub.subscriptionId,
      fromSeq: 0,
      toSeq: snapshot.seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot },
    };
    for (const wire of encodeV4TopicFrames(logicalFrame, sub, deliveryKind)) {
      this.callbacks.emitConversationFrame(wire);
    }
  }

  private broadcastCommit(commit: ProjectionCommit | null): void {
    if (!commit || commit.deltas.length === 0 || this.disposed) return;
    this.lastActivityAt = Date.now();
    for (const sub of this.subscriptions.values()) {
      const logicalFrame: ConversationTopicFrame = {
        topic: sub.topic,
        subscriptionId: sub.subscriptionId,
        fromSeq: commit.fromSeq,
        toSeq: commit.toSeq,
        sentAt: this.lastActivityAt,
        payload: { kind: "deltas", deltas: [...commit.deltas] },
      };
      for (const wire of encodeV4TopicFrames(logicalFrame, sub, "online")) {
        this.callbacks.emitConversationFrame(wire);
      }
    }
    if (this.publishedToIndex) {
      this.callbacks.onSessionPublishedOrUpdated(this.getSummary());
    }
  }
}
