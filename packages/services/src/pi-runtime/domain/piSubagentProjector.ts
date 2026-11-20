/**
 * Pi `subagent` 扩展工具 -> ZCode V4 `Agent` 工具卡、`SubagentRow`、`snapshot.subagents`
 * 以及虚拟只读子会话快照（供右侧 `SubagentSessionSidePane` 实时观测）的纯投影器（domain 层，0 IO）。
 */
import type { ZCodeSessionEndedSubagent } from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  type ConversationSnapshot,
  type RunningSubagentSummary,
  type SessionPhase,
  type SubagentProjectionState,
  type SubagentRow,
  type TurnHeaderRow,
  type WireConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildAssistantTextRow,
  buildReasoningRow,
  buildToolCallRow,
  buildTurnHeaderRow,
  buildUserInputRow,
} from "#src/pi-runtime/domain/piRowBuilders.js";
import {
  computeInputRouting,
  computeSessionAvailability,
  computeSessionControl,
  createInitialConversationSnapshot,
  createInitialSessionConfig,
  deriveAssistantPreview,
} from "#src/pi-runtime/domain/piSnapshotFactory.js";
import {
  buildPiToolOutput,
  mapPiToolName,
  normalizePiToolInput,
} from "#src/pi-runtime/domain/piToolMapper.js";
import type { PiToolResultMessage } from "#src/pi-runtime/domain/piRpcTypes.js";

export type PiSubagentItemStatus = "pending" | "running" | "done" | "failed" | "aborted";

export interface PiSubagentOutcome {
  readonly agent: string;
  readonly agentSource: string;
  readonly task: string;
  readonly status: PiSubagentItemStatus;
  readonly model?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly step?: number | undefined;
  readonly turns?: number | undefined;
  readonly contextTokens?: number | undefined;
  readonly cost?: number | undefined;
  readonly messages: readonly unknown[];
}

export interface PiSubagentRun {
  readonly mode: "single" | "parallel" | "chain";
  readonly results: readonly PiSubagentOutcome[];
  readonly fromDetails: boolean;
}

export interface VirtualSubagentSessionPayload {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly toolCallId: string;
  readonly subagentType: string;
  readonly title: string;
  readonly summary: string;
  readonly status: SubagentRow["status"];
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
  readonly snapshot: ConversationSnapshot;
  readonly rows: readonly WireConversationRow[];
}

const SUBAGENT_TOOL_NAMES = new Set(["subagent", "task", "agent", "invoke_subagent"]);

export function isPiSubagentToolName(rawToolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(rawToolName.trim().toLowerCase());
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mapChildStatus(raw: unknown, fallback: PiSubagentItemStatus): PiSubagentItemStatus {
  if (typeof raw !== "string") return fallback;
  switch (raw.trim().toLowerCase()) {
    case "pending":
    case "queued":
      return "pending";
    case "running":
    case "in_progress":
    case "active":
      return "running";
    case "completed":
    case "done":
    case "success":
      return "done";
    case "failed":
    case "error":
      return "failed";
    case "aborted":
    case "cancelled":
    case "canceled":
      return "aborted";
    default:
      return fallback;
  }
}

export function mapSubagentItemStatusToRowStatus(
  status: PiSubagentItemStatus,
): SubagentRow["status"] {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "failed";
    case "aborted":
      return "cancelled";
    default:
      return "running";
  }
}

function parseSingleOutcome(
  raw: Record<string, unknown>,
  fallbackStatus: PiSubagentItemStatus,
): PiSubagentOutcome {
  const usage = isPlainRecord(raw["usage"]) ? raw["usage"] : {};
  const messages = Array.isArray(raw["messages"]) ? (raw["messages"] as readonly unknown[]) : [];
  const rawAgent = typeof raw["agent"] === "string" ? raw["agent"].trim() : "";
  const rawTask = typeof raw["task"] === "string" ? raw["task"].trim() : "";
  const rawPrompt = typeof raw["prompt"] === "string" ? raw["prompt"].trim() : "";
  const rawDesc = typeof raw["description"] === "string" ? raw["description"].trim() : "";
  const step = readNum(raw["step"]);
  return {
    agent: rawAgent || "subagent",
    agentSource: typeof raw["agentSource"] === "string" ? raw["agentSource"] : "unknown",
    task: rawTask || rawPrompt || rawDesc,
    status: mapChildStatus(raw["status"], fallbackStatus),
    model:
      typeof raw["model"] === "string" && raw["model"].trim() ? raw["model"].trim() : undefined,
    errorMessage:
      typeof raw["errorMessage"] === "string" && raw["errorMessage"].trim()
        ? raw["errorMessage"].trim()
        : undefined,
    step: step !== undefined && step > 0 ? step : undefined,
    turns: readNum(usage["turns"]),
    contextTokens: readNum(usage["contextTokens"]),
    cost: readNum(usage["cost"]),
    messages,
  };
}

