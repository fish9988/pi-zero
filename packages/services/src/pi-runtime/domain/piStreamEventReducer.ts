/**
 * Pi RPC 流式事件归约函数（domain 层，纯 TypeScript，无 IO/计时器）。
 * 负责将 message_* / compaction_* / auto_retry_* / agent_* 归约为 ConversationDelta 列表。
 */
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import type { PiRpcEvent } from "#src/pi-runtime/domain/piRpcTypes.js";
import { mapPiExtensionUiRequestToInteraction } from "#src/pi-runtime/domain/piExtensionUiBridge.js";
import {
  dequeueMatchingQueueItem,
  pauseQueueWithReason,
} from "#src/pi-runtime/domain/piQueueProjector.js";
import {
  accumulateSessionUsage,
  buildAssistantTextRow,
  buildCompactionMarkerRow,
  buildPhaseTransitionPatch,
  buildReasoningRow,
  buildTurnHeaderRow,
  extractPiAssistantText,
  extractPiUserMessageText,
  resolveCompactionEndMarker,
} from "#src/pi-runtime/domain/piRowBuilders.js";
import {
  computeInputRouting,
  computeSessionAvailability,
  computeSessionControl,
  deriveAssistantPreview,
  isSessionRunningPhase,
} from "#src/pi-runtime/domain/piSnapshotFactory.js";
import {
  reduceToolCallAssistantEvent,
  reduceToolExecutionEvent,
} from "#src/pi-runtime/domain/piToolReducer.js";
import {
  buildDequeuedUserTurnDeltas,
  buildTurnSettlementDeltas,
  closeOpenReasoningRow,
  closeOpenStreamingRows,
  type PiProjectorRuntimeState,
} from "#src/pi-runtime/domain/piTurnSettlement.js";

export interface ReducePiEventResult {
  readonly deltas: ConversationDelta[];
  readonly bumpRevision: boolean;
}

function allocateRowId(state: PiProjectorRuntimeState): number {
  state.nextRowId += 1;
  return state.nextRowId;
}

function ensureActiveTurnId(
  state: PiProjectorRuntimeState,
  nowMs: number,
  deltas: ConversationDelta[],
): string {
  if (state.activeTurnId) return state.activeTurnId;
  state.turnCounter += 1;
  const turnId = `turn_${state.turnCounter}`;
  const headerRowId = allocateRowId(state);
  state.activeTurnId = turnId;
  state.activeTurnHeaderRowId = headerRowId;
  state.activeTurnStartedAt = nowMs;
  deltas.push({
    op: "row.appended",
    row: buildTurnHeaderRow({
      rowId: headerRowId,
      turnId,
      createdAt: nowMs,
      createdAtSeq: state.snapshot.seq + deltas.length + 1,
    }),
  });
  return turnId;
}

function openReasoningRow(
  state: PiProjectorRuntimeState,
  turnId: string,
  nowMs: number,
  deltas: ConversationDelta[],
): void {
  const rowId = allocateRowId(state);
  state.activeReasoningRowId = rowId;
  state.activeReasoningStartedAt = nowMs;
  deltas.push({
    op: "row.appended",
    row: buildReasoningRow({
      rowId,
      turnId,
      createdAt: nowMs,
      createdAtSeq: state.snapshot.seq + deltas.length + 1,
      assistantResponseId: state.currentResponseId,
    }),
  });
}

function openAssistantTextRow(
  state: PiProjectorRuntimeState,
  turnId: string,
  nowMs: number,
  deltas: ConversationDelta[],
): void {
  const rowId = allocateRowId(state);
  state.activeTextRowId = rowId;
  state.emittedTextInCurrentAssistantMsg = true;
  deltas.push({
    op: "row.appended",
    row: buildAssistantTextRow({
      rowId,
      turnId,
      createdAt: nowMs,
      createdAtSeq: state.snapshot.seq + deltas.length + 1,
      text: "",
      state: "streaming",
      assistantResponseId: state.currentResponseId,
      model: state.snapshot.config.model || undefined,
    }),
  });
}

