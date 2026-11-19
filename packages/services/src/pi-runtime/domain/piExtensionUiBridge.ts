/**
 * Pi `extension_ui_request` <-> ZCode V4 `pendingInteractions` / `resolveInteraction` 纯映射桥（domain 层，0 IO）。
 *
 * 映射规则：
 * - `confirm` -> `kind: "permission"`（确认 / 取消双按钮）；
 * - `select` -> `kind: "userInput"`（单选选项列表 + `questions` 兼容 AskUserQuestion 卡片）；
 * - `input` / `editor` -> `kind: "userInput"`（`freeText: true`，携带 `placeholder`/`prefill`/`multiline`）；
 * - `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text` -> 非阻塞，不产生 `PendingInteraction`。
 */
import type {
  CommandPayloadMap,
  ConversationDelta,
  PendingInteraction,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  PiExtensionUiRequestEvent,
  PiExtensionUiResponsePayload,
} from "#src/pi-runtime/domain/piRpcTypes.js";

export type PiBlockingExtensionUiMethod = "select" | "confirm" | "input" | "editor";

export interface PiPendingExtensionUiMeta {
  readonly id: string;
  readonly method: PiBlockingExtensionUiMethod;
  readonly options: readonly string[];
}

export type ResolveInteractionAnswer = CommandPayloadMap["resolveInteraction"]["answer"];

function normalizePromptText(title: string | undefined, message: string | undefined): string {
  const t = title?.trim() ?? "";
  const m = message?.trim() ?? "";
  if (t && m && t !== m) return `${t}\n${m}`;
  return m || t || "Pi extension requested input";
}

/** 将 Pi 阻塞型 `extension_ui_request` 投影为严格通过 `pendingInteractionSchema` 的 ZCode 交互项。 */
export function mapPiExtensionUiRequestToInteraction(
  event: PiExtensionUiRequestEvent,
  nowMs: number,
  anchorRowId: number | null,
): { readonly meta: PiPendingExtensionUiMeta; readonly interaction: PendingInteraction } | null {
  const id = event.id?.trim();
  if (!id) return null;

  if (event.method === "confirm") {
    const summary = event.title?.trim() || event.message?.trim() || "Confirm action";
    const interaction: PendingInteraction = {
      interactionId: id,
      kind: "permission",
      anchorRowId,
      createdAt: nowMs,
      payload: {
        kind: "permission",
        toolCallId: id,
        toolName: "PiExtension",
        summary,
        detail: {
          title: event.title ?? summary,
          message: event.message ?? "",
        },
        options: [
          { optionId: "confirm", label: "确认", kind: "allowOnce" },
          { optionId: "cancel", label: "取消", kind: "deny" },
        ],
      },
    };
    return { meta: { id, method: "confirm", options: [] }, interaction };
  }

  if (event.method === "select") {
    const labels = Array.isArray(event.options)
      ? event.options.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    const title = event.title?.trim() || "请选择";
    const questionText = event.message?.trim() || title;
    const interaction: PendingInteraction = {
      interactionId: id,
      kind: "userInput",
      anchorRowId,
      createdAt: nowMs,
      payload: {
        kind: "userInput",
        prompt: normalizePromptText(event.title, event.message),
        freeText: false,
        options: labels.map((label, index) => ({ optionId: String(index), label })),
        questions: [
          {
            header: title,
            question: questionText,
            options: labels.map((label) => ({ value: label, label })),
            multiSelect: false,
          },
        ],
      },
    };
    return { meta: { id, method: "select", options: labels }, interaction };
  }

  if (event.method === "input" || event.method === "editor") {
    const method: PiBlockingExtensionUiMethod = event.method === "editor" ? "editor" : "input";
    const interaction: PendingInteraction = {
      interactionId: id,
      kind: "userInput",
      anchorRowId,
      createdAt: nowMs,
      payload: {
        kind: "userInput",
        prompt: normalizePromptText(event.title, event.message),
        freeText: true,
        input: {
          ...(event.placeholder !== undefined ? { placeholder: event.placeholder } : {}),
          ...(event.prefill !== undefined ? { prefill: event.prefill } : {}),
          multiline: method === "editor",
        },
      },
    };
    return { meta: { id, method, options: [] }, interaction };
  }

  return null;
}

