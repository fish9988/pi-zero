/**
 * Pi v1.5.2 内置工具 / 扩展工具 / MCP 工具 -> ZCode V4 `ToolCallRow` 规范化映射器（纯 domain 层）。
 *
 * 严格零 Node IO、零计时器：
 * - 名称映射严格对齐 ZCode `resolveToolCallIdentity` & `ToolCallBlocks` 智能聚合桶；
 * - 流式 `toolcall_delta` 增量解析半截 JSON 提取 `command` / `file_path` / `pattern`，
 *   避免 `shouldDeferUnclassifiedShellToolCall` 隐藏运行中的 Bash 卡片；
 * - 终态输出严格满足 `toolResultDisplaySchema`（`file_diff` / `bash_output` / `mcp_tool`）
 *   与 `executionOutputPreviewSchema`（<= 4096 字符）。
 */
import type {
  ExecutionOutputPreview,
  ToolOutput,
  ToolResultDisplay,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildEditFileDiffDisplay,
  buildWriteFileDiffDisplay,
  extractPiEditPairs,
  type PiFileDiffDisplay,
} from "#src/pi-runtime/domain/piEditDiffMapper.js";

const BASH_OUTPUT_MAX_CHARS = 150_000;
const EXECUTION_PREVIEW_MAX_CHARS = 4_096;
const ERROR_MESSAGE_MAX_CHARS = 2_000;
const MCP_NAME_MAX_CHARS = 256;

const CANONICAL_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  bash: "Bash",
  powershell: "Bash",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
  subagent: "Agent",
  task: "Agent",
  agent: "Agent",
  invoke_subagent: "Agent",
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

function readRawString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "string") return val;
  }
  return undefined;
}

function readFiniteNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
  }
  return undefined;
}

/** 纯 JS 计算字符串 UTF-8 字节数（避免在 domain 层引入 node:buffer）。 */
function measureUtf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function mapPiToolName(rawToolName: string): string {
  const trimmed = rawToolName.trim();
  const mapped = CANONICAL_TOOL_NAME_MAP[trimmed.toLowerCase()];
  return mapped ?? (trimmed || "Tool");
}

export function parseMcpToolIdentity(
  rawToolName: string,
): { readonly serverName: string; readonly toolName: string } | undefined {
  const trimmed = rawToolName.trim();
  const doubleUnderscore = /^mcp__([^_][^]*?)__(.+)$/i.exec(trimmed);
  if (doubleUnderscore) {
    const serverName = doubleUnderscore[1]?.trim().slice(0, MCP_NAME_MAX_CHARS) ?? "";
    const toolName = doubleUnderscore[2]?.trim().slice(0, MCP_NAME_MAX_CHARS) ?? "";
    if (serverName && toolName) return { serverName, toolName };
  }
  const colonSlash = /^mcp[:/]([^:/]+)[:/](.+)$/i.exec(trimmed);
  if (colonSlash) {
    const serverName = colonSlash[1]?.trim().slice(0, MCP_NAME_MAX_CHARS) ?? "";
    const toolName = colonSlash[2]?.trim().slice(0, MCP_NAME_MAX_CHARS) ?? "";
    if (serverName && toolName) return { serverName, toolName };
  }
  const singleUnderscore = /^mcp_([a-zA-Z0-9-]+)_(.+)$/i.exec(trimmed);
  if (singleUnderscore) {
    const serverName = singleUnderscore[1]?.trim().slice(0, MCP_NAME_MAX_CHARS) ?? "";
    const toolName = singleUnderscore[2]?.trim().slice(0, MCP_NAME_MAX_CHARS) ?? "";
    if (serverName && toolName) return { serverName, toolName };
  }
  return undefined;
}

/**
 * 将 Pi 工具原始参数规范化为 ZCode `ToolCallBlocks` 识别的 canonical `input` 对象。
 * 保证 Read/Edit/Write/Bash/Grep/Glob(find+ls) 各自命中原生卡片渲染器与智能聚合桶。
 */