function reduceMessageUpdate(
  state: PiProjectorRuntimeState,
  event: Extract<PiRpcEvent, { type: "message_update" }>,
  nowMs: number,
): ReducePiEventResult | null {
  const sub = event.assistantMessageEvent;
  const deltas: ConversationDelta[] = [];
  const turnId = ensureActiveTurnId(state, nowMs, deltas);

  switch (sub.type) {
    case "thinking_start":
      openReasoningRow(state, turnId, nowMs, deltas);
      return { deltas, bumpRevision: false };
    case "thinking_delta":
      if (state.activeReasoningRowId === null) openReasoningRow(state, turnId, nowMs, deltas);
      if (sub.delta.length > 0 && state.activeReasoningRowId !== null) {
        deltas.push({
          op: "row.delta",
          rowId: state.activeReasoningRowId,
          path: "text",
          append: sub.delta,
        });
      }
      return { deltas, bumpRevision: false };
    case "thinking_end":
      if (state.activeReasoningRowId !== null) {
        const existing = state.getRowById(state.activeReasoningRowId);
        state.activeReasoningRowId = null;
        if (existing && existing.kind === "reasoning") {
          deltas.push({
            op: "row.upserted",
            row: {
              ...existing,
              text: sub.content || existing.text,
              state: "complete",
              durationMs: Math.max(1, nowMs - state.activeReasoningStartedAt),
            },
          });
        }
      }
      return { deltas, bumpRevision: false };
    case "text_start":
      deltas.push(...closeOpenReasoningRow(state, nowMs, "complete"));
      openAssistantTextRow(state, turnId, nowMs, deltas);
      return { deltas, bumpRevision: false };
    case "text_delta":
      if (state.activeTextRowId === null) {
        deltas.push(...closeOpenReasoningRow(state, nowMs, "complete"));
        openAssistantTextRow(state, turnId, nowMs, deltas);
      }
      if (sub.delta.length > 0 && state.activeTextRowId !== null) {
        deltas.push({
          op: "row.delta",
          rowId: state.activeTextRowId,
          path: "text",
          append: sub.delta,
        });
      }
      return { deltas, bumpRevision: false };
    case "text_end":
      if (state.activeTextRowId !== null) {
        const existing = state.getRowById(state.activeTextRowId);
        state.activeTextRowId = null;
        if (existing && existing.kind === "assistantText") {
          const finalText = sub.content || existing.text;
          deltas.push({
            op: "row.upserted",
            row: { ...existing, text: finalText, state: "complete" },
          });
          const preview = deriveAssistantPreview(finalText);
          if (preview) state.lastAssistantPreview = preview;
        }
      }
      return { deltas, bumpRevision: false };
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      reduceToolCallAssistantEvent(state, sub, turnId, nowMs, deltas);
      return { deltas, bumpRevision: false };
    case "done":
      deltas.push(...closeOpenStreamingRows(state, nowMs, "complete"));
      return { deltas, bumpRevision: false };
    case "error":
      state.turnFailedError = sub.error?.errorMessage || sub.reason || "Model stream error";
      deltas.push(...closeOpenStreamingRows(state, nowMs, "failed"));
      return { deltas, bumpRevision: false };
    default:
      return null;
  }
}

function reduceMessageEnd(
  state: PiProjectorRuntimeState,
  message: Extract<PiRpcEvent, { type: "message_end" }>["message"],
  nowMs: number,
): ReducePiEventResult | null {
  if (message.role !== "assistant") return null;
  const deltas: ConversationDelta[] = [];
  const isAborted = message.stopReason === "aborted";
  const isError = message.stopReason === "error";
  if (isAborted) state.turnAborted = true;
  if (isError) state.turnFailedError = message.errorMessage || "Model request failed";

  const rowEndState = isAborted ? "interrupted" : isError ? "failed" : "complete";
  deltas.push(...closeOpenStreamingRows(state, nowMs, rowEndState));

  if (!state.emittedTextInCurrentAssistantMsg) {
    const fallbackText = extractPiAssistantText(message);
    if (fallbackText.length > 0) {
      const turnId = ensureActiveTurnId(state, nowMs, deltas);
      const rowId = allocateRowId(state);
      deltas.push({
        op: "row.appended",
        row: buildAssistantTextRow({
          rowId,
          turnId,
          createdAt: nowMs,
          createdAtSeq: state.snapshot.seq + deltas.length + 1,
          text: fallbackText,
          state: rowEndState,
          assistantResponseId: state.currentResponseId,
          model: state.snapshot.config.model || undefined,
        }),
      });
      const preview = deriveAssistantPreview(fallbackText);
      if (preview) state.lastAssistantPreview = preview;
      state.emittedTextInCurrentAssistantMsg = true;
    }
  }

  let bumpRevision = false;
  if (message.usage) {
    const { nextUsage, addedOutputTokens } = accumulateSessionUsage(
      state.snapshot.usage,
      message.usage,
      state.contextWindowMax,
    );
    state.turnOutputTokens += addedOutputTokens;
    deltas.push({ op: "state.updated", patch: { usage: nextUsage } });
    bumpRevision = true;
  }
  return { deltas, bumpRevision };
}