function extractFirstAnswerValueFromContent(
  content: Record<string, unknown> | undefined,
): string | null {
  if (!content) return null;
  for (const val of Object.values(content)) {
    if (typeof val === "string" && val.trim() !== "") return val;
    if (Array.isArray(val)) {
      const first = val.find(
        (item): item is string => typeof item === "string" && item.trim() !== "",
      );
      if (first) return first;
    }
  }
  return null;
}

/** 将 ZCode `resolveInteraction` 应答映射回 Pi 原生 `extension_ui_response` 载荷。 */
export function buildPiExtensionUiResponseFromAnswer(
  meta: PiPendingExtensionUiMeta,
  answer: ResolveInteractionAnswer,
): PiExtensionUiResponsePayload {
  if (answer.action === "cancel") {
    return { id: meta.id, cancelled: true };
  }

  if (meta.method === "confirm") {
    if (answer.action === "decline" || answer.optionId === "cancel" || answer.optionId === "deny") {
      return { id: meta.id, confirmed: false };
    }
    return { id: meta.id, confirmed: true };
  }

  if (meta.method === "select") {
    if (answer.action === "decline") {
      return { id: meta.id, cancelled: true };
    }
    const fromContent = extractFirstAnswerValueFromContent(answer.content);
    if (fromContent !== null) {
      return { id: meta.id, value: fromContent };
    }
    if (answer.optionId !== undefined) {
      const idx = Number.parseInt(answer.optionId, 10);
      const byIndex =
        Number.isInteger(idx) && idx >= 0 && idx < meta.options.length
          ? meta.options[idx]
          : undefined;
      const value = byIndex ?? answer.optionId;
      return { id: meta.id, value };
    }
    if (answer.freeText !== undefined) {
      return { id: meta.id, value: answer.freeText };
    }
    return { id: meta.id, cancelled: true };
  }

  // input / editor
  if (answer.action === "decline") {
    return { id: meta.id, cancelled: true };
  }
  const text =
    answer.freeText ?? extractFirstAnswerValueFromContent(answer.content) ?? answer.optionId;
  if (text === undefined) {
    return { id: meta.id, cancelled: true };
  }
  return { id: meta.id, value: text };
}

export interface PendingExtensionUiStateLike {
  readonly pendingExtensionUiById: Map<string, PiPendingExtensionUiMeta>;
  readonly snapshot: { readonly pendingInteractions: readonly PendingInteraction[] };
}

/** 解析并从状态移除指定阻塞交互，产出应答载荷与 `pendingInteractions` 变更增量。 */
export function resolvePendingExtensionUiState(
  state: PendingExtensionUiStateLike,
  interactionId: string,
  answer: ResolveInteractionAnswer,
): {
  readonly response: PiExtensionUiResponsePayload;
  readonly deltas: ConversationDelta[];
} | null {
  const meta = state.pendingExtensionUiById.get(interactionId);
  if (!meta) return null;
  state.pendingExtensionUiById.delete(interactionId);
  const nextPending = state.snapshot.pendingInteractions.filter(
    (item) => item.interactionId !== interactionId,
  );
  return {
    response: buildPiExtensionUiResponseFromAnswer(meta, answer),
    deltas: [{ op: "state.updated", patch: { pendingInteractions: nextPending } }],
  };
}

/** 停止/释放会话时清空全部未决扩展交互并返回需向 Pi 回发取消的 id 列表。 */
export function drainPendingExtensionUiState(state: PendingExtensionUiStateLike): {
  readonly cancelledIds: string[];
  readonly deltas: ConversationDelta[];
} {
  const cancelledIds = [...state.pendingExtensionUiById.keys()];
  if (cancelledIds.length === 0 && state.snapshot.pendingInteractions.length === 0) {
    return { cancelledIds: [], deltas: [] };
  }
  state.pendingExtensionUiById.clear();
  return {
    cancelledIds,
    deltas: [{ op: "state.updated", patch: { pendingInteractions: [] } }],
  };
}
