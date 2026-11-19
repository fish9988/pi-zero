/**
 * Pi V4 ConversationRow 与 StatePatch 纯构造辅助（domain 层，无 IO/计时器）。
 */
import type { ModelSelection } from "@zcode/shared";
import type {
  AssistantTextRow,
  ConversationSnapshot,
  QueueState,
  ReasoningRow,
  SessionErrorInfo,
  SessionPhase,
  StatePatch,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
  TurnWorkSegment,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  PiAssistantMessage,
  PiRpcEvent,
  PiUsage,
  PiUserMessage,
} from "#src/pi-runtime/domain/piRpcTypes.js";
import {
  computeInputRouting,
  computeSessionAvailability,
  computeSessionControl,
  isSessionRunningPhase,
} from "#src/pi-runtime/domain/piSnapshotFactory.js";

export function extractPiUserMessageText(message: PiUserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function extractPiAssistantText(message: PiAssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function buildTurnHeaderRow(input: {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
  sourceCommandId?: string | undefined;
}): TurnHeaderRow {
  return {
    kind: "turnHeader",
    rowId: input.rowId,
    turnId: input.turnId,
    entityId: input.turnId,
    productTurnId: input.turnId,
    visibility: "visible",
    createdAt: input.createdAt,
    createdAtSeq: input.createdAtSeq,
    origin: "userInput",
    executionKind: "agent",
    ...(input.sourceCommandId ? { sourceCommandId: input.sourceCommandId } : {}),
    state: "running",
    startedAt: input.createdAt,
  };
}

export function buildUserInputRow(input: {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
  text: string;
  commandId: string;
  clientId: string;
  guided?: true | undefined;
  modelSelection?: ModelSelection | undefined;
  inputOrigin?: "desktop" | "mobile" | undefined;
}): UserInputRow {
  return {
    kind: "userInput",
    rowId: input.rowId,
    turnId: input.turnId,
    entityId: `user_${input.rowId}`,
    productTurnId: input.turnId,
    visibility: "visible",
    createdAt: input.createdAt,
    createdAtSeq: input.createdAtSeq,
    ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    text: input.text,
    origin: "realUser",
    ...(input.guided ? { guided: true as const } : {}),
    sourceCommandId: input.commandId,
    rootSourceCommandId: input.commandId,
    clientId: input.clientId,
  };
}

export function buildReasoningRow(input: {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
  assistantResponseId?: string | undefined;
}): ReasoningRow {
  return {
    kind: "reasoning",
    rowId: input.rowId,
    turnId: input.turnId,
    entityId: `reasoning_${input.rowId}`,
    productTurnId: input.turnId,
    visibility: "visible",
    createdAt: input.createdAt,
    createdAtSeq: input.createdAtSeq,
    ...(input.assistantResponseId ? { assistantResponseId: input.assistantResponseId } : {}),
    text: "",
    state: "streaming",
  };
}

export function buildAssistantTextRow(input: {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
  text: string;
  state: AssistantTextRow["state"];
  assistantResponseId?: string | undefined;
  model?: string | undefined;
}): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId: input.rowId,
    turnId: input.turnId,
    entityId: `text_${input.rowId}`,
    productTurnId: input.turnId,
    visibility: "visible",
    createdAt: input.createdAt,
    createdAtSeq: input.createdAtSeq,
    ...(input.assistantResponseId ? { assistantResponseId: input.assistantResponseId } : {}),
    text: input.text,
    state: input.state,
    ...(input.model ? { model: input.model } : {}),
  };
}

