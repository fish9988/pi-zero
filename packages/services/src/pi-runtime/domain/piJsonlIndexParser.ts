/**
 * Pi v3 `.jsonl` 会话文件前缀/尾部快速索引解析与标题清洗（纯 domain 层，无 Node IO/计时器）。
 * 规则与 pi-studio `session-index.ts` 及 `clean-title.ts` 对齐：
 * - 始终以 JSONL header (`type: "session"`) 中的 `cwd` 和 `id` 为权威，绝不从桶目录名反推；
 * - 忽略截断行与损坏行，空壳文件（无标题且无首条用户消息）返回 null。
 */
import type { SessionPhase, SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { isPiRecord } from "#src/pi-runtime/domain/piRpcTypes.js";
import { deriveAssistantPreview } from "#src/pi-runtime/domain/piSnapshotFactory.js";

const MAX_TITLE_CHARS = 80;
const ICON_GLYPHS_RE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
const WRAPPER_BLOCKS_RE =
  /<(t3_code_instructions|runtime_info|pull_request_linking|system-reminder|ADDITIONAL_METADATA|CONTEXT_SUMMARY)\b[^>]*>[\s\S]*?<\/\1>/gi;
const USER_REQUEST_TAG_RE = /<\/?USER_REQUEST\b[^>]*>/gi;
const DANGLING_WRAPPER_PREFIX_RE =
  /^\s*<(?:t3_code_instructions|runtime_info|pull_request_linking|system-reminder|ADDITIONAL_METADATA|CONTEXT_SUMMARY)\b[^>]*>[\s\S]*$/i;

/** 清洗会话标题：剥离 Nerd Font 私用区图标与宿主 XML 包裹块，取首个非空行并限长 80 字符。 */
export function cleanPiSessionTitle(text: string): string {
  const unwrapped = text
    .replace(WRAPPER_BLOCKS_RE, " ")
    .replace(USER_REQUEST_TAG_RE, " ")
    .replace(ICON_GLYPHS_RE, "");
  const trimmed = unwrapped.trim();
  if (!trimmed || DANGLING_WRAPPER_PREFIX_RE.test(trimmed)) return "";
  const firstLine = trimmed
    .split(/\r?\n/u)
    .map((line) =>
      line
        .replace(/\p{Cc}/gu, " ")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  if (firstLine.length <= MAX_TITLE_CHARS) return firstLine;
  return `${firstLine.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

export function parseIsoOrUnixTimestamp(value: unknown, fallbackMs: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return Math.max(0, Math.trunc(fallbackMs));
}

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (isPiRecord(item) && item["type"] === "text" && typeof item["text"] === "string") {
      parts.push(item["text"]);
    }
  }
  return parts.join("\n");
}

function extractUserPromptTitle(entry: Record<string, unknown>): string | null {
  const message = entry["message"];
  if (!isPiRecord(message) || message["role"] !== "user") return null;
  const raw = extractTextFromMessageContent(message["content"]);
  const cleaned = cleanPiSessionTitle(raw);
  return cleaned.length > 0 ? cleaned : null;
}

export interface ParsedPiSessionPrefix {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly title: string | null;
  readonly titleSource: "custom" | "default";
  readonly firstPrompt: string | null;
}

/**
 * 解析会话文件前缀：
 * `truncated = true` 时丢弃可能被字节截断的末行；找不到合法 `type: "session"` 头返回 null。
 */
export function parsePiSessionPrefix(
  text: string,
  truncated: boolean,
  fallbackMtimeMs: number,
): ParsedPiSessionPrefix | null {
  const lines = text.split("\n");
  if (truncated) lines.pop();

  let slotTitle: string | null = null;
  let infoTitle: string | null = null;
  let header: Record<string, unknown> | null = null;
  let firstPrompt: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (header === null) return null;
      continue;
    }
    if (!isPiRecord(parsed)) continue;

    if (header === null) {
      if (parsed["type"] === "title") {
        if (typeof parsed["title"] === "string") {
          const cleaned = cleanPiSessionTitle(parsed["title"]);
          if (cleaned) slotTitle = cleaned;
        }
        continue;
      }
      if (parsed["type"] !== "session") return null;
      header = parsed;
      continue;
    }

    if (parsed["type"] === "session_info" && typeof parsed["name"] === "string") {
      const cleaned = cleanPiSessionTitle(parsed["name"]);
      if (cleaned) infoTitle = cleaned;
    } else if (parsed["type"] === "title_change" && typeof parsed["title"] === "string") {
      const cleaned = cleanPiSessionTitle(parsed["title"]);
      if (cleaned) infoTitle = cleaned;
    }
    if (parsed["type"] === "message" && firstPrompt === null) {
      firstPrompt = extractUserPromptTitle(parsed);
    }
  }

  if (header === null) return null;
  const id = typeof header["id"] === "string" ? header["id"].trim() : "";
  const cwd = typeof header["cwd"] === "string" ? header["cwd"].trim() : "";
  if (!id || !cwd) return null;

  const headerTitle =
    typeof header["title"] === "string" ? cleanPiSessionTitle(header["title"]) || null : null;
  const createdAt = parseIsoOrUnixTimestamp(header["timestamp"], fallbackMtimeMs);
  const customTitle = infoTitle ?? slotTitle ?? headerTitle;
  return {
    id,
    cwd,
    createdAt,
    title: customTitle,
    titleSource: customTitle ? "custom" : "default",
    firstPrompt,
  };
}

export interface ParsedPiSessionSuffix {
  readonly tailTitle: string | null;
  readonly lastActivityAt: number;
  readonly phase: SessionPhase;
  readonly lastOutcome: SessionSummary["lastOutcome"];
  readonly lastAssistantPreview: string | undefined;
}

function classifyTailMessage(message: Record<string, unknown>): {
  phase: SessionPhase;
  lastOutcome: SessionSummary["lastOutcome"];
} {
  const role = message["role"];
  if (role === "assistant") {
    const reason = message["stopReason"];
    if (reason === "error") return { phase: "error", lastOutcome: "error" };
    if (reason === "aborted" || reason === "length") {
      return { phase: "completedInterrupted", lastOutcome: "interrupted" };
    }
    const content = message["content"];
    const hasToolCall =
      Array.isArray(content) &&
      content.some((part) => isPiRecord(part) && part["type"] === "toolCall");
    if (hasToolCall) return { phase: "completedInterrupted", lastOutcome: "interrupted" };
    return { phase: "completedSuccess", lastOutcome: "completed" };
  }
  if (role === "toolResult") {
    return { phase: "completedInterrupted", lastOutcome: "interrupted" };
  }
  return { phase: "completedSuccess", lastOutcome: "completed" };
}

/** 解析会话文件末尾段：捕获最新 `session_info` 重命名、末轮状态与助手摘要。 */
export function parsePiSessionSuffix(
  text: string,
  truncated: boolean,
  fallbackMtimeMs: number,
): ParsedPiSessionSuffix {
  const lines = text.split("\n");
  if (truncated) lines.shift();

  let tailTitle: string | null = null;
  let lastActivityAt = Math.max(0, Math.trunc(fallbackMtimeMs));
  let hasTimestamp = false;
  let phase: SessionPhase = "completedSuccess";
  let lastOutcome: SessionSummary["lastOutcome"] = "completed";
  let hasMessageOutcome = false;
  let lastAssistantPreview: string | undefined;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPiRecord(parsed)) continue;

    if (!hasTimestamp && parsed["timestamp"] !== undefined) {
      lastActivityAt = parseIsoOrUnixTimestamp(parsed["timestamp"], fallbackMtimeMs);
      hasTimestamp = true;
    }
    if (tailTitle === null) {
      if (parsed["type"] === "session_info" && typeof parsed["name"] === "string") {
        const cleaned = cleanPiSessionTitle(parsed["name"]);
        if (cleaned) tailTitle = cleaned;
      } else if (parsed["type"] === "title_change" && typeof parsed["title"] === "string") {
        const cleaned = cleanPiSessionTitle(parsed["title"]);
        if (cleaned) tailTitle = cleaned;
      }
    }
    if (parsed["type"] === "message" && isPiRecord(parsed["message"])) {
      const msg = parsed["message"];
      if (!hasMessageOutcome && msg["role"] !== "system") {
        const classified = classifyTailMessage(msg);
        phase = classified.phase;
        lastOutcome = classified.lastOutcome;
        hasMessageOutcome = true;
        if (!hasTimestamp && msg["timestamp"] !== undefined) {
          lastActivityAt = parseIsoOrUnixTimestamp(msg["timestamp"], fallbackMtimeMs);
          hasTimestamp = true;
        }
      }
      if (lastAssistantPreview === undefined && msg["role"] === "assistant") {
        const preview = deriveAssistantPreview(extractTextFromMessageContent(msg["content"]));
        if (preview) lastAssistantPreview = preview;
      }
    }
  }

  return {
    tailTitle,
    lastActivityAt,
    phase,
    lastOutcome,
    lastAssistantPreview,
  };
}

export interface ExtractPiSessionIndexSummaryInput {
  readonly prefixText: string;
  readonly prefixTruncated: boolean;
  readonly suffixText: string;
  readonly suffixTruncated: boolean;
  readonly fallbackMtimeMs: number;
  readonly workspaceId: string;
}

export interface ExtractedPiSessionIndexItem {
  readonly sessionId: string;
  readonly cwd: string;
  readonly summary: SessionSummary;
}

/** 组合前缀与后缀采样，生成无需加载整文件的 `SessionSummary`；空壳文件返回 null。 */
export function extractPiSessionIndexSummary(
  input: ExtractPiSessionIndexSummaryInput,
): ExtractedPiSessionIndexItem | null {
  const head = parsePiSessionPrefix(input.prefixText, input.prefixTruncated, input.fallbackMtimeMs);
  if (!head) return null;
  const tail = parsePiSessionSuffix(input.suffixText, input.suffixTruncated, input.fallbackMtimeMs);

  const resolvedTitle = tail.tailTitle ?? head.title ?? head.firstPrompt ?? "";
  if (!resolvedTitle) return null;
  const titleSource: SessionSummary["titleSource"] =
    tail.tailTitle || head.titleSource === "custom" ? "custom" : "default";
  const lastActivityAt = Math.max(head.createdAt, tail.lastActivityAt);

  return {
    sessionId: head.id,
    cwd: head.cwd,
    summary: {
      sessionId: head.id,
      workspaceId: input.workspaceId,
      title: resolvedTitle,
      titleSource,
      ...(tail.lastOutcome ? { lastOutcome: tail.lastOutcome } : {}),
      phase: tail.phase,
      sessionEnded: true,
      hasBackgroundWork: false,
      lastActivityAt,
      ...(tail.lastAssistantPreview ? { lastAssistantPreview: tail.lastAssistantPreview } : {}),
      createdAt: head.createdAt,
    },
  };
}