export function normalizePiToolInput(
  rawToolName: string,
  rawArgs: unknown,
  workspacePath?: string,
): Record<string, unknown> | undefined {
  const args = isPlainRecord(rawArgs) ? rawArgs : undefined;
  const lower = rawToolName.trim().toLowerCase();

  if (lower === "read") {
    if (!args) return undefined;
    const path = readTrimmedString(args, ["path", "file_path", "filePath"]);
    if (!path) return { ...args };
    const offset = readFiniteNumber(args, ["offset"]);
    const limit = readFiniteNumber(args, ["limit"]);
    return {
      file_path: path,
      path,
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  if (lower === "edit") {
    if (!args) return undefined;
    const path = readTrimmedString(args, ["path", "file_path", "filePath"]);
    const pairs = extractPiEditPairs(args);
    const oldString = pairs.map((pair) => pair.oldText).join("\n---\n");
    const newString = pairs.map((pair) => pair.newText).join("\n---\n");
    return {
      ...(path ? { file_path: path, path } : {}),
      ...(pairs.length > 0 ? { old_string: oldString, new_string: newString } : {}),
      ...(Array.isArray(args.edits) ? { edits: args.edits } : {}),
    };
  }

  if (lower === "write") {
    if (!args) return undefined;
    const path = readTrimmedString(args, ["path", "file_path", "filePath"]);
    const content = readRawString(args, ["content"]);
    return {
      ...(path ? { file_path: path, path } : {}),
      ...(content !== undefined ? { content } : {}),
    };
  }

  if (lower === "bash" || lower === "powershell") {
    if (!args) return undefined;
    const command = readTrimmedString(args, ["command", "cmd", "script"]);
    const description = readTrimmedString(args, ["description"]);
    if (!command && !description) return undefined;
    return {
      ...(command ? { command } : {}),
      ...(description ? { description } : {}),
    };
  }

  if (lower === "grep") {
    if (!args) return undefined;
    const pattern = readTrimmedString(args, ["pattern", "query"]);
    const path = readTrimmedString(args, ["path", "file_path"]);
    const glob = readTrimmedString(args, ["glob"]);
    return {
      ...(pattern ? { pattern } : {}),
      ...(path ? { path } : {}),
      ...(glob ? { glob } : {}),
    };
  }

  if (lower === "find") {
    if (!args) return undefined;
    const pattern = readTrimmedString(args, ["pattern", "glob", "query"]);
    const path = readTrimmedString(args, ["path"]);
    return {
      ...(pattern ? { pattern } : {}),
      ...(path ? { path } : {}),
    };
  }

  if (lower === "ls") {
    const path = args ? readTrimmedString(args, ["path", "cwd"]) : undefined;
    const cwd = path || workspacePath?.trim() || ".";
    return {
      parsed_cmd: [{ type: "list_files" }],
      cwd,
      ...(path ? { path } : {}),
    };
  }

  if (
    lower === "subagent" ||
    lower === "task" ||
    lower === "agent" ||
    lower === "invoke_subagent"
  ) {
    if (!args) return { subagent_type: "subagent", description: "Subagent" };
    const parallelTasks = Array.isArray(args["tasks"]) ? args["tasks"] : null;
    const chainSteps = Array.isArray(args["chain"]) ? args["chain"] : null;
    if (parallelTasks && parallelTasks.length > 0) {
      const first = isPlainRecord(parallelTasks[0]) ? parallelTasks[0] : undefined;
      const firstAgent =
        (first && readTrimmedString(first, ["agent", "subagent_type"])) || "parallel";
      const names = parallelTasks
        .map((item) =>
          isPlainRecord(item) ? readTrimmedString(item, ["agent", "subagent_type"]) : undefined,
        )
        .filter((name): name is string => Boolean(name))
        .join(", ");
      return {
        ...args,
        subagent_type: firstAgent,
        description: `并行 ${parallelTasks.length} 个子代理${names ? ` · ${names}` : ""}`,
      };
    }
    if (chainSteps && chainSteps.length > 0) {
      const first = isPlainRecord(chainSteps[0]) ? chainSteps[0] : undefined;
      const firstAgent = (first && readTrimmedString(first, ["agent", "subagent_type"])) || "chain";
      const firstTask = first
        ? readTrimmedString(first, ["task", "prompt", "description"])
        : undefined;
      return {
        ...args,
        subagent_type: firstAgent,
        description: `链式 ${chainSteps.length} 步${firstTask ? ` · ${firstTask.slice(0, 64)}` : ""}`,
      };
    }
    const agentName =
      readTrimmedString(args, ["agent", "subagent_type", "subagentType", "role"]) ?? "subagent";
    const task = readTrimmedString(args, ["task", "prompt", "description"]);
    const firstLine = task
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return {
      ...args,
      subagent_type: agentName,
      description: firstLine ? firstLine.slice(0, 84) : agentName,
      ...(task ? { prompt: task } : {}),
    };
  }

  return args ? { ...args } : undefined;
}

/**
 * 从半截 JSON 参数文本中增量提取关键字符串字段（例如 `"command":"pnpm...`、`"path":"src/...`）。
 * 用于 `toolcall_delta` 流式期间提前填充 `input`，防止 `shouldDeferUnclassifiedShellToolCall` 隐藏 Bash 卡片。
 */
function extractPartialJsonStringField(inputText: string, fieldName: string): string | undefined {
  const token = `"${fieldName}"`;
  let searchFrom = 0;
  while (searchFrom < inputText.length) {
    const keyIdx = inputText.indexOf(token, searchFrom);
    if (keyIdx < 0) return undefined;
    let cursor = keyIdx + token.length;
    while (cursor < inputText.length && /\s/.test(inputText.charAt(cursor))) cursor += 1;
    if (inputText.charAt(cursor) !== ":") {
      searchFrom = keyIdx + token.length;
      continue;
    }
    cursor += 1;
    while (cursor < inputText.length && /\s/.test(inputText.charAt(cursor))) cursor += 1;
    if (inputText.charAt(cursor) !== '"') {
      searchFrom = keyIdx + token.length;
      continue;
    }
    cursor += 1;
    let decoded = "";
    while (cursor < inputText.length) {
      const ch = inputText.charAt(cursor);
      if (ch === '"') return decoded;
      if (ch === "\\") {
        if (cursor + 1 >= inputText.length) return decoded;
        const esc = inputText.charAt(cursor + 1);
        if (esc === "n") decoded += "\n";
        else if (esc === "r") decoded += "\r";
        else if (esc === "t") decoded += "\t";
        else if (esc === '"' || esc === "\\" || esc === "/") decoded += esc;
        else if (esc === "u" && cursor + 5 < inputText.length) {
          const hex = inputText.slice(cursor + 2, cursor + 6);
          const code = Number.parseInt(hex, 16);
          if (Number.isFinite(code)) {
            decoded += String.fromCharCode(code);
            cursor += 4;
          }
        }
        cursor += 2;
        continue;
      }
      decoded += ch;
      cursor += 1;
    }
    return decoded;
  }
  return undefined;
}

export function extractPartialPiToolArgs(
  rawToolName: string,
  inputText: string,
  workspacePath?: string,
): Record<string, unknown> | undefined {
  const trimmed = inputText.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isPlainRecord(parsed)) {
      return normalizePiToolInput(rawToolName, parsed, workspacePath);
    }
  } catch {
    // 流式半截 JSON，回落字段级安全提取。
  }

  const partial: Record<string, unknown> = {};
  for (const field of ["command", "description", "path", "file_path", "pattern", "glob", "query"]) {
    const val = extractPartialJsonStringField(trimmed, field);
    if (val !== undefined && val.trim().length > 0) {
      partial[field] = val;
    }
  }
  if (Object.keys(partial).length === 0) return undefined;
  return normalizePiToolInput(rawToolName, partial, workspacePath);
}

