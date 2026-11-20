/**
 * Pi v3 `.jsonl` 会话离线全量水合器（纯 domain 层，无 Node IO/计时器）。
 *
 * 严格零子进程：
 * - 解析 header 与条目树，从末条带 `id` 节点沿 `parentId` 逆向追溯活动分支（带环检测），
 *   自动剔除已放弃的 fork 分支与 `role: "system"` 内部消息；
 * - 两遍关联 `toolCall` ↔ `toolResult`，复用 `piToolMapper` 与 `piEditDiffMapper` 生成
 *   完全兼容 ZCode 原生 `ToolCallBlocks` 的行与 `TurnHeaderRow.fileChanges`；
 * - 还原 `compaction`、`model_change`、`thinking_level_change`、`session_info` 与累计 usage。
 */
import type {
  AttachmentRef,
  ConversationSnapshot,
  SessionConfigState,
  SessionPhase,
  ToolCallRow,
  TurnHeaderRow,
  V4ConversationFileChangesResult,
  WireConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  isPiRecord,
  type PiModelInfo,
  type PiToolResultMessage,
} from "#src/pi-runtime/domain/piRpcTypes.js";
import {
  buildHydratedTurnFileChangesSnapshot,
  parsePiJsonlDocument,
  parsePiModelChangeEntry,
  readPiUsageRecord,
  readPiUserContentImages,
  readPiUserContentText,
  recordHydratedFileDiff,
  resolveActivePiBranchEntries,
} from "#src/pi-runtime/domain/piJsonlBranchParser.js";
import {
  cleanPiSessionTitle,
  parseIsoOrUnixTimestamp,
} from "#src/pi-runtime/domain/piJsonlIndexParser.js";
import {
  accumulateSessionUsage,
  buildAssistantTextRow,
  buildCompactionMarkerRow,
  buildModelChangeMarkerRow,
  buildReasoningRow,
  buildToolCallRow,
  buildTurnHeaderRow,
  buildUserInputRow,
} from "#src/pi-runtime/domain/piRowBuilders.js";
import {
  createInitialSessionConfig,
  deriveAssistantPreview,
} from "#src/pi-runtime/domain/piSnapshotFactory.js";
import {
  buildPiToolOutput,
  mapPiToolName,
  normalizePiToolInput,
} from "#src/pi-runtime/domain/piToolMapper.js";
import type { PiTurnFileChangeEntry } from "#src/pi-runtime/domain/piTurnSettlement.js";

export { resolveActivePiBranchEntries };

export interface HydratedPiInlineAttachment {
  readonly ref: string;
  readonly fileName: string;
  readonly mime: string;
  readonly dataBase64: string;
}

export interface HydratedPiSessionResult {
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly title: string;
  readonly titleSource: "default" | "generated" | "custom";
  readonly lastAssistantPreview: string | undefined;
  readonly phase: SessionPhase;
  readonly config: SessionConfigState;
  readonly contextWindowMax: number;
  readonly usage: ConversationSnapshot["usage"];
  readonly rows: WireConversationRow[];
  readonly fileChangesByTurnId: Map<string, V4ConversationFileChangesResult>;
  readonly inlineAttachments: readonly HydratedPiInlineAttachment[];
}

export interface HydratePiJsonlSessionInput {
  readonly rawContent: string;
  readonly fallbackSessionId: string;
  readonly fallbackCwd: string;
  readonly fallbackMtimeMs: number;
  readonly catalogModels?: readonly PiModelInfo[] | undefined;
  readonly defaultModel?: PiModelInfo | undefined;
  readonly defaultThinkingLevel?: string | undefined;
}

