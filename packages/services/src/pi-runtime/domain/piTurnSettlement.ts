/**
 * Pi 回合流式行关闭与回合收口（domain 层，无 IO/计时器）。
 */
import type {
  ConversationDelta,
  ConversationSnapshot,
  SessionErrorInfo,
  SessionPhase,
  TurnHeaderRow,
  TurnWorkSegment,
  WireConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import { pauseQueueWithReason } from "#src/pi-runtime/domain/piQueueProjector.js";
import {
  buildPhaseTransitionPatch,
  closeOpenWorkSegments,
} from "#src/pi-runtime/domain/piRowBuilders.js";
import { deriveAssistantPreview } from "#src/pi-runtime/domain/piSnapshotFactory.js";

export interface PiProjectorRuntimeState {
  snapshot: ConversationSnapshot;
  nextRowId: number;
  turnCounter: number;
  responseCounter: number;
  segmentCounter: number;
  admissionCounter: number;
  agentLifecycleSeq: number;
  contextWindowMax: number;
  lastAssistantPreview: string | undefined;
  activeTurnId: string | null;
  activeTurnHeaderRowId: number | null;
  activeTurnStartedAt: number;
  activeWorkSegments: TurnWorkSegment[] | undefined;
  currentResponseId: string | undefined;
  activeReasoningRowId: number | null;
  activeReasoningStartedAt: number;
  activeTextRowId: number | null;
  emittedTextInCurrentAssistantMsg: boolean;
  turnOutputTokens: number;
  turnAborted: boolean;
  turnFailedError: string | null;
  stoppingRequested: boolean;
  activeCompactionRowId: number | null;
  activeCompactionOrigin: "manual" | "auto";
  readonly pendingUserEchoes: string[];
  getRowById(rowId: number): WireConversationRow | undefined;
}

export function closeOpenReasoningRow(
  state: PiProjectorRuntimeState,
  nowMs: number,
  endState: "complete" | "interrupted",
): ConversationDelta[] {
  if (state.activeReasoningRowId === null) return [];
  const existing = state.getRowById(state.activeReasoningRowId);
  state.activeReasoningRowId = null;
  if (!existing || existing.kind !== "reasoning" || existing.state !== "streaming") return [];
  return [
    {
      op: "row.upserted",
      row: {
        ...existing,
        state: endState,
        durationMs: Math.max(1, nowMs - state.activeReasoningStartedAt),
      },
    },
  ];
}

export function closeOpenStreamingRows(
  state: PiProjectorRuntimeState,
  nowMs: number,
  endState: "complete" | "interrupted" | "failed",
): ConversationDelta[] {
  const deltas = closeOpenReasoningRow(
    state,
    nowMs,
    endState === "complete" ? "complete" : "interrupted",
  );
  if (state.activeTextRowId !== null) {
    const existing = state.getRowById(state.activeTextRowId);
    state.activeTextRowId = null;
    if (existing && existing.kind === "assistantText" && existing.state === "streaming") {
      deltas.push({ op: "row.upserted", row: { ...existing, state: endState } });
      const preview = deriveAssistantPreview(existing.text);
      if (preview) state.lastAssistantPreview = preview;
    }
  }
  return deltas;
}

export function buildTurnSettlementDeltas(
  state: PiProjectorRuntimeState,
  nowMs: number,
  aborted: boolean,
  explicitError: SessionErrorInfo | null,
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [];
  const errorInfo: SessionErrorInfo | null = aborted
    ? null
    : (explicitError ??
      (state.turnFailedError
        ? {
            code: "fault.pi.turnFailed",
            message: state.turnFailedError,
            recoverable: true,
            at: nowMs,
            source: "provider",
          }
        : null));

  const rowEndState = aborted ? "interrupted" : errorInfo ? "failed" : "complete";
  deltas.push(...closeOpenStreamingRows(state, nowMs, rowEndState));

  const turnState: TurnHeaderRow["state"] = aborted
    ? "completedInterrupted"
    : errorInfo
      ? "failed"
      : "completedSuccess";
  const finalPhase: SessionPhase = aborted
    ? "completedInterrupted"
    : errorInfo
      ? "error"
      : "completedSuccess";

  if (state.activeTurnHeaderRowId !== null) {
    const header = state.getRowById(state.activeTurnHeaderRowId);
    if (header && header.kind === "turnHeader") {
      const closedSegments = closeOpenWorkSegments(state.activeWorkSegments, nowMs);
      deltas.push({
        op: "row.upserted",
        row: {
          ...header,
          state: turnState,
          endedAt: nowMs,
          activeMs: Math.max(1, nowMs - state.activeTurnStartedAt),
          outputTokens: state.turnOutputTokens,
          ...(closedSegments ? { workSegments: closedSegments } : {}),
        },
      });
    }
  }

  let nextQueue = state.snapshot.queue;
  if (aborted) nextQueue = pauseQueueWithReason(nextQueue, "stopped");
  else if (errorInfo && nextQueue.items.length > 0) {
    nextQueue = pauseQueueWithReason(nextQueue, "error");
  }

  deltas.push({
    op: "state.updated",
    patch: buildPhaseTransitionPatch({
      phase: finalPhase,
      stopState: "idle",
      followupMode: state.snapshot.config.followupMode,
      queue: nextQueue,
      nowMs,
      lastError: errorInfo,
      apiRetry: null,
    }),
  });

  state.activeTurnHeaderRowId = null;
  state.activeWorkSegments = undefined;
  state.turnAborted = false;
  state.turnFailedError = null;
  state.stoppingRequested = false;
  state.pendingUserEchoes.length = 0;
  return deltas;
}
