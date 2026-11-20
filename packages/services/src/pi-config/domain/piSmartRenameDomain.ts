/**
 * Pi 智能重命名与会话标题落盘纯 domain 逻辑（零 Node IO / 零计时器）。
 */

export const DEFAULT_PI_SMART_RENAME_PROMPT = [
  "请根据以下对话上下文，为该会话生成一个简洁准确的标题。",
  "要求：",
  "1. 使用与用户主要语言一致的表达（中文 4-18 字，英文 3-7 词）；",
  "2. 精准概括核心任务、主题或问题，避免“你好”“帮我看看”等空泛词；",
  "3. 仅输出标题纯文本，不要包含引号、书名号、序号、Markdown 符号或任何解释。",
].join("\n");

const MAX_DEFAULT_CONTEXT_CHARS = 6_000;
const MAX_TITLE_CHARS = 48;

interface ParsedJsonlEntry {
  readonly id?: string | undefined;
  readonly parentId?: string | null | undefined;
  readonly type?: string | undefined;
  readonly message?: Record<string, unknown> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonlEntries(rawContent: string): ParsedJsonlEntry[] {
  const entries: ParsedJsonlEntry[] = [];
  for (const rawLine of rawContent.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        entries.push({
          id: typeof parsed["id"] === "string" ? parsed["id"] : undefined,
          parentId: typeof parsed["parentId"] === "string" ? parsed["parentId"] : null,
          type: typeof parsed["type"] === "string" ? parsed["type"] : undefined,
          message: isRecord(parsed["message"]) ? parsed["message"] : undefined,
        });
      }
    } catch {
      // 跳过损坏行
    }
  }
  return entries;
}

/** 查找 Pi v3 `.jsonl` 活动分支末节点 ID（用于追加 `session_info`）。 */
export function findActiveJsonlLeafId(rawContent: string): string | null {
  const entries = parseJsonlEntries(rawContent);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const id = entries[i]?.id;
    if (id) return id;
  }
  return null;
}

/** 追溯 Pi v3 `.jsonl` 活动分支节点（带环检测）。 */
function resolveActiveEntries(entries: readonly ParsedJsonlEntry[]): ParsedJsonlEntry[] {
  const byId = new Map<string, ParsedJsonlEntry>();
  let leaf: ParsedJsonlEntry | null = null;
  for (const entry of entries) {
    if (entry.type === "session") continue;
    if (entry.id) {
      byId.set(entry.id, entry);
      leaf = entry;
    }
  }
  if (!leaf) return entries.filter((e) => e.type !== "session");
  const chain: ParsedJsonlEntry[] = [];
  const visited = new Set<string>();
  let cursor: ParsedJsonlEntry | undefined = leaf;
  while (cursor) {
    if (cursor.id) {
      if (visited.has(cursor.id)) break;
      visited.add(cursor.id);
    }
    chain.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return chain.reverse();
}

function summarizeContentBlocks(content: unknown, maxSegmentChars: number): string {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim().slice(0, maxSegmentChars);
  }
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  const tools: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      const cleaned = block["text"].replace(/\s+/g, " ").trim();
      if (cleaned) parts.push(cleaned);
    } else if (block["type"] === "toolCall" && typeof block["name"] === "string") {
      tools.push(block["name"]);
    } else if (block["type"] === "image") {
      parts.push("[image]");
    }
  }
  const textPart = parts.join(" ").trim().slice(0, maxSegmentChars);
  const toolPart = tools.length > 0 ? `[tools: ${[...new Set(tools)].slice(0, 6).join(", ")}]` : "";
  return [textPart, toolPart].filter(Boolean).join(" ").trim();
}

function sampleTranscriptLines(lines: readonly string[], maxChars: number): string {
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = Math.max(200, maxChars - headBudget - 32);
  const head: string[] = [];
  let headLen = 0;
  let headIdx = 0;
  while (headIdx < lines.length) {
    const line = lines[headIdx]!;
    if (headLen + line.length + 1 > headBudget && head.length > 0) break;
    head.push(line);
    headLen += line.length + 1;
    headIdx += 1;
  }
  const tail: string[] = [];
  let tailLen = 0;
  for (let i = lines.length - 1; i >= headIdx; i -= 1) {
    const line = lines[i]!;
    if (tailLen + line.length + 1 > tailBudget && tail.length > 0) break;
    tail.unshift(line);
    tailLen += line.length + 1;
  }
  return [...head, "...(中间对话已省略)...", ...tail].join("\n").slice(0, maxChars);
}