/** 解析 Pi `subagent` 扩展在 `partialResult.details` / `result.details` 中的结构化运行态。 */
export function parsePiSubagentDetails(
  details: unknown,
  fallbackStatus: PiSubagentItemStatus = "running",
): PiSubagentRun | null {
  if (!isPlainRecord(details)) return null;
  const rawResults = details["results"];
  if (!Array.isArray(rawResults) || rawResults.length === 0) return null;
  const results: PiSubagentOutcome[] = [];
  for (const item of rawResults) {
    if (isPlainRecord(item)) {
      results.push(parseSingleOutcome(item, fallbackStatus));
    }
  }
  if (results.length === 0) return null;
  const rawMode = details["mode"];
  const mode: PiSubagentRun["mode"] =
    rawMode === "parallel" || rawMode === "chain" ? rawMode : "single";
  return { mode, results, fromDetails: true };
}

/** 在首帧 `details` 尚未到达前，从 `args` 推断子代理列表骨架（支持 single / parallel / chain）。 */
export function parsePiSubagentArgs(
  args: unknown,
  fallbackStatus: PiSubagentItemStatus = "running",
): PiSubagentRun {
  if (!isPlainRecord(args)) {
    return { mode: "single", results: [], fromDetails: false };
  }
  const collect = (key: string): PiSubagentOutcome[] => {
    const arr = args[key];
    if (!Array.isArray(arr)) return [];
    const out: PiSubagentOutcome[] = [];
    for (const item of arr) {
      if (isPlainRecord(item)) out.push(parseSingleOutcome(item, fallbackStatus));
    }
    return out;
  };
  const parallelTasks = collect("tasks");
  if (parallelTasks.length > 0) {
    return { mode: "parallel", results: parallelTasks, fromDetails: false };
  }
  const chainSteps = collect("chain");
  if (chainSteps.length > 0) {
    return {
      mode: "chain",
      results: chainSteps.map((item, idx) => ({ ...item, step: idx + 1 })),
      fromDetails: false,
    };
  }
  const agent =
    (typeof args["agent"] === "string" && args["agent"].trim()) ||
    (typeof args["subagent_type"] === "string" && args["subagent_type"].trim()) ||
    (typeof args["role"] === "string" && args["role"].trim()) ||
    "subagent";
  const task =
    (typeof args["task"] === "string" && args["task"].trim()) ||
    (typeof args["prompt"] === "string" && args["prompt"].trim()) ||
    (typeof args["description"] === "string" && args["description"].trim()) ||
    "";
  return {
    mode: "single",
    results: [{ agent, agentSource: "unknown", task, status: fallbackStatus, messages: [] }],
    fromDetails: false,
  };
}

function summarizeTaskTitle(task: string, fallback: string): string {
  const firstLine = task
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const text = firstLine || fallback;
  return text.length > 84 ? `${text.slice(0, 83)}…` : text;
}

