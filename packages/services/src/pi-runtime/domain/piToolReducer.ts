/**
 * Pi RPC 工具调用与工具执行流式事件归约器（纯 domain 层，无 IO/计时器）。
 * 覆盖 toolcall_start / toolcall_delta / toolcall_end / tool_execution_start /
 * tool_execution_update / tool_execution_end，驱动 ZCode 原生 ToolCallBlocks 完整生命周期。
 */
import type { ConversationDelta, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { PiAssistantMessageEvent, PiRpcEvent } from "#src/pi-runtime/domain/piRpcTypes.js";
import type { PiFileDiffDisplay } from "#src/pi-runtime/domain/piEditDiffMapper.js";
import { buildToolCallRow } from "#src/pi-runtime/domain/piRowBuilders.js";
import {
  buildExecutionOutputPreview,
  buildPiToolOutput,
  extractPartialPiToolArgs,
  extractPiToolResultText,
  mapPiToolName,
  normalizePiToolInput,
  parseMcpToolIdentity,
} from "#src/pi-runtime/domain/piToolMapper.js";
import {
  buildPiSubagentToolInput,
  buildSubagentChildSessionId,
  buildSubagentDirectoryProjection,
  buildSubagentRow,
  buildVirtualSubagentSessionPayload,
  isPiSubagentToolName,
  mapSubagentItemStatusToRowStatus,
  parsePiSubagentArgs,
  parsePiSubagentDetails,
  type PiSubagentItemStatus,
} from "#src/pi-runtime/domain/piSubagentProjector.js";
import {
  closeOpenStreamingRows,
  type PiProjectorRuntimeState,
  type PiTrackedToolCall,
} from "#src/pi-runtime/domain/piTurnSettlement.js";

function projectSubagentToolLifecycle(
  state: PiProjectorRuntimeState,
  input: {
    turnId: string;
    toolCallId: string;
    rawArgs: unknown;
    details: unknown;
    fallbackOutputText?: string | undefined;
    fallbackStatus: PiSubagentItemStatus;
    startedAt: number;
    endedAt?: number | undefined;
    nowMs: number;
    deltas: ConversationDelta[];
  },
): Record<string, unknown> {
  const fromDetails = parsePiSubagentDetails(input.details, input.fallbackStatus);
  const run = fromDetails ?? parsePiSubagentArgs(input.rawArgs, input.fallbackStatus);
  const outcomes =
    run.results.length > 0
      ? run.results
      : [
          {
            agent: "subagent",
            agentSource: "unknown",
            task: "",
            status: input.fallbackStatus,
            messages: [],
          },
        ];

  state.subagentRevision += 1;
  const parentSessionId = state.snapshot.sessionId;

  outcomes.forEach((outcome, index) => {
    const childSessionId = buildSubagentChildSessionId(
      parentSessionId,
      input.toolCallId,
      index,
      outcomes.length,
    );
    const prevPayload = state.subagentSessionsByChildId.get(childSessionId);
    const effectiveStartedAt = prevPayload?.startedAt ?? input.startedAt;
    const effectiveStatus: PiSubagentItemStatus =
      input.endedAt !== undefined && (outcome.status === "pending" || outcome.status === "running")
        ? input.fallbackStatus
        : outcome.status;
    const finalOutcome =
      effectiveStatus === outcome.status ? outcome : { ...outcome, status: effectiveStatus };
    const rowStatus = mapSubagentItemStatusToRowStatus(effectiveStatus);
    const effectiveEndedAt =
      rowStatus === "running" ? undefined : (prevPayload?.endedAt ?? input.endedAt ?? input.nowMs);

    const virtualPayload = buildVirtualSubagentSessionPayload({
      parentSessionId,
      childSessionId,
      toolCallId: input.toolCallId,
      workspacePath: state.workspacePath,
      outcome: finalOutcome,
      fallbackOutputText: outcomes.length === 1 ? input.fallbackOutputText : undefined,
      startedAt: effectiveStartedAt,
      endedAt: effectiveEndedAt,
      nowMs: input.nowMs,
      revision: state.subagentRevision,
      logEpoch: `pi-sub-${parentSessionId}`,
    });
    state.subagentSessionsByChildId.set(childSessionId, virtualPayload);
    state.dirtySubagentChildIds.add(childSessionId);

    const existingSubagentRowId = state.subagentRowIdByChildId.get(childSessionId);
    if (existingSubagentRowId !== undefined) {
      const existingRow = state.getRowById(existingSubagentRowId);
      if (existingRow && existingRow.kind === "subagent") {
        input.deltas.push({
          op: "row.upserted",
          row: {
            ...existingRow,
            subagentType: virtualPayload.subagentType,
            status: virtualPayload.status,
            summaryText: virtualPayload.summary,
            ...(typeof effectiveEndedAt === "number" ? { endedAt: effectiveEndedAt } : {}),
          },
        });
      }
    } else {
      const subagentRowId = allocateRowId(state);
      state.subagentRowIdByChildId.set(childSessionId, subagentRowId);
      input.deltas.push({
        op: "row.appended",
        row: buildSubagentRow({
          rowId: subagentRowId,
          turnId: input.turnId,
          createdAt: effectiveStartedAt,
          createdAtSeq: state.snapshot.seq + input.deltas.length + 1,
          parentToolCallId: input.toolCallId,
          subagentType: virtualPayload.subagentType,
          status: virtualPayload.status,
          summaryText: virtualPayload.summary,
          childSessionId,
          startedAt: effectiveStartedAt,
          endedAt: effectiveEndedAt,
        }),
      });
    }
  });

  const directory = buildSubagentDirectoryProjection(
    Array.from(state.subagentSessionsByChildId.values()),
    state.subagentRevision,
  );
  input.deltas.push({
    op: "state.updated",
    patch: { subagents: directory.state },
  });

  return buildPiSubagentToolInput(input.rawArgs, run);
}

function allocateRowId(state: PiProjectorRuntimeState): number {
  state.nextRowId += 1;
  return state.nextRowId;
}

function normalizeFileChangeKey(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/");
}

function recordTurnFileChange(
  state: PiProjectorRuntimeState,
  canonicalToolName: string,
  fileDiff: PiFileDiffDisplay,
): void {
  const key = normalizeFileChangeKey(fileDiff.filePath);
  if (!key) return;
  const existing = state.turnFileChanges.get(key);
  if (existing) {
    existing.additions += fileDiff.additions;
    existing.deletions += fileDiff.deletions;
    existing.writeCount += 1;
    if (!existing.toolNames.includes(canonicalToolName)) {
      existing.toolNames.push(canonicalToolName);
    }
    existing.patches.push(...fileDiff.structuredPatch);
  } else {
    state.turnFileChanges.set(key, {
      path: fileDiff.filePath,
      additions: fileDiff.additions,
      deletions: fileDiff.deletions,
      writeCount: 1,
      toolNames: [canonicalToolName],
      patches: [...fileDiff.structuredPatch],
    });
  }
}

function hasEarlyVisibilityUpdate(
  canonicalToolName: string,
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): boolean {
  if (!next) return false;
  if (canonicalToolName === "Bash") {
    const nextCmd = typeof next.command === "string" ? next.command : "";
    const prevCmd = typeof prev?.command === "string" ? prev.command : "";
    return nextCmd.length > 0 && nextCmd !== prevCmd;
  }
  return prev === undefined;
}

function createAndTrackToolCall(
  state: PiProjectorRuntimeState,
  input: {
    turnId: string;
    toolCallId: string;
    rawToolName: string;
    status: ToolCallRow["status"];
    inputText: string;
    rawArgs?: Record<string, unknown> | undefined;
    contentIndex?: number | undefined;
    startedAt?: number | undefined;
    nowMs: number;
    deltas: ConversationDelta[];
  },
): PiTrackedToolCall {
  const canonicalToolName = mapPiToolName(input.rawToolName);
  const canonicalInput =
    input.rawArgs !== undefined
      ? normalizePiToolInput(input.rawToolName, input.rawArgs, state.workspacePath)
      : input.rawToolName.trim().toLowerCase() === "ls"
        ? normalizePiToolInput("ls", {}, state.workspacePath)
        : undefined;
  const rowId = allocateRowId(state);
  const tracked: PiTrackedToolCall = {
    rowId,
    toolCallId: input.toolCallId,
    rawToolName: input.rawToolName,
    canonicalToolName,
    inputText: input.inputText,
    rawArgs: input.rawArgs,
    canonicalInput,
    startedAt: input.startedAt,
  };
  state.toolCallsByCallId.set(input.toolCallId, tracked);
  if (input.contentIndex !== undefined) {
    state.toolCallIdByContentIndex.set(input.contentIndex, input.toolCallId);
  }
  const mcp = parseMcpToolIdentity(input.rawToolName);
  input.deltas.push({
    op: "row.appended",
    row: buildToolCallRow({
      rowId,
      turnId: input.turnId,
      createdAt: input.nowMs,
      createdAtSeq: state.snapshot.seq + input.deltas.length + 1,
      toolCallId: input.toolCallId,
      toolName: canonicalToolName,
      status: input.status,
      inputText: input.inputText,
      parsedInput: canonicalInput,
      assistantResponseId: state.currentResponseId,
      startedAt: input.startedAt,
      ...(mcp
        ? { display: { kind: "mcp_tool", serverName: mcp.serverName, toolName: mcp.toolName } }
        : {}),
    }),
  });
  return tracked;
}

export function reduceToolCallAssistantEvent(
  state: PiProjectorRuntimeState,
  sub: Extract<
    PiAssistantMessageEvent,
    { type: "toolcall_start" | "toolcall_delta" | "toolcall_end" }
  >,
  turnId: string,
  nowMs: number,
  deltas: ConversationDelta[],
): void {
  if (sub.type === "toolcall_start") {
    deltas.push(...closeOpenStreamingRows(state, nowMs, "complete"));
    const toolCallId = sub.id?.trim();
    const rawToolName = sub.toolName?.trim();
    if (!toolCallId || !rawToolName) return;
    const existing = state.toolCallsByCallId.get(toolCallId);
    if (existing) {
      state.toolCallIdByContentIndex.set(sub.contentIndex, toolCallId);
      return;
    }
    createAndTrackToolCall(state, {
      turnId,
      toolCallId,
      rawToolName,
      status: "inputStreaming",
      inputText: "",
      contentIndex: sub.contentIndex,
      nowMs,
      deltas,
    });
    return;
  }

  if (sub.type === "toolcall_delta") {
    const toolCallId = state.toolCallIdByContentIndex.get(sub.contentIndex);
    if (!toolCallId) return;
    const tracked = state.toolCallsByCallId.get(toolCallId);
    if (!tracked) return;
    const prevLen = tracked.inputText.length;
    if (sub.delta.length > 0) {
      tracked.inputText += sub.delta;
      deltas.push({
        op: "row.delta",
        rowId: tracked.rowId,
        path: "inputText",
        append: sub.delta,
      });
    }
    // 性能优化：大模型流式写入大文件参数时 toolcall_delta 可能高达上千次，
    // 避免每次 4 字节 delta 都对不断增长的 inputText 全量 O(N^2) 重解析；
    // 首次解析出早期可见摘要后，仅在 4KB 内每 512 字节增量采样一次，完整参数由 toolcall_end 一次性落定。
    const shouldProbePartial =
      tracked.inputText.length <= 4096 &&
      (!tracked.canonicalInput ||
        Math.floor(tracked.inputText.length / 512) > Math.floor(prevLen / 512));
    if (shouldProbePartial) {
      const parsed = extractPartialPiToolArgs(
        tracked.rawToolName,
        tracked.inputText,
        state.workspacePath,
      );
      if (hasEarlyVisibilityUpdate(tracked.canonicalToolName, tracked.canonicalInput, parsed)) {
        tracked.canonicalInput = parsed;
        const existing = state.getRowById(tracked.rowId);
        if (existing && existing.kind === "toolCall") {
          deltas.push({
            op: "row.upserted",
            row: {
              ...existing,
              inputText: tracked.inputText,
              input: parsed,
            },
          });
        }
      }
    }
    return;
  }

  // toolcall_end
  const toolCall = sub.toolCall;
  const toolCallId = toolCall.id || state.toolCallIdByContentIndex.get(sub.contentIndex);
  if (!toolCallId) return;
  const rawArgs = toolCall.arguments ?? {};
  const serializedArgs = JSON.stringify(rawArgs);
  const existingTracked = state.toolCallsByCallId.get(toolCallId);
  if (!existingTracked) {
    deltas.push(...closeOpenStreamingRows(state, nowMs, "complete"));
    createAndTrackToolCall(state, {
      turnId,
      toolCallId,
      rawToolName: toolCall.name,
      status: "inputStreaming",
      inputText: serializedArgs,
      rawArgs,
      contentIndex: sub.contentIndex,
      nowMs,
      deltas,
    });
    return;
  }
  const canonicalInput = normalizePiToolInput(
    existingTracked.rawToolName,
    rawArgs,
    state.workspacePath,
  );
  existingTracked.rawArgs = rawArgs;
  existingTracked.inputText = serializedArgs;
  existingTracked.canonicalInput = canonicalInput;
  const existingRow = state.getRowById(existingTracked.rowId);
  if (existingRow && existingRow.kind === "toolCall") {
    deltas.push({
      op: "row.upserted",
      row: {
        ...existingRow,
        inputText: serializedArgs,
        ...(canonicalInput !== undefined ? { input: canonicalInput } : {}),
      },
    });
  }
}

export function reduceToolExecutionEvent(
  state: PiProjectorRuntimeState,
  event: Extract<
    PiRpcEvent,
    { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
  >,
  turnId: string,
  nowMs: number,
  deltas: ConversationDelta[],
): void {
  if (event.type === "tool_execution_start") {
    deltas.push(...closeOpenStreamingRows(state, nowMs, "complete"));
    const rawArgs = event.args ?? {};
    const serializedArgs = JSON.stringify(rawArgs);
    const tracked = state.toolCallsByCallId.get(event.toolCallId);
    const isSubagent = isPiSubagentToolName(event.toolName);
    if (!tracked) {
      createAndTrackToolCall(state, {
        turnId,
        toolCallId: event.toolCallId,
        rawToolName: event.toolName,
        status: "running",
        inputText: serializedArgs,
        rawArgs,
        startedAt: nowMs,
        nowMs,
        deltas,
      });
      if (isSubagent) {
        projectSubagentToolLifecycle(state, {
          turnId,
          toolCallId: event.toolCallId,
          rawArgs,
          details: undefined,
          fallbackStatus: "running",
          startedAt: nowMs,
          nowMs,
          deltas,
        });
      }
      return;
    }
    const canonicalInput = normalizePiToolInput(event.toolName, rawArgs, state.workspacePath);
    tracked.rawArgs = rawArgs;
    tracked.inputText = serializedArgs;
    tracked.canonicalInput = canonicalInput;
    tracked.startedAt = nowMs;
    const existingRow = state.getRowById(tracked.rowId);
    if (existingRow && existingRow.kind === "toolCall") {
      deltas.push({
        op: "row.upserted",
        row: {
          ...existingRow,
          status: "running",
          startedAt: nowMs,
          inputText: serializedArgs,
          ...(canonicalInput !== undefined ? { input: canonicalInput } : {}),
        },
      });
    }
    if (isSubagent) {
      projectSubagentToolLifecycle(state, {
        turnId,
        toolCallId: event.toolCallId,
        rawArgs,
        details: undefined,
        fallbackStatus: "running",
        startedAt: nowMs,
        nowMs,
        deltas,
      });
    }
    return;
  }

  if (event.type === "tool_execution_update") {
    const tracked = state.toolCallsByCallId.get(event.toolCallId);
    if (!tracked) return;
    if (isPiSubagentToolName(tracked.rawToolName)) {
      const updatedInput = projectSubagentToolLifecycle(state, {
        turnId,
        toolCallId: event.toolCallId,
        rawArgs: tracked.rawArgs,
        details: event.partialResult?.details,
        fallbackOutputText: extractPiToolResultText(event.partialResult),
        fallbackStatus: "running",
        startedAt: tracked.startedAt ?? nowMs,
        nowMs,
        deltas,
      });
      tracked.canonicalInput = updatedInput;
      const existingRow = state.getRowById(tracked.rowId);
      if (existingRow && existingRow.kind === "toolCall") {
        deltas.push({
          op: "row.upserted",
          row: {
            ...existingRow,
            status: "running",
            input: updatedInput,
          },
        });
      }
      return;
    }
    if (tracked.canonicalToolName !== "Bash") return;
    const existingRow = state.getRowById(tracked.rowId);
    if (
      !existingRow ||
      existingRow.kind !== "toolCall" ||
      (existingRow.status !== "running" && existingRow.status !== "inputStreaming")
    ) {
      return;
    }
    const preview = buildExecutionOutputPreview(extractPiToolResultText(event.partialResult));
    if (!preview) return;
    deltas.push({
      op: "row.upserted",
      row: {
        ...existingRow,
        status: "running",
        outputPreview: preview,
      },
    });
    return;
  }

  // tool_execution_end
  const existingTracked = state.toolCallsByCallId.get(event.toolCallId);
  const rawToolName = existingTracked?.rawToolName ?? event.toolName;
  const canonicalToolName = existingTracked?.canonicalToolName ?? mapPiToolName(rawToolName);
  const built = buildPiToolOutput({
    rawToolName,
    canonicalToolName,
    rawArgs: existingTracked?.rawArgs,
    result: event.result,
    isError: event.isError,
  });
  if (!event.isError && built.fileDiff) {
    recordTurnFileChange(state, canonicalToolName, built.fileDiff);
  }
  const fallbackStartedAt =
    typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
      ? Math.max(0, nowMs - Math.max(0, Math.trunc(event.durationMs)))
      : nowMs;

  if (!existingTracked) {
    const rowId = allocateRowId(state);
    const canonicalInput =
      rawToolName.trim().toLowerCase() === "ls"
        ? normalizePiToolInput("ls", {}, state.workspacePath)
        : undefined;
    state.toolCallsByCallId.set(event.toolCallId, {
      rowId,
      toolCallId: event.toolCallId,
      rawToolName,
      canonicalToolName,
      inputText: "{}",
      rawArgs: undefined,
      canonicalInput,
      startedAt: fallbackStartedAt,
    });
    const terminalRow: ToolCallRow = {
      ...buildToolCallRow({
        rowId,
        turnId,
        createdAt: nowMs,
        createdAtSeq: state.snapshot.seq + deltas.length + 1,
        toolCallId: event.toolCallId,
        toolName: canonicalToolName,
        status: event.isError ? "error" : "success",
        inputText: "{}",
        parsedInput: canonicalInput,
        assistantResponseId: state.currentResponseId,
        startedAt: fallbackStartedAt,
        endedAt: nowMs,
      }),
      output: built.output,
      ...(built.error ? { error: built.error } : {}),
    };
    deltas.push({ op: "row.appended", row: terminalRow });
    return;
  }

  const existingRow = state.getRowById(existingTracked.rowId);
  let finalInput = existingTracked.canonicalInput;
  if (isPiSubagentToolName(rawToolName)) {
    finalInput = projectSubagentToolLifecycle(state, {
      turnId,
      toolCallId: event.toolCallId,
      rawArgs: existingTracked.rawArgs,
      details: event.result?.details,
      fallbackOutputText: extractPiToolResultText(event.result),
      fallbackStatus: event.isError ? "failed" : "done",
      startedAt: existingTracked.startedAt ?? fallbackStartedAt,
      endedAt: nowMs,
      nowMs,
      deltas,
    });
    existingTracked.canonicalInput = finalInput;
  }
  if (existingRow && existingRow.kind === "toolCall") {
    const { outputPreview: _preview, progress: _progress, error: _prevErr, ...rest } = existingRow;
    deltas.push({
      op: "row.upserted",
      row: {
        ...rest,
        status: event.isError ? "error" : "success",
        startedAt: rest.startedAt ?? fallbackStartedAt,
        endedAt: nowMs,
        ...(finalInput !== undefined ? { input: finalInput } : {}),
        output: built.output,
        ...(built.error ? { error: built.error } : {}),
      },
    });
  }
}