/** 从 Pi `.jsonl` 活动分支提取紧凑上下文摘要供智能重命名模型阅读。 */
export function extractSmartRenameContextFromJsonl(
  rawContent: string,
  maxChars: number = MAX_DEFAULT_CONTEXT_CHARS,
): string {
  const active = resolveActiveEntries(parseJsonlEntries(rawContent));
  const lines: string[] = [];
  for (const entry of active) {
    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message["role"];
    if (role === "user") {
      const summary = summarizeContentBlocks(entry.message["content"], 800);
      if (summary) lines.push(`User: ${summary}`);
    } else if (role === "assistant") {
      const summary = summarizeContentBlocks(entry.message["content"], 600);
      if (summary) lines.push(`Assistant: ${summary}`);
    }
  }
  return sampleTranscriptLines(lines, maxChars);
}

/** 当 `.jsonl` 尚未落盘时，从内存会话快照消息提取紧凑上下文摘要。 */
export function extractSmartRenameContextFromMessages(
  messages: ReadonlyArray<{ readonly role: string; readonly text?: string | undefined }>,
  maxChars: number = MAX_DEFAULT_CONTEXT_CHARS,
): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const cleaned = (msg.text ?? "").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    if (msg.role === "user") {
      lines.push(`User: ${cleaned.slice(0, 800)}`);
    } else if (msg.role === "assistant") {
      lines.push(`Assistant: ${cleaned.slice(0, 600)}`);
    }
  }
  return sampleTranscriptLines(lines, maxChars);
}

/** 将用户提示词模板与会话上下文拼装成发给 Pi 的最终输入文本。 */
export function buildSmartRenamePromptText(template: string | undefined, context: string): string {
  const effectiveTemplate = (template ?? "").trim() || DEFAULT_PI_SMART_RENAME_PROMPT;
  if (effectiveTemplate.includes("{{context}}")) {
    return effectiveTemplate.replace(/\{\{context\}\}/g, context);
  }
  return `${effectiveTemplate}\n\n<conversation>\n${context}\n</conversation>`;
}

/** 清洗 LLM 返回的标题文本（剔除思维链、引号、Markdown 装饰、换行并限长）。 */
export function sanitizeSmartRenameTitle(rawOutput: string): string {
  const withoutThink = rawOutput.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  const withoutFences = withoutThink.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/^```[^\n]*\n?/, "").replace(/```$/, ""),
  );
  const firstNonEmptyLine =
    withoutFences
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  let cleaned = firstNonEmptyLine
    .replace(/^(?:标题|会话标题|话题标题|新标题|Title|Session Title)\s*[:：]\s*/i, "")
    .replace(/^#+\s*/, "")
    .replace(/^\*+|\*+$/g, "")
    .replace(/^`+|`+$/g, "")
    .trim();

  // 剥离成对首尾引号/书名号
  const quotePairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["「", "」"],
    ["『", "』"],
    ["《", "》"],
    ["【", "】"],
  ];
  for (const [open, close] of quotePairs) {
    if (
      cleaned.startsWith(open) &&
      cleaned.endsWith(close) &&
      cleaned.length > open.length + close.length
    ) {
      cleaned = cleaned.slice(open.length, cleaned.length - close.length).trim();
    }
  }

  cleaned = cleaned
    .replace(/\s+/g, " ")
    .replace(/[。！!？?；;，,]+$/, "")
    .trim();
  if (cleaned.length > MAX_TITLE_CHARS) {
    cleaned = cleaned.slice(0, MAX_TITLE_CHARS).trim();
  }
  return cleaned;
}

/** 构造标准 Pi v3 `session_info` 命名记录（供离线改名原子追加到 `.jsonl` 尾部）。 */
export function buildPiSessionInfoJsonlLine(params: {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestampIso: string;
  readonly title: string;
}): string {
  return JSON.stringify({
    type: "session_info",
    id: params.id,
    parentId: params.parentId,
    timestamp: params.timestampIso,
    name: params.title,
  });
}