/** 构造 ZCode `AgentToolCallBlock` 原生可识别的 canonical `input` 对象。 */
export function buildPiSubagentToolInput(
  rawArgs: unknown,
  run?: PiSubagentRun | null,
): Record<string, unknown> {
  const effectiveRun = run && run.results.length > 0 ? run : parsePiSubagentArgs(rawArgs);
  const first = effectiveRun.results[0];
  if (effectiveRun.mode === "parallel" && effectiveRun.results.length > 1) {
    const names = effectiveRun.results.map((r) => r.agent).join(", ");
    const doneCount = effectiveRun.results.filter((r) => r.status === "done").length;
    return {
      subagent_type: first?.agent || "parallel",
      description: `并行 ${effectiveRun.results.length} 个子代理 (${doneCount}/${effectiveRun.results.length}) · ${names}`,
      prompt: effectiveRun.results.map((r, i) => `${i + 1}. [${r.agent}] ${r.task}`).join("\n"),
    };
  }
  if (effectiveRun.mode === "chain" && effectiveRun.results.length > 1) {
    const doneCount = effectiveRun.results.filter((r) => r.status === "done").length;
    return {
      subagent_type: first?.agent || "chain",
      description: `链式 ${effectiveRun.results.length} 步 (${doneCount}/${effectiveRun.results.length}) · ${summarizeTaskTitle(first?.task ?? "", "Subagent Chain")}`,
      prompt: effectiveRun.results
        .map((r, i) => `Step ${i + 1} [${r.agent}]: ${r.task}`)
        .join("\n"),
    };
  }
  const agentName = first?.agent || "subagent";
  const taskText = first?.task || "";
  return {
    subagent_type: agentName,
    description: summarizeTaskTitle(taskText, agentName),
    ...(taskText ? { prompt: taskText } : {}),
  };
}

export function buildSubagentChildSessionId(
  parentSessionId: string,
  toolCallId: string,
  index: number,
  totalCount: number,
): string {
  const safeTool = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "call";
  return totalCount <= 1
    ? `${parentSessionId}__subagent__${safeTool}`
    : `${parentSessionId}__subagent__${safeTool}__${index + 1}`;
}

export function buildSubagentRow(input: {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
  parentToolCallId: string;
  subagentType: string;
  status: SubagentRow["status"];
  summaryText: string;
  childSessionId: string;
  startedAt: number;
  endedAt?: number | undefined;
}): SubagentRow {
  return {
    kind: "subagent",
    rowId: input.rowId,
    turnId: input.turnId,
    entityId: `subagent_${input.childSessionId}`,
    productTurnId: input.turnId,
    visibility: "visible",
    createdAt: input.createdAt,
    createdAtSeq: input.createdAtSeq,
    parentToolCallId: input.parentToolCallId,
    subagentType: input.subagentType,
    status: input.status,
    summaryText: input.summaryText,
    childSessionId: input.childSessionId,
    startedAt: input.startedAt,
    ...(typeof input.endedAt === "number" ? { endedAt: input.endedAt } : {}),
  };
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isPlainRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    }
  }
  return parts.join("\n");
}

/**
 * 将单个 Pi 子代理的 `task` + `messages[]`（以及报错/终态文本）投影为完整的 V4 只读虚拟会话快照，
 * 供 ZCode 原生 `SubagentSessionSidePane`（右侧独立窗口）完整渲染思考、工具调用与答复。
 */