/** 离线解析整个 Pi v3 `.jsonl` 文本并投影为可直接下发的 ZCode V4 会话状态。 */
export function hydratePiJsonlSession(input: HydratePiJsonlSessionInput): HydratedPiSessionResult {
  const doc = parsePiJsonlDocument(input.rawContent);
  const header = doc.header;
  const sessionId =
    (header && typeof header["id"] === "string" && header["id"].trim()) || input.fallbackSessionId;
  const cwd =
    (header && typeof header["cwd"] === "string" && header["cwd"].trim()) || input.fallbackCwd;
  const createdAt = parseIsoOrUnixTimestamp(header?.["timestamp"], input.fallbackMtimeMs);
  const headerTitle =
    header && typeof header["title"] === "string"
      ? cleanPiSessionTitle(header["title"]) || null
      : null;

  const activeEntries = resolveActivePiBranchEntries(doc.entries);

  // Pass 1: 建立活动分支上的 toolCallId -> toolResult 映射表。
  const toolResultByCallId = new Map<string, PiToolResultMessage>();
  for (const entry of activeEntries) {
    if (entry["type"] !== "message" || !isPiRecord(entry["message"])) continue;
    const msg = entry["message"];
    if (msg["role"] === "toolResult" && typeof msg["toolCallId"] === "string") {
      toolResultByCallId.set(msg["toolCallId"], msg as unknown as PiToolResultMessage);
    }
  }

  const rows: WireConversationRow[] = [];
  const fileChangesByTurnId = new Map<string, V4ConversationFileChangesResult>();
  const inlineAttachments: HydratedPiInlineAttachment[] = [];
  const catalogModels = input.catalogModels ?? [];

  let nextRowId = 0;
  let turnCounter = 0;
  let responseCounter = 0;
  let activeTurnId: string | null = null;
  let activeTurnHeaderIdx = -1;
  let activeTurnStartedAt = createdAt;
  let activeTurnLastTs = createdAt;
  let activeTurnOutputTokens = 0;
  let activeTurnEndState: TurnHeaderRow["state"] = "completedSuccess";
  let turnFileChanges = new Map<string, PiTurnFileChangeEntry>();

  let lastActivityAt = createdAt;
  let customTitle: string | null = doc.slotTitle ?? headerTitle;
  let firstUserTitle: string | null = null;
  let lastAssistantPreview: string | undefined;
  let effectiveProvider = "";
  let effectiveModel = "";
  let effectiveThought = input.defaultThinkingLevel ?? "";
  let contextWindowMax = input.defaultModel?.contextWindow ?? 0;
  let activeModelCost: PiModelInfo["cost"] = input.defaultModel?.cost;
  let usage: ConversationSnapshot["usage"] = {
    contextWindow: null,
    cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
  let lastPhase: SessionPhase = "completedSuccess";

  const updateContextWindowForModel = (provider: string, modelId: string): void => {
    const matched =
      catalogModels.find((m) => m.provider === provider && m.id === modelId) ??
      (input.defaultModel &&
      input.defaultModel.provider === provider &&
      input.defaultModel.id === modelId
        ? input.defaultModel
        : undefined);
    if (matched?.contextWindow && matched.contextWindow > 0) {
      contextWindowMax = matched.contextWindow;
    }
    activeModelCost = matched?.cost;
  };

  const settleOpenTurnHeader = (): void => {
    if (activeTurnHeaderIdx < 0 || !activeTurnId) return;
    const headerRow = rows[activeTurnHeaderIdx];
    if (headerRow && headerRow.kind === "turnHeader") {
      const snapped = buildHydratedTurnFileChangesSnapshot(turnFileChanges);
      if (snapped) fileChangesByTurnId.set(activeTurnId, snapped.detail);
      const endedAt = Math.max(activeTurnStartedAt, activeTurnLastTs);
      rows[activeTurnHeaderIdx] = {
        ...headerRow,
        state: activeTurnEndState,
        endedAt,
        activeMs: Math.max(1, endedAt - activeTurnStartedAt),
        outputTokens: activeTurnOutputTokens,
        ...(snapped ? { fileChanges: snapped.summary } : {}),
      };
    }
    activeTurnHeaderIdx = -1;
    activeTurnId = null;
    activeTurnOutputTokens = 0;
    activeTurnEndState = "completedSuccess";
    turnFileChanges = new Map();
  };

  const ensureTurnHeader = (ts: number, commandId?: string): string => {
    if (activeTurnId) return activeTurnId;
    turnCounter += 1;
    const turnId = `turn_${turnCounter}`;
    const headerRowId = ++nextRowId;
    activeTurnId = turnId;
    activeTurnHeaderIdx = rows.length;
    activeTurnStartedAt = ts;
    activeTurnLastTs = ts;
    activeTurnOutputTokens = 0;
    activeTurnEndState = "completedSuccess";
    rows.push(
      buildTurnHeaderRow({
        rowId: headerRowId,
        turnId,
        createdAt: ts,
        createdAtSeq: headerRowId,
        sourceCommandId: commandId,
      }),
    );
    return turnId;
  };

  // Pass 2: 顺序投影活动分支条目为原生 V4 行序列。
  for (const entry of activeEntries) {
    const entryTs = parseIsoOrUnixTimestamp(entry["timestamp"], lastActivityAt);
    if (entryTs > lastActivityAt) lastActivityAt = entryTs;
    const entryType = entry["type"];

    if (entryType === "session_info" && typeof entry["name"] === "string") {
      const cleaned = cleanPiSessionTitle(entry["name"]);
      if (cleaned) customTitle = cleaned;
      continue;
    }
    if (entryType === "title_change" && typeof entry["title"] === "string") {
      const cleaned = cleanPiSessionTitle(entry["title"]);
      if (cleaned) customTitle = cleaned;
      continue;
    }
    if (entryType === "thinking_level_change" && typeof entry["thinkingLevel"] === "string") {
      const trimmed = entry["thinkingLevel"].trim();
      if (trimmed) effectiveThought = trimmed;
      continue;
    }
    if (entryType === "model_change") {
      const parsed = parsePiModelChangeEntry(entry);
      if (parsed) {
        const prevProvider = effectiveProvider;
        const prevModel = effectiveModel;
        effectiveProvider = parsed.provider;
        effectiveModel = parsed.model;
        updateContextWindowForModel(parsed.provider, parsed.model);
        if (rows.length > 0 && (prevProvider !== parsed.provider || prevModel !== parsed.model)) {
          settleOpenTurnHeader();
          const rowId = ++nextRowId;
          rows.push(
            buildModelChangeMarkerRow({
              rowId,
              turnId: `turn_model_${rowId}`,
              createdAt: entryTs,
              createdAtSeq: rowId,
              fromProvider: prevProvider || undefined,
              fromModel: prevModel || undefined,
              toProvider: parsed.provider,
              toModel: parsed.model,
              toThought: effectiveThought || "medium",
            }),
          );
        }
      }
      continue;
    }
    if (entryType === "compaction") {
      const rowId = ++nextRowId;
      const turnId = activeTurnId ?? `turn_compact_${rowId}`;
      const tokensBefore =
        typeof entry["tokensBefore"] === "number" ? entry["tokensBefore"] : undefined;
      rows.push(
        buildCompactionMarkerRow({
          rowId,
          turnId,
          createdAt: entryTs,
          createdAtSeq: rowId,
          origin: "auto",
          status: "success",
          tokensBefore,
        }),
      );
      continue;
    }
    if (entryType === "usage") {
      const entryUsage = readPiUsageRecord(entry["usage"]);
      if (entryUsage) {
        usage = accumulateSessionUsage(usage, entryUsage, contextWindowMax, {
          rows,
          modelPricing: activeModelCost,
        }).nextUsage;
      }
      continue;
    }
    if (entryType !== "message" || !isPiRecord(entry["message"])) continue;

    const msg = entry["message"];
    const role = msg["role"];
    const msgTs = parseIsoOrUnixTimestamp(msg["timestamp"], entryTs);
    if (msgTs > lastActivityAt) lastActivityAt = msgTs;

    if (role === "system" || role === "toolResult") continue;

    if (role === "compactionSummary") {
      const rowId = ++nextRowId;
      const turnId = activeTurnId ?? `turn_compact_${rowId}`;
      const tokensBefore =
        typeof msg["tokensBefore"] === "number" ? msg["tokensBefore"] : undefined;
      rows.push(
        buildCompactionMarkerRow({
          rowId,
          turnId,
          createdAt: msgTs,
          createdAtSeq: rowId,
          origin: "auto",
          status: "success",
          tokensBefore,
        }),
      );
      continue;
    }

    if (role === "user") {
      settleOpenTurnHeader();
      const text = readPiUserContentText(msg["content"]);
      const imageBlocks = readPiUserContentImages(msg["content"]);
      if (firstUserTitle === null) {
        const cleaned = cleanPiSessionTitle(text);
        if (cleaned) firstUserTitle = cleaned;
      }
      const entryKey = typeof entry["id"] === "string" ? entry["id"] : String(nextRowId + 1);
      const cmdId = `hydrated_${entryKey}`;
      const turnId = ensureTurnHeader(msgTs, cmdId);
      const userRowId = ++nextRowId;
      let attachments: AttachmentRef[] | undefined;
      if (imageBlocks.length > 0) {
        attachments = imageBlocks.map((img, idx) => {
          const ext =
            img.mimeType
              .split("/")[1]
              ?.split(";")[0]
              ?.replace(/[^a-z0-9]/gi, "") || "png";
          const fileName = `image-${idx + 1}.${ext}`;
          const ref = `pi-inline://${sessionId}/${entryKey}/${idx}`;
          const padding = img.data.endsWith("==") ? 2 : img.data.endsWith("=") ? 1 : 0;
          const bytes = Math.max(0, Math.floor((img.data.length * 3) / 4) - padding);
          inlineAttachments.push({
            ref,
            fileName,
            mime: img.mimeType,
            dataBase64: img.data,
          });
          return { ref, fileName, mime: img.mimeType, bytes };
        });
      }
      rows.push(
        buildUserInputRow({
          rowId: userRowId,
          turnId,
          createdAt: msgTs,
          createdAtSeq: userRowId,
          text,
          commandId: cmdId,
          clientId: "pi-hydrated",
          attachments,
        }),
      );
      activeTurnLastTs = msgTs;
      continue;
    }

    if (role === "bashExecution") {
      const turnId = ensureTurnHeader(msgTs);
      const command = typeof msg["command"] === "string" ? msg["command"] : "";
      const outputText = typeof msg["output"] === "string" ? msg["output"] : "";
      const cancelled = msg["cancelled"] === true;
      const exitCode = typeof msg["exitCode"] === "number" ? msg["exitCode"] : 0;
      const isError = !cancelled && exitCode !== 0;
      const built = buildPiToolOutput({
        rawToolName: "bash",
        canonicalToolName: "Bash",
        rawArgs: { command },
        result: {
          content: [{ type: "text", text: outputText }],
          details: { exitCode, truncated: msg["truncated"] === true },
        },
        isError,
      });
      const rowId = ++nextRowId;
      const bashRow: ToolCallRow = {
        ...buildToolCallRow({
          rowId,
          turnId,
          createdAt: msgTs,
          createdAtSeq: rowId,
          toolCallId: `bash_${rowId}`,
          toolName: "Bash",
          status: cancelled ? "cancelled" : isError ? "error" : "success",
          inputText: JSON.stringify({ command }),
          parsedInput: { command },
          startedAt: msgTs,
          endedAt: msgTs,
        }),
        output: built.output,
        ...(built.error ? { error: built.error } : {}),
      };
      rows.push(bashRow);
      activeTurnLastTs = msgTs;
      continue;
    }

    if (role !== "assistant") continue;

    const turnId = ensureTurnHeader(msgTs);
    responseCounter += 1;
    const responseId = `resp_${responseCounter}`;
    if (typeof msg["provider"] === "string" && msg["provider"].trim()) {
      effectiveProvider = msg["provider"].trim();
    }
    if (typeof msg["model"] === "string" && msg["model"].trim()) {
      effectiveModel = msg["model"].trim();
    }
    if (effectiveProvider && effectiveModel) {
      updateContextWindowForModel(effectiveProvider, effectiveModel);
    }

    const stopReason = typeof msg["stopReason"] === "string" ? msg["stopReason"] : "stop";
    const isAborted = stopReason === "aborted";
    const isFailed = stopReason === "error";
    const textState = isAborted ? "interrupted" : isFailed ? "failed" : "complete";
    if (isAborted) {
      activeTurnEndState = "completedInterrupted";
      lastPhase = "completedInterrupted";
    } else if (isFailed) {
      activeTurnEndState = "failed";
      lastPhase = "error";
    } else {
      activeTurnEndState = "completedSuccess";
      lastPhase = "completedSuccess";
    }

    const blocks = Array.isArray(msg["content"]) ? msg["content"] : [];
    let emittedAssistantText = false;
    for (const block of blocks) {
      if (!isPiRecord(block)) continue;
      const bType = block["type"];
      if (bType === "thinking") {
        const thinkingText =
          typeof block["thinking"] === "string" && block["thinking"].length > 0
            ? block["thinking"]
            : block["redacted"] === true
              ? "(Redacted thinking)"
              : "";
        if (!thinkingText) continue;
        const rowId = ++nextRowId;
        rows.push({
          ...buildReasoningRow({
            rowId,
            turnId,
            createdAt: msgTs,
            createdAtSeq: rowId,
            assistantResponseId: responseId,
          }),
          text: thinkingText,
          state: isAborted ? "interrupted" : "complete",
          durationMs: 1_000,
        });
      } else if (bType === "toolCall") {
        const toolCallId =
          typeof block["id"] === "string" && block["id"].trim()
            ? block["id"].trim()
            : `tool_${nextRowId + 1}`;
        const rawToolName = typeof block["name"] === "string" ? block["name"] : "Tool";
        const rawArgs = isPiRecord(block["arguments"]) ? block["arguments"] : {};
        const canonicalToolName = mapPiToolName(rawToolName);
        const canonicalInput = normalizePiToolInput(rawToolName, rawArgs, cwd);
        const paired = toolResultByCallId.get(toolCallId);
        const endTs = paired ? parseIsoOrUnixTimestamp(paired.timestamp, msgTs) : msgTs;
        if (endTs > activeTurnLastTs) activeTurnLastTs = endTs;
        if (endTs > lastActivityAt) lastActivityAt = endTs;

        const isToolError = Boolean(paired?.isError);
        const built = paired
          ? buildPiToolOutput({
              rawToolName,
              canonicalToolName,
              rawArgs,
              result: {
                content: paired.content,
                details: isPiRecord(paired.details) ? paired.details : undefined,
              },
              isError: isToolError,
            })
          : null;
        if (built && !isToolError && built.fileDiff) {
          recordHydratedFileDiff(turnFileChanges, canonicalToolName, built.fileDiff);
        }
        const status: ToolCallRow["status"] = paired
          ? isToolError
            ? "error"
            : "success"
          : isAborted
            ? "cancelled"
            : "error";
        const rowId = ++nextRowId;
        const toolRow: ToolCallRow = {
          ...buildToolCallRow({
            rowId,
            turnId,
            createdAt: msgTs,
            createdAtSeq: rowId,
            toolCallId,
            toolName: canonicalToolName,
            status,
            inputText: JSON.stringify(rawArgs),
            parsedInput: canonicalInput,
            assistantResponseId: responseId,
            startedAt: msgTs,
            endedAt: endTs,
          }),
          ...(built ? { output: built.output } : {}),
          ...(built?.error ? { error: built.error } : {}),
        };
        rows.push(toolRow);
      } else if (bType === "text") {
        const text = typeof block["text"] === "string" ? block["text"] : "";
        if (!text) continue;
        const rowId = ++nextRowId;
        rows.push(
          buildAssistantTextRow({
            rowId,
            turnId,
            createdAt: msgTs,
            createdAtSeq: rowId,
            text,
            state: textState,
            assistantResponseId: responseId,
            model: effectiveModel || undefined,
          }),
        );
        const preview = deriveAssistantPreview(text);
        if (preview) lastAssistantPreview = preview;
        emittedAssistantText = true;
      }
    }

    if (
      isFailed &&
      !emittedAssistantText &&
      typeof msg["errorMessage"] === "string" &&
      msg["errorMessage"].trim()
    ) {
      const rowId = ++nextRowId;
      rows.push(
        buildAssistantTextRow({
          rowId,
          turnId,
          createdAt: msgTs,
          createdAtSeq: rowId,
          text: msg["errorMessage"].trim(),
          state: "failed",
          assistantResponseId: responseId,
          model: effectiveModel || undefined,
        }),
      );
    }

    const msgUsage = readPiUsageRecord(msg["usage"]);
    if (msgUsage) {
      const updated = accumulateSessionUsage(usage, msgUsage, contextWindowMax, {
        rows,
        modelPricing: activeModelCost,
      });
      usage = updated.nextUsage;
      activeTurnOutputTokens += updated.addedOutputTokens;
    }
    if (msgTs > activeTurnLastTs) activeTurnLastTs = msgTs;
  }

  settleOpenTurnHeader();

  const config = createInitialSessionConfig({
    modelSelection:
      effectiveProvider && effectiveModel
        ? {
            providerId: effectiveProvider,
            modelId: effectiveModel,
            ...(effectiveThought ? { options: { reasoningLevel: effectiveThought } } : {}),
          }
        : undefined,
    catalogModels,
    defaultModel: input.defaultModel,
    defaultThinkingLevel: effectiveThought || input.defaultThinkingLevel,
  });

  const resolvedTitle = customTitle ?? firstUserTitle ?? "";
  const titleSource: "default" | "generated" | "custom" = customTitle ? "custom" : "default";

  return {
    sessionId,
    cwd,
    createdAt,
    lastActivityAt,
    title: resolvedTitle,
    titleSource,
    lastAssistantPreview,
    phase: lastPhase,
    config,
    contextWindowMax,
    usage,
    rows,
    fileChangesByTurnId,
    inlineAttachments,
  };
}