/** 从 Pi `result` / `partialResult` 提取纯文本输出（兼容 MCP `text`/`resource`/`image`/JSON 块）。 */
export function extractPiToolResultText(
  result:
    | {
        readonly content?: readonly unknown[] | undefined;
        readonly details?: Record<string, unknown> | undefined;
      }
    | undefined,
): string {
  if (!result) return "";
  const chunks: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (typeof block === "string") {
        if (block.length > 0) chunks.push(block);
        continue;
      }
      if (!isPlainRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        chunks.push(block.text);
      } else if (block.type === "resource" && isPlainRecord(block.resource)) {
        const resText = block.resource.text;
        const resUri = block.resource.uri;
        if (typeof resText === "string" && resText.length > 0) chunks.push(resText);
        else if (typeof resUri === "string" && resUri.length > 0)
          chunks.push(`[resource: ${resUri}]`);
      } else if (block.type === "image") {
        const mime = typeof block.mimeType === "string" ? block.mimeType : "image";
        chunks.push(`[image: ${mime}]`);
      } else {
        try {
          chunks.push(JSON.stringify(block, null, 2));
        } catch {
          // 忽略不可序列化对象。
        }
      }
    }
  }
  if (chunks.length > 0) return chunks.join("\n");
  const fallbackOutput = result.details?.output;
  if (typeof fallbackOutput === "string") return fallbackOutput;
  if (isPlainRecord(result.details) && Object.keys(result.details).length > 0) {
    try {
      return JSON.stringify(result.details, null, 2);
    } catch {
      return "";
    }
  }
  return "";
}