export function buildVirtualSubagentSessionPayload(input: {
  parentSessionId: string;
  childSessionId: string;
  toolCallId: string;
  workspacePath: string;
  outcome: PiSubagentOutcome;
  fallbackOutputText?: string | undefined;
  startedAt: number;
  endedAt?: number | undefined;
  nowMs: number;
  revision: number;
  logEpoch: string;
}): VirtualSubagentSessionPayload {
  const { outcome } = input;
  const rowStatus = mapSubagentItemStatusToRowStatus(outcome.status);
  const title = summarizeTaskTitle(outcome.task, outcome.agent);
  const rows: WireConversationRow[] = [];
  let rowId = 0;

  const turnId = "turn_subagent_1";
  const turnHeaderRowId = ++rowId;
  const turnState: TurnHeaderRow["state"] =
    rowStatus === "running"
      ? "running"
      : rowStatus === "failed"
        ? "failed"
        : rowStatus === "cancelled"
          ? "completedInterrupted"
          : "completedSuccess";
  const phase: SessionPhase =
    rowStatus === "running"
      ? "running"
      : rowStatus === "failed"
        ? "error"
        : rowStatus === "cancelled"
          ? "completedInterrupted"
          : "completedSuccess";

  rows.push({
    ...buildTurnHeaderRow({
      rowId: turnHeaderRowId,
      turnId,
      createdAt: input.startedAt,
      createdAtSeq: turnHeaderRowId,
    }),
    state: turnState,
    ...(typeof input.endedAt === "number"
      ? {
          endedAt: input.endedAt,
          activeMs: Math.max(1, input.endedAt - input.startedAt),
        }
      : {}),
  });

  if (outcome.task.trim()) {
    const userRowId = ++rowId;
    rows.push(
      buildUserInputRow({
        rowId: userRowId,
        turnId,
        createdAt: input.startedAt,
        createdAtSeq: userRowId,
        text: outcome.task,
        commandId: `subagent_task_${input.childSessionId}`,
        clientId: "pi-subagent",
        canEdit: false,
      }),
    );
  }

  // Pass 1: 建立 toolCallId -> toolResult 映射
  const toolResults = new Map<string, PiToolResultMessage>();
  for (const rawMsg of outcome.messages) {
    if (!isPlainRecord(rawMsg)) continue;
    if (rawMsg["role"] === "toolResult" && typeof rawMsg["toolCallId"] === "string") {
      toolResults.set(rawMsg["toolCallId"], rawMsg as unknown as PiToolResultMessage);
    }
  }

  let lastAssistantText = "";
  let responseIdx = 0;

  // Pass 2: 将子代理内部 messages 转为原生 V4 Reasoning / ToolCall / AssistantText 行
  for (const rawMsg of outcome.messages) {
    if (!isPlainRecord(rawMsg)) continue;
    const role = rawMsg["role"];
    if (role !== "assistant") continue;
    responseIdx += 1;
    const responseId = `sub_resp_${responseIdx}`;
    const content = Array.isArray(rawMsg["content"]) ? rawMsg["content"] : [];
    const msgTs = readNum(rawMsg["timestamp"]) ?? input.nowMs;

    for (const block of content) {
      if (!isPlainRecord(block)) continue;
      const bType = block["type"];
      if (bType === "thinking" && typeof block["thinking"] === "string" && block["thinking"]) {
        const rid = ++rowId;
        rows.push({
          ...buildReasoningRow({
            rowId: rid,
            turnId,
            createdAt: msgTs,
            createdAtSeq: rid,
            assistantResponseId: responseId,
          }),
          text: block["thinking"],
          state: "complete",
        });
      } else if (bType === "toolCall" && typeof block["name"] === "string") {
        const callId =
          typeof block["id"] === "string" && block["id"] ? block["id"] : `sub_tool_${rowId + 1}`;
        const rawToolName = block["name"];
        const rawArgs = isPlainRecord(block["arguments"]) ? block["arguments"] : {};
        const canonicalName = mapPiToolName(rawToolName);
        const canonicalInput = normalizePiToolInput(rawToolName, rawArgs, input.workspacePath);
        const res = toolResults.get(callId);
        const rid = ++rowId;
        const toolStatus = res
          ? res.isError
            ? "error"
            : "success"
          : rowStatus === "running"
            ? "running"
            : "success";
        const builtOut = res
          ? buildPiToolOutput({
              rawToolName,
              canonicalToolName: canonicalName,
              rawArgs,
              result: { content: res.content, details: res.details },
              isError: res.isError === true,
            })
          : undefined;
        rows.push({
          ...buildToolCallRow({
            rowId: rid,
            turnId,
            createdAt: msgTs,
            createdAtSeq: rid,
            toolCallId: callId,
            toolName: canonicalName,
            status: toolStatus,
            inputText: JSON.stringify(rawArgs),
            parsedInput: canonicalInput,
            assistantResponseId: responseId,
            startedAt: msgTs,
            ...(res ? { endedAt: res.timestamp ?? msgTs } : {}),
          }),
          ...(builtOut?.output ? { output: builtOut.output } : {}),
          ...(builtOut?.error ? { error: builtOut.error } : {}),
        });
      } else if (bType === "text" && typeof block["text"] === "string" && block["text"].trim()) {
        const rid = ++rowId;
        lastAssistantText = block["text"];
        rows.push(
          buildAssistantTextRow({
            rowId: rid,
            turnId,
            createdAt: msgTs,
            createdAtSeq: rid,
            text: block["text"],
            state: rowStatus === "running" ? "streaming" : "complete",
            assistantResponseId: responseId,
            model: outcome.model,
          }),
        );
      }
    }
  }

  // 若子代理扩展未回传详细 messages，用工具输出文本兜底展示，保证侧边窗口永不空白。
  if (!lastAssistantText && input.fallbackOutputText?.trim()) {
    const rid = ++rowId;
    lastAssistantText = input.fallbackOutputText.trim();
    rows.push(
      buildAssistantTextRow({
        rowId: rid,
        turnId,
        createdAt: input.nowMs,
        createdAtSeq: rid,
        text: lastAssistantText,
        state: rowStatus === "running" ? "streaming" : "complete",
        model: outcome.model,
      }),
    );
  }

  if (outcome.errorMessage && rowStatus === "failed") {
    const rid = ++rowId;
    rows.push(
      buildAssistantTextRow({
        rowId: rid,
        turnId,
        createdAt: input.nowMs,
        createdAtSeq: rid,
        text: `**Subagent 错误**：${outcome.errorMessage}`,
        state: "failed",
        model: outcome.model,
      }),
    );
  }

  const summary =
    deriveAssistantPreview(lastAssistantText) ||
    outcome.errorMessage ||
    (rowStatus === "running" ? `${outcome.agent} 执行中…` : title);

  const tailCap = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
  const window = rows.length > tailCap ? rows.slice(rows.length - tailCap) : [...rows];
  const baseConfig = createInitialSessionConfig({
    ...(outcome.model ? { modelSelection: { providerId: "pi", modelId: outcome.model } } : {}),
  });
  const base = createInitialConversationSnapshot({
    sessionId: input.childSessionId,
    logEpoch: input.logEpoch,
    attemptId: `subagent_${input.childSessionId}`,
    config: baseConfig,
    title: `${outcome.agent} · ${title}`,
    titleSource: "generated",
  });

  const snapshot: ConversationSnapshot = {
    ...base,
    seq: rows.length + input.revision,
    revision: Math.max(1, input.revision),
    control: computeSessionControl({
      phase,
      stopState: "idle",
      activeWorks: [],
      lastError:
        rowStatus === "failed" && outcome.errorMessage
          ? {
              code: "fault.pi.subagentFailed",
              message: outcome.errorMessage,
              recoverable: false,
              at: input.nowMs,
              source: "runtime",
            }
          : null,
      apiRetry: null,
    }),
    availability: computeSessionAvailability(phase, base.queue),
    inputRouting: { mode: "reject", reasonCode: "guard.subagent.readOnly" },
    rows: {
      window,
      totalCount: rows.length,
      firstRowId: rows[0]?.rowId ?? null,
    },
  };

  return {
    childSessionId: input.childSessionId,
    parentSessionId: input.parentSessionId,
    toolCallId: input.toolCallId,
    subagentType: outcome.agent,
    title,
    summary,
    status: rowStatus,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    snapshot,
    rows,
  };
}

