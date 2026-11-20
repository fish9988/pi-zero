/**
 * Pi Route A 适配器：实现 ZCode 的 IZCodeAgentService（Protocol v4）。
 *
 * - 被外部 `createZCodeAgentConnectionScope` 包装后即可直接接入 ZCode 桌面渲染层；
 * - 零改造保留 ZCode 原生聊天渲染、ToolCallBlocks、主题自定义与 Side Pane；
 * - 所有 draft 会话零子进程启动；`disposeAllAndWait()` 保证进程表零孤儿回收。
 */
import { randomUUID } from "node:crypto";
import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import type { SessionLifecycleSnapshot, ZCodeSessionInfo } from "@zcode/shared";
import {
  V4_WIRE_PROTOCOL_VERSION,
  parseCommandEnvelope,
  type CommandAck,
  type CommandKey,
  type CommandPayloadMap,
  type CommandsQueryResult,
  type ConversationTopicWireCandidate,
  type HelloMessage,
  type SessionsIndexTopicWireCandidate,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeAgentCreateSessionParams,
  ZCodeAgentRuntimeExitedEvent,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentWorkspaceTarget,
} from "#src/zcode-agent/zcodeAgent.js";
import type { PiAgentService, PiAgentServiceOptions } from "#src/pi-runtime/contract.js";
import { createCommandAck } from "#src/pi-runtime/domain/piSnapshotFactory.js";
import { PiModelCatalog } from "#src/pi-runtime/adapters/piModelCatalog.js";
import { probeDynamicPiCommands } from "#src/pi-runtime/adapters/piModelSync.js";
import { buildDiskSummaryLegacySessionInfo } from "#src/pi-runtime/adapters/piSessionHydration.js";
import { createPiUnsupportedAgentMethods } from "#src/pi-runtime/adapters/piUnsupportedMethods.js";
import { PiWorkspaceHub, commandCacheKey } from "#src/pi-runtime/adapters/piWorkspaceHub.js";

export type CreatePiAgentServiceOptions = PiAgentServiceOptions & {
  readonly catalog?: PiModelCatalog | undefined;
};