/** 构造严格符合 `executionOutputPreviewSchema`（<= 4096 字符）的流式执行预览。 */
export function buildExecutionOutputPreview(text: string): ExecutionOutputPreview | undefined {
  if (text.length === 0) return undefined;
  const truncated = text.length > EXECUTION_PREVIEW_MAX_CHARS;
  const bounded = truncated ? text.slice(text.length - EXECUTION_PREVIEW_MAX_CHARS) : text;
  const totalLines = text.split("\n").length;
  return {
    text: bounded,
    fullText: bounded,
    totalLines,
    totalBytes: measureUtf8Bytes(text),
    linesEstimated: truncated,
  };
}

export interface PiToolOutputBuildResult {
  readonly output: ToolOutput;
  readonly fileDiff?: PiFileDiffDisplay | undefined;
  readonly error?: { readonly code: string; readonly message: string } | undefined;
}

/** 构造工具终态 `output`（含合法 `display`）与失败态 `error`。 */
export function buildPiToolOutput(input: {
  rawToolName: string;
  canonicalToolName: string;
  rawArgs?: Record<string, unknown> | undefined;
  result?: {
    readonly content?: readonly unknown[] | undefined;
    readonly details?: Record<string, unknown> | undefined;
  };
  isError: boolean;
}): PiToolOutputBuildResult {
  const text = extractPiToolResultText(input.result);
  const details = input.result?.details;
  const lower = input.rawToolName.trim().toLowerCase();

  let display: ToolResultDisplay | undefined;
  let fileDiff: PiFileDiffDisplay | undefined;

  if (lower === "bash" || lower === "powershell") {
    const truncatedByLen = text.length > BASH_OUTPUT_MAX_CHARS;
    const truncationObj = isPlainRecord(details?.truncation) ? details.truncation : undefined;
    const truncatedByDetails = truncationObj?.truncated === true || details?.truncated === true;
    const fullOutputPath =
      typeof details?.fullOutputPath === "string" && details.fullOutputPath.trim().length > 0
        ? details.fullOutputPath.trim().slice(0, 32_768)
        : undefined;
    display = {
      kind: "bash_output",
      output: truncatedByLen ? text.slice(0, BASH_OUTPUT_MAX_CHARS) : text,
      truncated: truncatedByLen || truncatedByDetails,
      ...(fullOutputPath ? { outputPath: fullOutputPath } : {}),
    };
  } else if (lower === "edit" && !input.isError) {
    const filePath = input.rawArgs
      ? readTrimmedString(input.rawArgs, ["path", "file_path", "filePath"])
      : undefined;
    if (filePath) {
      fileDiff = buildEditFileDiffDisplay({ filePath, args: input.rawArgs, details });
      display = fileDiff;
    }
  } else if (lower === "write" && !input.isError) {
    const filePath = input.rawArgs
      ? readTrimmedString(input.rawArgs, ["path", "file_path", "filePath"])
      : undefined;
    const content = input.rawArgs ? readRawString(input.rawArgs, ["content"]) : undefined;
    if (filePath && content !== undefined) {
      fileDiff = buildWriteFileDiffDisplay(filePath, content);
      display = fileDiff;
    }
  } else {
    const mcp = parseMcpToolIdentity(input.rawToolName);
    if (mcp) {
      display = {
        kind: "mcp_tool",
        serverName: mcp.serverName,
        toolName: mcp.toolName,
      };
    }
  }

  let error: { readonly code: string; readonly message: string } | undefined;
  if (input.isError) {
    const exitCode = details ? readFiniteNumber(details, ["exitCode"]) : undefined;
    const code = exitCode !== undefined ? `exit_${Math.trunc(exitCode)}` : "tool_error";
    const trimmedMessage = text.trim().slice(0, ERROR_MESSAGE_MAX_CHARS);
    error = {
      code,
      message: trimmedMessage || `Tool ${input.canonicalToolName} failed`,
    };
  }

  return {
    output: {
      text,
      ...(display ? { display } : {}),
    },
    ...(fileDiff ? { fileDiff } : {}),
    ...(error ? { error } : {}),
  };
}