export function buildCompactionMarkerRow(input: {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
  origin: "manual" | "auto";
  status: "running" | "success" | "failed" | "noop" | "cancelled";
  tokensBefore?: number | undefined;
  tokensAfter?: number | undefined;
}): TimelineMarkerRow {
  return {
    kind: "timelineMarker",
    rowId: input.rowId,
    turnId: input.turnId,
    entityId: `compact_${input.rowId}`,
    productTurnId: input.turnId,
    visibility: "visible",
    createdAt: input.createdAt,
    createdAtSeq: input.createdAtSeq,
    lane: "assistantWork",
    marker: {
      type: "compact",
      origin: input.origin,
      status: input.status,
      ...(typeof input.tokensBefore === "number" ? { tokensBefore: input.tokensBefore } : {}),
      ...(typeof input.tokensAfter === "number" ? { tokensAfter: input.tokensAfter } : {}),
    },
  };
}

/**
 * 构造符合 Zod union 约束的 `modelChange` 轻边界分隔行：
 * `fromProvider` 与 `fromModel` 必须同时非空存在，或同时省略。
 */
export function buildModelChangeMarkerRow(input: {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
  fromProvider?: string | undefined;
  fromModel?: string | undefined;
  toProvider: string;
  toModel: string;
  toThought: string;
  sourceCommandId?: string | undefined;
}): TimelineMarkerRow {
  const fromProvider = input.fromProvider?.trim();
  const fromModel = input.fromModel?.trim();
  const hasCompleteFrom = Boolean(fromProvider && fromModel);
  const marker: Extract<TimelineMarkerRow["marker"], { type: "modelChange" }> = hasCompleteFrom
    ? {
        type: "modelChange",
        fromProvider: fromProvider!,
        fromModel: fromModel!,
        toProvider: input.toProvider,
        toModel: input.toModel,
        toThought: input.toThought,
      }
    : {
        type: "modelChange",
        toProvider: input.toProvider,
        toModel: input.toModel,
        toThought: input.toThought,
      };
  return {
    kind: "timelineMarker",
    rowId: input.rowId,
    turnId: input.turnId,
    entityId: `model_change_${input.rowId}`,
    productTurnId: input.turnId,
    visibility: "visible",
    createdAt: input.createdAt,
    createdAtSeq: input.createdAtSeq,
    ...(input.sourceCommandId ? { sourceCommandId: input.sourceCommandId } : {}),
    lane: "lightBoundary",
    marker,
  };
}

export function buildToolCallRow(input: {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
  toolCallId: string;
  toolName: string;
  status: ToolCallRow["status"];
  inputText: string;
  parsedInput?: unknown;
  assistantResponseId?: string | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
}): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: input.rowId,
    turnId: input.turnId,
    entityId: `tool_${input.toolCallId}`,
    productTurnId: input.turnId,
    visibility: "visible",
    createdAt: input.createdAt,
    createdAtSeq: input.createdAtSeq,
    ...(input.assistantResponseId ? { assistantResponseId: input.assistantResponseId } : {}),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: input.status,
    inputText: input.inputText,
    ...(input.parsedInput !== undefined ? { input: input.parsedInput } : {}),
    ...(typeof input.startedAt === "number" ? { startedAt: input.startedAt } : {}),
    ...(typeof input.endedAt === "number" ? { endedAt: input.endedAt } : {}),
  };
}

export function resolveCompactionEndMarker(
  event: Extract<PiRpcEvent, { type: "compaction_end" | "auto_compaction_end" }>,
  fallbackOrigin: "manual" | "auto",
): Extract<TimelineMarkerRow["marker"], { type: "compact" }> {
  const origin: "manual" | "auto" = event.reason === "manual" ? "manual" : fallbackOrigin;
  const status = event.aborted
    ? "cancelled"
    : event.errorMessage
      ? "failed"
      : event.result
        ? "success"
        : "noop";
  return {
    type: "compact",
    origin,
    status,
    ...(typeof event.result?.tokensBefore === "number"
      ? { tokensBefore: event.result.tokensBefore }
      : {}),
    ...(typeof event.result?.estimatedTokensAfter === "number"
      ? { tokensAfter: event.result.estimatedTokensAfter }
      : {}),
  };
}

