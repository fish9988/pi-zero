/**
 * Pi 会话 V4 命令路由（sendText 忙闲/队列分流 + 队列与配置类命令执行器）。
 */
import { randomUUID } from "node:crypto";
import type { ModelSelection } from "@zcode/shared";
import type {
  CommandAck,
  CommandEnvelope,
  CommandPayloadMap,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  PiEventProjector,
  ProjectionCommit,
} from "#src/pi-runtime/domain/piEventProjector.js";
import {
  editQueueItemById,
  lockQueueItemForEdit,
  releaseQueueItemLock,
  removeQueueItemById,
  reorderQueueItems,
  setQueueAutoDrainState,
} from "#src/pi-runtime/domain/piQueueProjector.js";
import {
  createCommandAck,
  isSessionRunningPhase,
  isSessionTerminalPhase,
} from "#src/pi-runtime/domain/piSnapshotFactory.js";
import type { ResolvedPiPromptPayload } from "#src/pi-runtime/adapters/piAttachmentStore.js";
import { formatRedactedPiError } from "#src/pi-runtime/adapters/piDiscover.js";
import type { PiModelCatalog } from "#src/pi-runtime/adapters/piModelCatalog.js";
import {
  resolvePiModelTarget,
  type ResolvedModelTarget,
} from "#src/pi-runtime/adapters/piModelSync.js";
import type { PiRpcClient } from "#src/pi-runtime/adapters/piRpcClient.js";

const logger = createServiceLogger("pi-session-commands");

export interface PiSessionCommandHost {
  readonly sessionId: string;
  readonly projector: PiEventProjector;
  readonly catalog: PiModelCatalog;
  getLiveClient(): PiRpcClient | null;
  ensureClient(): Promise<PiRpcClient>;
  resolvePromptPayload(
    text: string,
    attachments?: UserInputRow["attachments"] | undefined,
  ): Promise<ResolvedPiPromptPayload>;
  broadcastCommit(commit: ProjectionCommit | null): void;
  applyLiveModelSwitch(target: ResolvedModelTarget): Promise<{
    readonly thought: string;
    readonly thoughtLevels: readonly string[];
    readonly contextWindow?: number | undefined;
  }>;
  applyModeSwitch(mode: string): Promise<void>;
  startFreshTurn(
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
  ): Promise<CommandAck>;
  waitForInFlightPromptDispatch(): Promise<void>;
  handleEditUserQuery(
    commandId: string,
    clientId: string,
    payload: CommandPayloadMap["editUserQuery"],
    inputOrigin?: "desktop" | "mobile" | undefined,
  ): Promise<CommandAck>;
  handleDeleteSession(commandId: string): Promise<CommandAck>;
}

async function syncPiFollowUpQueue(host: PiSessionCommandHost): Promise<void> {
  const client = host.getLiveClient();
  if (!client) return;
  const snapshot = host.projector.getSnapshot();
  await client.clearQueue().catch(() => {});
  // 仅当会话处于运行中且开启自动续跑时同步 follow_up；空闲或暂停态调用 follow_up 会意外拉起新回合。
  if (!isSessionRunningPhase(snapshot.control.phase) || !snapshot.queue.autoDrain) {
    return;
  }
  for (const item of snapshot.queue.items) {
    const resolved = await host.resolvePromptPayload(item.text, item.attachments);
    await client.followUp(resolved.message, { images: resolved.images }).catch(() => {});
  }
}

async function drainNextQueuedItemIfReady(host: PiSessionCommandHost): Promise<void> {
  while (true) {
    const snapshot = host.projector.getSnapshot();
    if (!snapshot.queue.autoDrain || isSessionRunningPhase(snapshot.control.phase)) {
      if (isSessionRunningPhase(snapshot.control.phase) && snapshot.queue.autoDrain) {
        await syncPiFollowUpQueue(host);
      }
      return;
    }
    const head = snapshot.queue.items[0];
    if (!head || head.editLock) return;
    const removed = removeQueueItemById(snapshot.queue, head.queueItemId);
    if (!removed.ok) return;
    host.broadcastCommit(host.projector.applyQueueState(removed.queue));
    const ack = await host.startFreshTurn({
      commandId: head.sourceCommandId,
      clientId: head.clientId,
      text: head.text,
      attachments: head.attachments.length > 0 ? head.attachments : undefined,
      modelSelection: head.modelSelection,
      inputOrigin: head.inputOrigin,
    });
    if (ack.status !== "accepted") return;
    // 若该回合进入运行中，将剩余队列项同步给 Pi 以便回合结束自动续跑；若已同步合帧收口则继续循环下一项。
    const after = host.projector.getSnapshot();
    if (isSessionRunningPhase(after.control.phase)) {
      await syncPiFollowUpQueue(host);
      return;
    }
  }
}

