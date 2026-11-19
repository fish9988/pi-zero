/**
 * Pi 回合流式行关闭、未完成工具取消、文件变更汇总与回合收口（domain 层，无 IO/计时器）。
 */
import type {
  ConversationDelta,
  ConversationSnapshot,
  QueueItem,
  QueueState,
  SessionErrorInfo,
  SessionPhase,
  TurnHeaderRow,
  TurnWorkSegment,
  V4ConversationFileChangesResult,
  WireConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { StructuredDiffHunk } from "#src/pi-runtime/domain/piEditDiffMapper.js";
import { pauseQueueWithReason } from "#src/pi-runtime/domain/piQueueProjector.js";
import {
  buildPhaseTransitionPatch,
  buildTurnHeaderRow,
  buildUserInputRow,
  closeOpenWorkSegments,
} from "#src/pi-runtime/domain/piRowBuilders.js";
import { deriveAssistantPreview } from "#src/pi-runtime/domain/piSnapshotFactory.js";

export interface PiTrackedToolCall {
  readonly rowId: number;
  readonly toolCallId: string;
  readonly rawToolName: string;
  readonly canonicalToolName: string;
  inputText: string;
  rawArgs: Record<string, unknown> | undefined;
  canonicalInput: Record<string, unknown> | undefined;
  startedAt: number | undefined;
}

export interface PiTurnFileChangeEntry {
  readonly path: string;
  additions: number;
  deletions: number;
  writeCount: number;
  readonly toolNames: string[];
  readonly patches: StructuredDiffHunk[];
}

export interface PiProjectorRuntimeState {
  readonly workspacePath: string;
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
  readonly toolCallsByCallId: Map<string, PiTrackedToolCall>;
  readonly toolCallIdByContentIndex: Map<number, string>;
  readonly turnFileChanges: Map<string, PiTurnFileChangeEntry>;
  readonly fileChangesByTurnId: Map<string, V4ConversationFileChangesResult>;
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

/** 回合中断或失败收口时，将仍处于未终态的 ToolCallRow 统一转为 cancelled 并清除流式预览。 */
export function cancelOpenToolCallRows(
  state: PiProjectorRuntimeState,
  nowMs: number,
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [];
  for (const tracked of state.toolCallsByCallId.values()) {
    const existing = state.getRowById(tracked.rowId);
    if (!existing || existing.kind !== "toolCall") continue;
    if (
      existing.status !== "inputStreaming" &&
      existing.status !== "running" &&
      existing.status !== "pendingApproval"
    ) {
      continue;
    }
    const { outputPreview: _preview, progress: _progress, ...rest } = existing;
    deltas.push({
      op: "row.upserted",
      row: {
        ...rest,
        status: "cancelled",
        endedAt: nowMs,
      },
    });
  }
  return deltas;
}

/** 将当前回合累积的去重文件变更快照冻结为 TurnHeaderRow.fileChanges 与详细面板数据。 */
export function snapshotTurnFileChanges(
  state: PiProjectorRuntimeState,
  turnId: string,
): TurnHeaderRow["fileChanges"] | undefined {
  if (state.turnFileChanges.size === 0) return undefined;
  let additions = 0;
  let deletions = 0;
  const items: V4ConversationFileChangesResult["items"] = [];
  for (const entry of state.turnFileChanges.values()) {
    additions += entry.additions;
    deletions += entry.deletions;
    items.push({
      path: entry.path,
      additions: entry.additions,
      deletions: entry.deletions,
      writeCount: entry.writeCount,
      toolNames: [...entry.toolNames],
      patches: [...entry.patches],
    });
  }
  const summary: NonNullable<TurnHeaderRow["fileChanges"]> = {
    additions,
    deletions,
    files: items.length,
    state: "active",
  };
  state.fileChangesByTurnId.set(turnId, {
    files: items.length,
    additions,
    deletions,
    state: "active",
    items,
  });
  return summary;
}

export function resetTurnTransientTracking(state: PiProjectorRuntimeState): void {
  state.toolCallsByCallId.clear();
  state.toolCallIdByContentIndex.clear();
  state.turnFileChanges.clear();
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
  if (aborted || errorInfo) {
    deltas.push(...cancelOpenToolCallRows(state, nowMs));
  }

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
      const fileChanges = snapshotTurnFileChanges(state, header.turnId);
      deltas.push({
        op: "row.upserted",
        row: {
          ...header,
          state: turnState,
          endedAt: nowMs,
          activeMs: Math.max(1, nowMs - state.activeTurnStartedAt),
          outputTokens: state.turnOutputTokens,
          ...(closedSegments ? { workSegments: closedSegments } : {}),
          ...(fileChanges ? { fileChanges } : {}),
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
  resetTurnTransientTracking(state);
  return deltas;
}

/** Pi 自动续跑排队消息出队时关闭上一轮 TurnHeader 并开启独立新回合。 */
export function buildDequeuedUserTurnDeltas(
  state: PiProjectorRuntimeState,
  item: QueueItem,
  nextQueue: QueueState,
  nowMs: number,
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [...closeOpenStreamingRows(state, nowMs, "complete")];
  if (state.activeTurnHeaderRowId !== null) {
    const prevHeader = state.getRowById(state.activeTurnHeaderRowId);
    if (prevHeader && prevHeader.kind === "turnHeader" && prevHeader.state === "running") {
      const closedSegments = closeOpenWorkSegments(state.activeWorkSegments, nowMs);
      const fileChanges = snapshotTurnFileChanges(state, prevHeader.turnId);
      deltas.push({
        op: "row.upserted",
        row: {
          ...prevHeader,
          state: "completedSuccess",
          endedAt: nowMs,
          activeMs: Math.max(1, nowMs - state.activeTurnStartedAt),
          outputTokens: state.turnOutputTokens,
          ...(closedSegments ? { workSegments: closedSegments } : {}),
          ...(fileChanges ? { fileChanges } : {}),
        },
      });
    }
  }
  resetTurnTransientTracking(state);

  state.turnCounter += 1;
  const turnId = `turn_${state.turnCounter}`;
  const headerRowId = ++state.nextRowId;
  const userRowId = ++state.nextRowId;
  deltas.push(
    {
      op: "row.appended",
      row: buildTurnHeaderRow({
        rowId: headerRowId,
        turnId,
        createdAt: nowMs,
        createdAtSeq: state.snapshot.seq + deltas.length + 1,
        sourceCommandId: item.sourceCommandId,
      }),
    },
    {
      op: "row.appended",
      row: buildUserInputRow({
        rowId: userRowId,
        turnId,
        createdAt: nowMs,
        createdAtSeq: state.snapshot.seq + deltas.length + 2,
        text: item.text,
        commandId: item.sourceCommandId,
        clientId: item.clientId,
        modelSelection: item.modelSelection,
        inputOrigin: item.inputOrigin,
      }),
    },
  );

  state.activeTurnId = turnId;
  state.activeTurnHeaderRowId = headerRowId;
  state.activeTurnStartedAt = nowMs;
  state.activeWorkSegments = undefined;
  state.currentResponseId = undefined;
  state.emittedTextInCurrentAssistantMsg = false;
  state.turnOutputTokens = 0;

  deltas.push({
    op: "state.updated",
    patch: buildPhaseTransitionPatch({
      phase: "running",
      stopState: "stoppable",
      followupMode: state.snapshot.config.followupMode,
      queue: nextQueue,
      nowMs,
      activeTurnId: turnId,
      sourceCommandId: item.sourceCommandId,
      lastError: null,
      apiRetry: null,
    }),
  });
  return deltas;
}