export function appendGuidedWorkSegment(
  existing: readonly TurnWorkSegment[] | undefined,
  input: {
    turnStartedAt: number;
    nowMs: number;
    triggerEntityId: string;
    allocateSegmentId: () => string;
  },
): TurnWorkSegment[] {
  if (!existing || existing.length === 0) {
    return [
      {
        segmentId: input.allocateSegmentId(),
        startedAt: input.turnStartedAt,
        endedAt: input.nowMs,
        activeMs: Math.max(0, input.nowMs - input.turnStartedAt),
      },
      {
        segmentId: input.allocateSegmentId(),
        triggerEntityId: input.triggerEntityId,
        startedAt: input.nowMs,
      },
    ];
  }
  const updated = existing.map((segment, index, arr) =>
    index === arr.length - 1 && segment.endedAt === undefined
      ? {
          ...segment,
          endedAt: input.nowMs,
          activeMs: Math.max(0, input.nowMs - segment.startedAt),
        }
      : segment,
  );
  updated.push({
    segmentId: input.allocateSegmentId(),
    triggerEntityId: input.triggerEntityId,
    startedAt: input.nowMs,
  });
  return updated;
}

export function closeOpenWorkSegments(
  segments: readonly TurnWorkSegment[] | undefined,
  nowMs: number,
): TurnWorkSegment[] | undefined {
  if (!segments) return undefined;
  return segments.map((segment, index, arr) =>
    index === arr.length - 1 && segment.endedAt === undefined
      ? {
          ...segment,
          endedAt: nowMs,
          activeMs: Math.max(0, nowMs - segment.startedAt),
        }
      : segment,
  );
}

export function accumulateSessionUsage(
  current: ConversationSnapshot["usage"],
  usage: PiUsage,
  contextWindowMax: number,
): { nextUsage: ConversationSnapshot["usage"]; addedOutputTokens: number } {
  const addedInput = Math.max(0, usage.input || 0);
  const addedOutput = Math.max(0, usage.output || 0);
  const addedCacheRead = Math.max(0, usage.cacheRead || 0);
  const addedCacheWrite = Math.max(0, usage.cacheWrite || 0);
  const usedTokens = addedInput + addedCacheRead + addedCacheWrite + addedOutput;
  const contextWindow =
    contextWindowMax > 0 && usedTokens > 0
      ? {
          usedTokens,
          maxTokens: contextWindowMax,
          autoCompactThresholdTokens: null,
        }
      : current.contextWindow;
  return {
    addedOutputTokens: addedOutput,
    nextUsage: {
      contextWindow,
      cumulative: {
        inputTokens: current.cumulative.inputTokens + addedInput,
        outputTokens: current.cumulative.outputTokens + addedOutput,
        cacheReadTokens: current.cumulative.cacheReadTokens + addedCacheRead,
        cacheWriteTokens: current.cumulative.cacheWriteTokens + addedCacheWrite,
      },
    },
  };
}

export function buildPhaseTransitionPatch(input: {
  phase: SessionPhase;
  stopState: "idle" | "stoppable" | "stopping";
  followupMode: "queue" | "guide";
  queue: QueueState;
  nowMs: number;
  activeTurnId?: string | undefined;
  sourceCommandId?: string | undefined;
  lastError: SessionErrorInfo | null;
  apiRetry: ConversationSnapshot["control"]["apiRetry"];
}): StatePatch {
  const activeWorks =
    isSessionRunningPhase(input.phase) && input.activeTurnId
      ? [
          {
            kind: "primaryTurn" as const,
            foregroundExecutionId: input.activeTurnId,
            ...(input.sourceCommandId ? { sourceCommandId: input.sourceCommandId } : {}),
            startedAt: input.nowMs,
          },
        ]
      : [];
  return {
    control: computeSessionControl({
      phase: input.phase,
      stopState: input.stopState,
      stopTargetKind: "assistant",
      activeWorks,
      lastError: input.lastError,
      apiRetry: input.apiRetry,
    }),
    queue: input.queue,
    availability: computeSessionAvailability(input.phase, input.queue),
    inputRouting: computeInputRouting(input.phase, input.followupMode, input.queue),
  };
}