export async function dispatchPiSendText(
  host: PiSessionCommandHost,
  envelope: CommandEnvelope,
  payload: CommandPayloadMap["sendText"],
): Promise<CommandAck> {
  const { projector } = host;
  const snapshot = projector.getSnapshot();
  const phase = snapshot.control.phase;
  const queue = snapshot.queue;
  const isHeld = isSessionTerminalPhase(phase) && queue.items.length > 0 && !queue.autoDrain;

  if (isHeld) {
    if (!payload.heldQueueDisposition) {
      return createCommandAck({
        commandId: envelope.commandId,
        status: "rejected",
        revisionAtDecision: projector.getRevision(),
        reasonCode: "guard.queue.heldDispositionRequired",
      });
    }
    if (payload.expectedHeldQueueItemIds) {
      const actualIds = queue.items.map((item) => item.queueItemId);
      const matches =
        actualIds.length === payload.expectedHeldQueueItemIds.length &&
        actualIds.every((id, index) => id === payload.expectedHeldQueueItemIds?.[index]);
      if (!matches) {
        return createCommandAck({
          commandId: envelope.commandId,
          status: "stale",
          revisionAtDecision: projector.getRevision(),
          reasonCode: "proto.heldQueueChanged",
        });
      }
    }
    if (payload.heldQueueDisposition === "clearQueueAndSend") {
      host.broadcastCommit(projector.clearQueue(true));
      const liveClient = host.getLiveClient();
      if (liveClient) await liveClient.clearQueue().catch(() => {});
    }
    return host.startFreshTurn(
      {
        commandId: envelope.commandId,
        clientId: envelope.clientId,
        text: payload.text,
        attachments: payload.attachments,
        conversationQuotes: payload.conversationQuotes,
        modelSelection: payload.modelSelection,
        inputOrigin: envelope.inputOrigin ?? payload.inputOrigin,
      },
      { nonBlocking: true },
    );
  }

  if (isSessionRunningPhase(phase)) {
    const delivery =
      payload.requestedDelivery ?? (snapshot.config.followupMode === "guide" ? "guide" : "queue");

    if (delivery === "startNow") {
      const liveClient = host.getLiveClient();
      if (liveClient) {
        await liveClient.clearQueue().catch(() => {});
        await liveClient.abort().catch(() => {});
      }
      return host.startFreshTurn(
        {
          commandId: envelope.commandId,
          clientId: envelope.clientId,
          text: payload.text,
          attachments: payload.attachments,
          conversationQuotes: payload.conversationQuotes,
          modelSelection: payload.modelSelection,
          inputOrigin: envelope.inputOrigin ?? payload.inputOrigin,
        },
        { nonBlocking: true },
      );
    }

    if (delivery === "guide") {
      try {
        await host.waitForInFlightPromptDispatch();
        const client = await host.ensureClient();
        const resolved = await host.resolvePromptPayload(payload.text, payload.attachments);
        await client.steer(resolved.message, { images: resolved.images });
        host.broadcastCommit(
          projector.recordGuidedInput({
            commandId: envelope.commandId,
            clientId: envelope.clientId,
            text: payload.text,
            attachments: payload.attachments,
            echoText: resolved.message,
            nowMs: Date.now(),
            modelSelection: payload.modelSelection,
            inputOrigin: envelope.inputOrigin ?? payload.inputOrigin,
          }),
        );
        return createCommandAck({
          commandId: envelope.commandId,
          status: "accepted",
          revisionAtDecision: projector.getRevision(),
          result: { type: "inputAccepted", delivery: "guide", inputId: envelope.commandId },
        });
      } catch (error) {
        const redacted = formatRedactedPiError(error);
        logger.warn(undefined, `Pi steer 发送失败 session=${host.sessionId}: ${redacted}`);
        return createCommandAck({
          commandId: envelope.commandId,
          status: "failed",
          revisionAtDecision: projector.getRevision(),
          reasonCode: "fault.pi.steerFailed",
          message: redacted,
        });
      }
    }

    const queueItemId = `q_${randomUUID()}`;
    let enqueued = false;
    try {
      await host.waitForInFlightPromptDispatch();
      const client = await host.ensureClient();
      const resolved = await host.resolvePromptPayload(payload.text, payload.attachments);
      host.broadcastCommit(
        projector.enqueueQueueMessage({
          sourceCommandId: envelope.commandId,
          queueItemId,
          clientId: envelope.clientId,
          text: payload.text,
          attachments: payload.attachments,
          nowMs: Date.now(),
          requestedDelivery: payload.requestedDelivery ?? "auto",
          modelSelection: payload.modelSelection,
          inputOrigin: envelope.inputOrigin ?? payload.inputOrigin,
        }),
      );
      enqueued = true;
      await client.followUp(resolved.message, { images: resolved.images });
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
        result: { type: "inputAccepted", delivery: "queue", inputId: envelope.commandId },
      });
    } catch (error) {
      if (enqueued) {
        const rollback = removeQueueItemById(projector.getSnapshot().queue, queueItemId);
        if (rollback.ok) host.broadcastCommit(projector.applyQueueState(rollback.queue));
      }
      const redacted = formatRedactedPiError(error);
      logger.warn(undefined, `Pi follow_up 排队失败 session=${host.sessionId}: ${redacted}`);
      return createCommandAck({
        commandId: envelope.commandId,
        status: "failed",
        revisionAtDecision: projector.getRevision(),
        reasonCode: "fault.pi.followUpFailed",
        message: redacted,
      });
    }
  }

  if (payload.planEnabled === true) {
    await host.applyModeSwitch("plan");
  } else if (payload.mode) {
    await host.applyModeSwitch(payload.mode);
  }

  // 首页预热草稿与已有会话发起新回合均走 sendText：先同步落盘用户气泡并立刻返回 accepted ACK，
  // 后台异步拉起 Pi 并投递 prompt，消除“侧栏已转圈但主页面停在首页空态 1-2s”的割裂感。
  return host.startFreshTurn(
    {
      commandId: envelope.commandId,
      clientId: envelope.clientId,
      text: payload.text,
      attachments: payload.attachments,
      conversationQuotes: payload.conversationQuotes,
      modelSelection: payload.modelSelection,
      inputOrigin: envelope.inputOrigin ?? payload.inputOrigin,
    },
    { nonBlocking: true },
  );
}