export function createPiAgentService(options: CreatePiAgentServiceOptions = {}): PiAgentService {
  const ownsCatalog = options.catalog === undefined;
  const catalog =
    options.catalog ??
    new PiModelCatalog({
      env: options.env,
      platform: options.platform,
      managedRuntimeDir: options.managedRuntimeDir,
    });
  const instanceId = `pi-agent-${randomUUID()}`;
  const runtimeRestartEmitter = new Emitter<{ workspaceKey: string }>();
  const runtimeLifecycleEmitter = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  const runtimeExitedEmitter = new Emitter<ZCodeAgentRuntimeExitedEvent>();
  let disposed = false;
  let emittersDisposed = false;

  const hub = new PiWorkspaceHub({
    catalog,
    env: options.env,
    platform: options.platform,
    managedRuntimeDir: options.managedRuntimeDir,
    isBuiltinAskQuestionEnabled: options.isBuiltinAskQuestionEnabled,
    onRuntimeLifecycle: (event) => {
      if (emittersDisposed) return;
      if (disposed && event.state === "available") return;
      runtimeLifecycleEmitter.fire(event);
      if (event.state === "available" && event.runtimeIdentity.generation > 1) {
        runtimeRestartEmitter.fire({ workspaceKey: event.workspaceKey });
      }
    },
  });

  const catalogChangeSub: IDisposable = catalog.onDidChange(() => {
    if (!disposed) hub.broadcastCatalogConfigUpdate();
  });

  const disposeAllAndWait = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    catalogChangeSub.dispose();
    await hub.disposeAllAndWait();
    if (ownsCatalog) catalog.dispose();
    emittersDisposed = true;
    runtimeRestartEmitter.dispose();
    runtimeLifecycleEmitter.dispose();
    runtimeExitedEmitter.dispose();
  };

  return {
    ...createPiUnsupportedAgentMethods(),

    async initialize(target) {
      const bucket = hub.getOrCreateWorkspace(target);
      return {
        available: true,
        workspaceKey: bucket.workspaceKey,
        protocolName: "ZCode Protocol",
        protocolVersion: 1,
        transportKind: "stdio",
      };
    },

    async getWorkspaceRuntimeIdentity(target) {
      const bucket = hub.getOrCreateWorkspace(target);
      return {
        generation: bucket.generation,
        identity: bucket.identity,
        workspaceKey: bucket.workspaceKey,
      };
    },

    async createSession(params: ZCodeAgentCreateSessionParams) {
      const bucket = hub.getOrCreateWorkspace(params);
      let sessionId = params.sessionId;
      if (options.prepareSessionCreation) {
        const prepared = await options.prepareSessionCreation({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          sessionId: params.sessionId,
          projectId: params.projectId ?? null,
          additionalDirectories: params.additionalDirectories,
        });
        sessionId = prepared.sessionId;
      }
      const resolvedId = sessionId ?? `pi_${randomUUID()}`;
      const controller =
        bucket.sessions.get(resolvedId) ??
        hub.createSessionController(bucket, {
          sessionId: resolvedId,
          parentSessionId: params.parentSessionId,
          modelSelection: params.model,
          thoughtLevel: params.thoughtLevel,
        });
      return controller.getLegacySnapshot();
    },

    async resumeSession(params) {
      const bucket = hub.getOrCreateWorkspace(params);
      const controller =
        bucket.sessions.get(params.sessionId) ??
        (await hub.hydrateOrOpenSession(bucket, params.sessionId));
      return controller.getLegacySnapshot();
    },

    async listSessions(params) {
      const bucket = hub.getOrCreateWorkspace(params);
      await hub.ensureInitialDiskScan(bucket);
      const summaries = hub.getMergedPublishedSummaries(bucket);
      const result: ZCodeSessionInfo[] = [];
      for (const summary of summaries) {
        if (params.sessionIds && !params.sessionIds.includes(summary.sessionId)) continue;
        const live = bucket.sessions.get(summary.sessionId);
        result.push(
          live
            ? live.getLegacySnapshot().session
            : buildDiskSummaryLegacySessionInfo(
                summary,
                bucket.workspacePath,
                bucket.workspaceIdentity,
              ),
        );
      }
      return typeof params.limit === "number" ? result.slice(0, params.limit) : result;
    },

    async readSession(params) {
      const bucket = hub.getOrCreateWorkspace(params);
      const controller =
        bucket.sessions.get(params.sessionId) ??
        (await hub.hydrateOrOpenSession(bucket, params.sessionId));
      return controller.getLegacySnapshot();
    },

    async closeSession(params) {
      const bucket = hub.getWorkspace(params);
      const controller = bucket?.sessions.get(params.sessionId);
      if (!controller) return false;
      bucket?.sessions.delete(params.sessionId);
      await controller.disposeAndWait();
      return true;
    },

    async queryCommandResult(params: ZCodeAgentWorkspaceTarget & { key: CommandKey }) {
      const bucket = hub.getWorkspace(params);
      return (
        bucket?.commandAckCache.get(commandCacheKey(params.key.sessionId, params.key.commandId)) ??
        "unknown"
      );
    },

    async helloConversationV4(): Promise<HelloMessage> {
      return {
        kind: "hello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: `pi-conn-${randomUUID()}`,
        clientMode: "desktop-continuous",
        deliveryProfile: "continuous",
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none",
        },
        auth: {},
      };
    },

    async initializeConversationV4() {},

    async setConnectionFlowStateV4() {},

    async subscribeConversationV4(params) {
      const bucket = hub.getOrCreateWorkspace(params);
      const controller =
        bucket.sessions.get(params.sessionId) ??
        (await hub.hydrateOrOpenSession(bucket, params.sessionId));
      const ack = controller.subscribe(hub.nextSubscriptionId("pi_conv"));
      return { ack };
    },

    async resyncConversationV4(params) {
      const bucket = hub.getOrCreateWorkspace(params);
      for (const controller of bucket.sessions.values()) {
        try {
          return { ack: controller.resync(params.subscriptionId) };
        } catch {
          // 继续查找该 subscriptionId 所属会话。
        }
      }
      throw new Error("fault.subscription.notOwned");
    },

    async unsubscribeConversationV4(params) {
      const bucket = hub.getWorkspace(params);
      if (!bucket) return;
      for (const controller of bucket.sessions.values()) {
        controller.unsubscribe(params.subscriptionId);
      }
    },

    async conversationRowsRangeV4(params) {
      let controller = hub.getWorkspace(params)?.sessions.get(params.sessionId);
      if (!controller && params.residency !== "resident-only") {
        const bucket = hub.getOrCreateWorkspace(params);
        controller = (await hub.tryHydrateDiskSession(bucket, params.sessionId)) ?? undefined;
      }
      if (!controller) {
        if (params.residency === "resident-only") throw new Error("proto.sessionNotResident");
        return { rows: [], atSeq: 0, atRevision: 0, atLogEpoch: "pi-empty", hasMore: false };
      }
      return controller.getRowsRange(params.beforeRowId, params.limit);
    },

    async conversationFileChangesV4(params) {
      let controller = hub.getWorkspace(params)?.sessions.get(params.sessionId);
      if (!controller) {
        const bucket = hub.getOrCreateWorkspace(params);
        controller = (await hub.tryHydrateDiskSession(bucket, params.sessionId)) ?? undefined;
      }
      if (!controller) return { files: 0, additions: 0, deletions: 0, items: [] };
      return controller.getTurnFileChanges(params.target);
    },

    async listSessionSubagents(params) {
      const bucket = hub.getWorkspace(params);
      const controller = bucket?.sessions.get(params.sessionId);
      if (!controller) {
        return {
          revision: 0,
          childSessionIds: [],
          running: [],
          ended: { total: 0, items: [] },
        };
      }
      return controller.getSubagentDirectorySnapshot();
    },

    async sendConversationCommandV4(params) {
      const parsed = parseCommandEnvelope(params.envelope);
      if (!parsed.ok) {
        return createCommandAck({
          commandId:
            typeof params.envelope?.commandId === "string" ? params.envelope.commandId : "unknown",
          status: "rejected",
          revisionAtDecision: 0,
          reasonCode: "proto.invalidCommand",
          message: parsed.error.message,
        });
      }
      const envelope = parsed.envelope;
      const bucket = hub.getOrCreateWorkspace(params);
      const cached = bucket.commandAckCache.get(
        commandCacheKey(envelope.sessionId, envelope.commandId),
      );
      if (cached) return { ...cached, status: "duplicate" };

      if (envelope.type === "createSession") {
        const payload = envelope.payload as CommandPayloadMap["createSession"];
        let sessionId = payload.sessionId;
        if (options.prepareSessionCreation) {
          const prepared = await options.prepareSessionCreation({
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            sessionId: payload.sessionId,
            projectId: params.projectId ?? null,
            creationCommand: { clientId: envelope.clientId, commandId: envelope.commandId },
            additionalDirectories: payload.additionalDirectories,
          });
          sessionId = prepared.sessionId;
        }
        const resolvedId = sessionId ?? `pi_${randomUUID()}`;
        const requestedMode =
          payload.firstInput?.planEnabled === true
            ? "plan"
            : (payload.firstInput?.mode ?? payload.config?.mode);
        const controller =
          bucket.sessions.get(resolvedId) ??
          hub.createSessionController(bucket, {
            sessionId: resolvedId,
            cwd: payload.cwd,
            modelSelection: payload.firstInput?.modelSelection ?? payload.config?.modelSelection,
            thoughtLevel: payload.config?.thought,
            mode: requestedMode,
          });

        let ack: CommandAck;
        if (payload.firstInput) {
          const firstAck = await controller.runFirstInput({
            commandId: envelope.commandId,
            clientId: envelope.clientId,
            text: payload.firstInput.text,
            attachments: payload.firstInput.attachments,
            modelSelection: payload.firstInput.modelSelection ?? payload.config?.modelSelection,
            mode: requestedMode,
            inputOrigin: envelope.inputOrigin,
          });
          ack =
            firstAck.status === "accepted"
              ? createCommandAck({
                  commandId: envelope.commandId,
                  status: "accepted",
                  revisionAtDecision: controller.getRevision(),
                  result: {
                    type: "createSession",
                    sessionId: resolvedId,
                    input: { delivery: "startNow", inputId: envelope.commandId },
                  },
                })
              : firstAck;
        } else {
          ack = createCommandAck({
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: controller.getRevision(),
            result: { type: "createSession", sessionId: resolvedId },
          });
        }
        hub.rememberCommandAck(bucket, null, envelope.commandId, ack);
        return ack;
      }

      const sessionId = envelope.sessionId;
      const controller = sessionId
        ? (bucket.sessions.get(sessionId) ?? (await hub.tryHydrateDiskSession(bucket, sessionId)))
        : undefined;
      if (!controller) {
        return createCommandAck({
          commandId: envelope.commandId,
          status: "rejected",
          revisionAtDecision: 0,
          reasonCode: "proto.sessionNotFound",
        });
      }
      const ack = await controller.executeCommand(envelope);
      if (ack.status === "accepted" || ack.status === "noop") {
        hub.rememberCommandAck(bucket, sessionId, envelope.commandId, ack);
      }
      return ack;
    },

    async queryConversationCommandsV4(params): Promise<CommandsQueryResult> {
      const receivedAt = Date.now();
      const bucket = hub.getWorkspace(params);
      const results = params.commands.map((key) => {
        const cached = bucket?.commandAckCache.get(commandCacheKey(key.sessionId, key.commandId));
        const controller = key.sessionId ? bucket?.sessions.get(key.sessionId) : undefined;
        const turn = controller?.findTurnForCommand(key.commandId);
        return {
          key,
          result: cached ?? ("unknown" as const),
          ...(key.sessionId !== null && turn ? { turn } : {}),
        };
      });
      return {
        results,
        ...(params.clock ? { clock: { instanceId, receivedAt, sentAt: Date.now() } } : {}),
      };
    },

    async attachmentBeginV4(params) {
      return hub.attachments.begin(params);
    },

    async attachmentChunkV4(params) {
      return hub.attachments.chunk(params);
    },

    async attachmentCommitV4(params) {
      return hub.attachments.commit(params);
    },

    async attachmentAbortV4(params) {
      await hub.attachments.abort(params);
    },

    async attachmentPreviewSourceV4(params) {
      return hub.attachments.previewSource(params);
    },

    async attachmentReadV4(params) {
      const authorizedLocalRefs = await hub.collectAuthorizedAttachmentLocalRefs(
        params,
        params.sessionId,
      );
      return hub.attachments.readForPreview(params, { authorizedLocalRefs });
    },

    async conversationAttachmentReadV4(params) {
      const authorizedLocalRefs = await hub.collectAuthorizedAttachmentLocalRefs(
        params,
        params.sessionId,
      );
      return hub.attachments.readForConversation(params, { authorizedLocalRefs });
    },

    async conversationAttachmentStatV4(params) {
      const authorizedLocalRefs = await hub.collectAuthorizedAttachmentLocalRefs(
        params,
        params.sessionId,
      );
      return hub.attachments.statForConversation(params, { authorizedLocalRefs });
    },

    async getSessionLifecycle(params) {
      return (
        hub.getWorkspace(params)?.sessions.get(params.sessionId)?.getLifecycleSnapshot() ?? null
      );
    },

    async ensureSessionReady(params) {
      const bucket = hub.getOrCreateWorkspace(params);
      const controller =
        bucket.sessions.get(params.sessionId) ??
        (await hub.tryHydrateDiskSession(bucket, params.sessionId)) ??
        hub.createSessionController(bucket, { sessionId: params.sessionId });
      await controller.ensureReady();
    },

    async stopSessionRuntime(params) {
      await hub.getWorkspace(params)?.sessions.get(params.sessionId)?.stopRuntime();
    },

    async restartSessionRuntime(params) {
      const controller = hub.getWorkspace(params)?.sessions.get(params.sessionId);
      if (!controller) return;
      await controller.stopRuntime();
      await controller.ensureReady();
    },

    onDynamicSessionLifecycle(params): Event<SessionLifecycleSnapshot> {
      return hub.getOrCreateWorkspace(params).sessionLifecycleEmitter.event;
    },

    onDynamicConversationFrame(params): Event<ConversationTopicWireCandidate> {
      return hub.getOrCreateWorkspace(params).conversationFrameEmitter.event;
    },

    async reconcileSessionsIndexV4(params) {
      return hub.reconcileSessionsIndex(params, params.sessionIds);
    },

    async subscribeSessionsIndexV4(params) {
      return {
        ack: await hub.subscribeSessionsIndex(params, {
          subscriberScope: params.subscriberScope,
        }),
      };
    },

    async resyncSessionsIndexV4(params) {
      return { ack: hub.resyncSessionsIndex(params, params.subscriptionId) };
    },

    async unsubscribeSessionsIndexV4(params) {
      hub.getWorkspace(params)?.sessionsIndexSubs.delete(params.subscriptionId);
    },

    onDynamicSessionsIndexFrame(params): Event<SessionsIndexTopicWireCandidate> {
      return hub.getOrCreateWorkspace(params).sessionsIndexFrameEmitter.event;
    },

    async subscribeWorkspaceConfigV4(params) {
      return { ack: hub.subscribeWorkspaceConfig(params) };
    },

    async resyncWorkspaceConfigV4(params) {
      return { ack: hub.resyncWorkspaceConfig(params, params.subscriptionId) };
    },

    async unsubscribeWorkspaceConfigV4(params) {
      hub.getWorkspace(params)?.workspaceConfigSubs.delete(params.subscriptionId);
    },

    onDynamicWorkspaceConfigFrame(params): Event<WorkspaceConfigTopicWireCandidate> {
      return hub.getOrCreateWorkspace(params).workspaceConfigFrameEmitter.event;
    },

    onAgentRuntimeRestarted(listener) {
      return runtimeRestartEmitter.event(listener);
    },

    onAgentRuntimeLifecycle(listener) {
      return runtimeLifecycleEmitter.event(listener);
    },

    onAgentRuntimeExited(listener) {
      return runtimeExitedEmitter.event(listener);
    },

    async disposeWorkspace(params) {
      await hub.disposeWorkspace(params);
    },

    disposeAll() {
      void disposeAllAndWait();
    },

    disposeAllAndWait,

    async getSessionFilePath(workspacePath, sessionId) {
      return hub.getSessionFilePath({ workspacePath }, sessionId);
    },

    async reloadSessionAfterRewind(workspacePath, sessionId) {
      await hub.reloadSessionAfterRewind({ workspacePath }, sessionId);
    },

    async listDynamicCommands(workspacePath) {
      return probeDynamicPiCommands({
        liveClient: hub.findLiveClientForWorkspace(workspacePath),
        cwd: workspacePath,
        env: options.env,
        platform: options.platform,
        managedRuntimeDir: options.managedRuntimeDir,
      });
    },

    async listAllPiSessions() {
      return hub.listAllPiSessions();
    },

    watchAllPiSessions(onChange) {
      return hub.watchAllPiSessions(onChange);
    },

    async removeSessionFromHub(workspacePath, sessionId) {
      return hub.removeSessionFromHub({ workspacePath }, sessionId);
    },

    async applyExternalSessionTitle(workspacePath, sessionId, title) {
      return hub.applyExternalSessionTitle({ workspacePath }, sessionId, title);
    },
  };
}