/** 汇总所有已追踪的子代理条目，生成 `snapshot.subagents` 与 `listSessionSubagents` 所需的 ended 列表。 */
export function buildSubagentDirectoryProjection(
  entries: readonly VirtualSubagentSessionPayload[],
  revision: number,
): {
  readonly state: SubagentProjectionState;
  readonly ended: readonly ZCodeSessionEndedSubagent[];
} {
  const childSessionIds: string[] = [];
  const running: RunningSubagentSummary[] = [];
  const ended: ZCodeSessionEndedSubagent[] = [];

  for (const entry of entries) {
    childSessionIds.push(entry.childSessionId);
    if (entry.status === "running") {
      running.push({
        childSessionId: entry.childSessionId,
        toolCallId: entry.toolCallId,
        subagentType: entry.subagentType,
        title: entry.title,
        summary: entry.summary,
        status: "running",
        startedAt: entry.startedAt,
      });
    } else {
      ended.push({
        childSessionId: entry.childSessionId,
        toolCallId: entry.toolCallId,
        subagentType: entry.subagentType,
        title: entry.title,
        summary: entry.summary,
        status:
          entry.status === "failed"
            ? "failed"
            : entry.status === "cancelled"
              ? "cancelled"
              : "success",
        startedAt: entry.startedAt,
        endedAt: entry.endedAt ?? entry.startedAt,
      });
    }
  }

  return {
    state: {
      revision,
      childSessionIds,
      running,
      endedTotal: ended.length,
    },
    ended,
  };
}

export { extractMessageText as extractPiSubagentMessageText };