export async function dispatchPiAuxCommand(
  host: PiSessionCommandHost,
  envelope: CommandEnvelope,
): Promise<CommandAck> {
  const { projector } = host;

  switch (envelope.type) {
    case "setFollowupMode": {
      const mode = (envelope.payload as CommandPayloadMap["setFollowupMode"]).mode;
      const prev = projector.getSnapshot().config;
      if (prev.followupMode !== mode) {
        host.broadcastCommit(projector.applyConfigUpdate({ ...prev, followupMode: mode }));
      }
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
      });
    }

    case "switchModelConfig": {
      const payload = envelope.payload as CommandPayloadMap["switchModelConfig"];
      const prev = projector.getSnapshot().config;
      const target = await resolvePiModelTarget({
        catalog: host.catalog,
        provider: payload.provider,
        model: payload.model,
        requestedThought: payload.thought,
        fallbackThoughtLevels: prev.thoughtLevels,
        fallbackThought: prev.thought,
      });

      let finalThought = target.thought;
      let finalThoughtLevels = target.thoughtLevels;
      let finalContextWindow = target.contextWindow;

      if (host.getLiveClient()) {
        try {
          const synced = await host.applyLiveModelSwitch(target);
          finalThought = synced.thought;
          finalThoughtLevels = synced.thoughtLevels;
          finalContextWindow = synced.contextWindow ?? finalContextWindow;
        } catch (error) {
          const redacted = formatRedactedPiError(error);
          logger.warn(undefined, `Pi 切换模型同步失败 session=${host.sessionId}: ${redacted}`);
          return createCommandAck({
            commandId: envelope.commandId,
            status: "failed",
            revisionAtDecision: projector.getRevision(),
            reasonCode: "fault.pi.modelSwitchFailed",
            message: redacted,
          });
        }
      }

      projector.setContextWindowMax(finalContextWindow);
      host.broadcastCommit(
        projector.applyModelSwitch({
          provider: target.provider,
          model: target.model,
          thought: finalThought,
          thoughtLevels: finalThoughtLevels,
          nowMs: Date.now(),
          sourceCommandId: envelope.commandId,
        }),
      );
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
      });
    }

    case "switchCollaborationMode": {
      const mode = (envelope.payload as CommandPayloadMap["switchCollaborationMode"]).mode;
      await host.applyModeSwitch(mode);
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
      });
    }

    case "editUserQuery": {
      const payload = envelope.payload as CommandPayloadMap["editUserQuery"];
      return host.handleEditUserQuery(
        envelope.commandId,
        envelope.clientId,
        payload,
        envelope.inputOrigin,
      );
    }

    case "deleteQueueItem": {
      const { queueItemId } = envelope.payload as CommandPayloadMap["deleteQueueItem"];
      const outcome = removeQueueItemById(projector.getSnapshot().queue, queueItemId);
      if (!outcome.ok) {
        return createCommandAck({
          commandId: envelope.commandId,
          status: outcome.status,
          revisionAtDecision: projector.getRevision(),
          reasonCode: outcome.reasonCode,
          message: outcome.message,
        });
      }
      host.broadcastCommit(projector.applyQueueState(outcome.queue));
      await syncPiFollowUpQueue(host);
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
      });
    }

    case "editQueueItem": {
      const payload = envelope.payload as CommandPayloadMap["editQueueItem"];
      const outcome = editQueueItemById(projector.getSnapshot().queue, payload);
      if (!outcome.ok) {
        return createCommandAck({
          commandId: envelope.commandId,
          status: outcome.status,
          revisionAtDecision: projector.getRevision(),
          reasonCode: outcome.reasonCode,
          message: outcome.message,
        });
      }
      host.broadcastCommit(projector.applyQueueState(outcome.queue));
      await syncPiFollowUpQueue(host);
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
      });
    }

    case "reorderQueueItem": {
      const payload = envelope.payload as CommandPayloadMap["reorderQueueItem"];
      const outcome = reorderQueueItems(
        projector.getSnapshot().queue,
        payload.queueItemId,
        payload.beforeQueueItemId,
      );
      if (!outcome.ok) {
        return createCommandAck({
          commandId: envelope.commandId,
          status: outcome.status,
          revisionAtDecision: projector.getRevision(),
          reasonCode: outcome.reasonCode,
          message: outcome.message,
        });
      }
      host.broadcastCommit(projector.applyQueueState(outcome.queue));
      await syncPiFollowUpQueue(host);
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
      });
    }

    case "lockQueueItemEdit": {
      const payload = envelope.payload as CommandPayloadMap["lockQueueItemEdit"];
      const outcome = lockQueueItemForEdit(projector.getSnapshot().queue, {
        queueItemId: payload.queueItemId,
        editorId: payload.editorId,
        clientId: envelope.clientId,
        inputOrigin: envelope.inputOrigin,
      });
      if (!outcome.ok) {
        return createCommandAck({
          commandId: envelope.commandId,
          status: outcome.status,
          revisionAtDecision: projector.getRevision(),
          reasonCode: outcome.reasonCode,
          message: outcome.message,
        });
      }
      host.broadcastCommit(projector.applyQueueState(outcome.queue));
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
      });
    }

    case "releaseQueueItemEdit": {
      const { queueItemId } = envelope.payload as CommandPayloadMap["releaseQueueItemEdit"];
      const outcome = releaseQueueItemLock(projector.getSnapshot().queue, queueItemId);
      if (!outcome.ok) {
        return createCommandAck({
          commandId: envelope.commandId,
          status: outcome.status,
          revisionAtDecision: projector.getRevision(),
          reasonCode: outcome.reasonCode,
        });
      }
      if (outcome.changed) host.broadcastCommit(projector.applyQueueState(outcome.queue));
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
      });
    }

    case "setAutoDrain": {
      const { autoDrain } = envelope.payload as CommandPayloadMap["setAutoDrain"];
      const nextQueue = setQueueAutoDrainState(projector.getSnapshot().queue, autoDrain);
      host.broadcastCommit(projector.applyQueueState(nextQueue));
      if (autoDrain && !isSessionRunningPhase(projector.getSnapshot().control.phase)) {
        await drainNextQueuedItemIfReady(host);
      } else {
        await syncPiFollowUpQueue(host);
      }
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
      });
    }

    case "sendQueuedNow": {
      const payload = envelope.payload as CommandPayloadMap["sendQueuedNow"];
      const currentQueue = projector.getSnapshot().queue;
      const item = currentQueue.items.find((entry) => entry.queueItemId === payload.queueItemId);
      if (!item) {
        return createCommandAck({
          commandId: envelope.commandId,
          status: "noop",
          revisionAtDecision: projector.getRevision(),
          reasonCode: "proto.queueItemNotFound",
        });
      }
      const removed = removeQueueItemById(currentQueue, item.queueItemId);
      if (!removed.ok) {
        return createCommandAck({
          commandId: envelope.commandId,
          status: removed.status,
          revisionAtDecision: projector.getRevision(),
          reasonCode: removed.reasonCode,
          message: removed.message,
        });
      }
      host.broadcastCommit(projector.applyQueueState(removed.queue));
      const ack = await host.startFreshTurn({
        commandId: envelope.commandId,
        clientId: envelope.clientId,
        text: item.text,
        attachments: item.attachments.length > 0 ? item.attachments : undefined,
        modelSelection: payload.modelSelection ?? item.modelSelection,
        inputOrigin: envelope.inputOrigin ?? item.inputOrigin,
      });
      if (ack.status === "accepted") {
        await syncPiFollowUpQueue(host);
      }
      return ack;
    }

    case "resolveInteraction": {
      const { interactionId, answer } = envelope.payload as CommandPayloadMap["resolveInteraction"];
      const resolved = projector.resolveExtensionUiInteraction(interactionId, answer);
      if (!resolved) {
        return createCommandAck({
          commandId: envelope.commandId,
          status: "noop",
          revisionAtDecision: projector.getRevision(),
          reasonCode: "proto.alreadyResolved",
        });
      }
      host.broadcastCommit(resolved.commit);
      const liveClient = host.getLiveClient();
      if (liveClient) {
        liveClient.sendExtensionUiResponse(resolved.response);
      }
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
      });
    }

    case "stop": {
      host.broadcastCommit(projector.markStopping());
      const drained = projector.drainPendingExtensionUiInteractions();
      host.broadcastCommit(drained.commit);
      const liveClient = host.getLiveClient();
      if (liveClient) {
        for (const id of drained.cancelledIds) {
          liveClient.sendExtensionUiResponse({ id, cancelled: true });
        }
        await liveClient.clearQueue().catch(() => {});
        await liveClient.abort().catch(() => {});
      } else {
        host.broadcastCommit(projector.settleAfterStopWithoutProcess(Date.now()));
      }
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
      });
    }

    case "renameSession": {
      const { title } = envelope.payload as CommandPayloadMap["renameSession"];
      host.broadcastCommit(projector.applyRename(title));
      const liveClient = host.getLiveClient();
      if (liveClient) await liveClient.setSessionName(title.trim()).catch(() => {});
      return createCommandAck({
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: projector.getRevision(),
      });
    }

    case "deleteSession":
      return host.handleDeleteSession(envelope.commandId);

    case "compact":
      try {
        const client = await host.ensureClient();
        await client.compact();
        return createCommandAck({
          commandId: envelope.commandId,
          status: "accepted",
          revisionAtDecision: projector.getRevision(),
        });
      } catch (error) {
        return createCommandAck({
          commandId: envelope.commandId,
          status: "failed",
          revisionAtDecision: projector.getRevision(),
          reasonCode: "fault.pi.compactFailed",
          message: formatRedactedPiError(error),
        });
      }

    default:
      return createCommandAck({
        commandId: envelope.commandId,
        status: "rejected",
        revisionAtDecision: projector.getRevision(),
        reasonCode: "guard.pi.commandUnsupported",
        message: `Pi runtime does not support command "${envelope.type}"`,
      });
  }
}