export function reducePiStreamEvent(
  state: PiProjectorRuntimeState,
  event: PiRpcEvent,
  nowMs: number,
): ReducePiEventResult | null {
  switch (event.type) {
    case "agent_start":
      state.agentLifecycleSeq += 1;
      if (isSessionRunningPhase(state.snapshot.control.phase)) return null;
      return {
        bumpRevision: true,
        deltas: [
          {
            op: "state.updated",
            patch: buildPhaseTransitionPatch({
              phase: "running",
              stopState: "stoppable",
              followupMode: state.snapshot.config.followupMode,
              queue: state.snapshot.queue,
              nowMs,
              activeTurnId: state.activeTurnId ?? `turn_${state.turnCounter || 1}`,
              lastError: null,
              apiRetry: null,
            }),
          },
        ],
      };
    case "message_start": {
      if (event.message.role === "assistant") {
        state.responseCounter += 1;
        state.currentResponseId = `resp_${state.responseCounter}`;
        state.emittedTextInCurrentAssistantMsg = false;
        state.toolCallIdByContentIndex.clear();
        return { deltas: closeOpenStreamingRows(state, nowMs, "complete"), bumpRevision: false };
      }
      if (event.message.role === "user") {
        const text = extractPiUserMessageText(event.message);
        if (state.pendingUserEchoes.length > 0 && state.pendingUserEchoes[0] === text) {
          state.pendingUserEchoes.shift();
          return null;
        }
        const dequeued = dequeueMatchingQueueItem(state.snapshot.queue, text);
        if (dequeued.item) {
          return {
            bumpRevision: true,
            deltas: buildDequeuedUserTurnDeltas(state, dequeued.item, dequeued.queue, nowMs),
          };
        }
      }
      return null;
    }
    case "message_update":
      return reduceMessageUpdate(state, event, nowMs);
    case "message_end":
      return reduceMessageEnd(state, event.message, nowMs);
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const deltas: ConversationDelta[] = [];
      const turnId = ensureActiveTurnId(state, nowMs, deltas);
      reduceToolExecutionEvent(state, event, turnId, nowMs, deltas);
      return { deltas, bumpRevision: false };
    }
    case "compaction_start":
    case "auto_compaction_start": {
      const origin: "manual" | "auto" = event.reason === "manual" ? "manual" : "auto";
      state.activeCompactionOrigin = origin;
      const rowId = allocateRowId(state);
      state.activeCompactionRowId = rowId;
      return {
        bumpRevision: false,
        deltas: [
          {
            op: "row.appended",
            row: buildCompactionMarkerRow({
              rowId,
              turnId: state.activeTurnId ?? `turn_${state.turnCounter || 1}`,
              createdAt: nowMs,
              createdAtSeq: state.snapshot.seq + 1,
              origin,
              status: "running",
            }),
          },
        ],
      };
    }
    case "compaction_end":
    case "auto_compaction_end": {
      const marker = resolveCompactionEndMarker(event, state.activeCompactionOrigin);
      const existing =
        state.activeCompactionRowId !== null
          ? state.getRowById(state.activeCompactionRowId)
          : undefined;
      state.activeCompactionRowId = null;
      if (existing && existing.kind === "timelineMarker") {
        return {
          bumpRevision: false,
          deltas: [{ op: "row.upserted", row: { ...existing, marker } }],
        };
      }
      const rowId = allocateRowId(state);
      return {
        bumpRevision: false,
        deltas: [
          {
            op: "row.appended",
            row: buildCompactionMarkerRow({
              rowId,
              turnId: state.activeTurnId ?? `turn_${state.turnCounter || 1}`,
              createdAt: nowMs,
              createdAtSeq: state.snapshot.seq + 1,
              origin: marker.origin,
              status: marker.status,
              tokensBefore: marker.tokensBefore,
              tokensAfter: marker.tokensAfter,
            }),
          },
        ],
      };
    }
    case "auto_retry_start":
      return {
        bumpRevision: true,
        deltas: [
          {
            op: "state.updated",
            patch: {
              control: computeSessionControl({
                phase: state.snapshot.control.phase,
                stopState: state.snapshot.control.stopState,
                stopTargetKind: state.snapshot.control.stopTargetKind,
                activeWorks: state.snapshot.control.activeWorks,
                lastError: state.snapshot.control.lastError,
                apiRetry: {
                  attempt: event.attempt,
                  maxAttempts: event.maxAttempts,
                  nextRetryAt: nowMs + Math.max(0, event.delayMs),
                  reasonCode: event.errorMessage || "api_retry",
                },
              }),
            },
          },
        ],
      };
    case "auto_retry_end":
      if (!event.success && event.finalError) state.turnFailedError = event.finalError;
      if (state.snapshot.control.apiRetry === null) return null;
      return {
        bumpRevision: true,
        deltas: [
          {
            op: "state.updated",
            patch: {
              control: computeSessionControl({
                phase: state.snapshot.control.phase,
                stopState: state.snapshot.control.stopState,
                stopTargetKind: state.snapshot.control.stopTargetKind,
                activeWorks: state.snapshot.control.activeWorks,
                lastError: state.snapshot.control.lastError,
                apiRetry: null,
              }),
            },
          },
        ],
      };
    case "session_info_changed": {
      const trimmed = event.name?.trim();
      if (!trimmed || state.snapshot.meta.titleSource === "custom") return null;
      if (state.snapshot.meta.title === trimmed) return null;
      return {
        bumpRevision: true,
        deltas: [
          { op: "state.updated", patch: { meta: { title: trimmed, titleSource: "generated" } } },
        ],
      };
    }
    case "thinking_level_changed": {
      const trimmed = event.level.trim();
      if (!trimmed || state.snapshot.config.thought === trimmed) return null;
      const prev = state.snapshot.config;
      const nextConfig = {
        ...prev,
        thought: trimmed,
        ...(prev.modelSelection
          ? { modelSelection: { ...prev.modelSelection, options: { reasoningLevel: trimmed } } }
          : {}),
      };
      return {
        bumpRevision: true,
        deltas: [
          {
            op: "state.updated",
            patch: {
              config: nextConfig,
              inputRouting: computeInputRouting(
                state.snapshot.control.phase,
                nextConfig.followupMode,
                state.snapshot.queue,
              ),
            },
          },
        ],
      };
    }
    case "extension_ui_request": {
      if (event.method === "setTitle" && typeof event.title === "string" && event.title.trim()) {
        return {
          bumpRevision: true,
          deltas: [
            {
              op: "state.updated",
              patch: { meta: { title: event.title.trim(), titleSource: "custom" } },
            },
          ],
        };
      }
      const mapped = mapPiExtensionUiRequestToInteraction(
        event,
        nowMs,
        state.activeTurnHeaderRowId,
      );
      if (!mapped) return null;
      state.pendingExtensionUiById.set(mapped.meta.id, mapped.meta);
      const nextPending = [
        ...state.snapshot.pendingInteractions.filter(
          (item) => item.interactionId !== mapped.interaction.interactionId,
        ),
        mapped.interaction,
      ];
      return {
        bumpRevision: true,
        deltas: [{ op: "state.updated", patch: { pendingInteractions: nextPending } }],
      };
    }
    case "agent_end":
      if (event.willRetry === true) return null;
      state.agentLifecycleSeq += 1;
      return {
        bumpRevision: true,
        deltas: buildTurnSettlementDeltas(
          state,
          nowMs,
          state.turnAborted || state.stoppingRequested,
          null,
        ),
      };
    case "agent_settled":
      state.agentLifecycleSeq += 1;
      if (!isSessionRunningPhase(state.snapshot.control.phase)) {
        if ((event.aborted || state.stoppingRequested) && state.snapshot.queue.autoDrain) {
          const nextQueue = pauseQueueWithReason(state.snapshot.queue, "stopped");
          const phase = state.snapshot.control.phase;
          return {
            bumpRevision: true,
            deltas: [
              {
                op: "state.updated",
                patch: {
                  queue: nextQueue,
                  availability: computeSessionAvailability(phase, nextQueue),
                  inputRouting: computeInputRouting(
                    phase,
                    state.snapshot.config.followupMode,
                    nextQueue,
                  ),
                },
              },
            ],
          };
        }
        return null;
      }
      return {
        bumpRevision: true,
        deltas: buildTurnSettlementDeltas(
          state,
          nowMs,
          event.aborted || state.turnAborted || state.stoppingRequested,
          null,
        ),
      };
    default:
      return null;
  }
}
