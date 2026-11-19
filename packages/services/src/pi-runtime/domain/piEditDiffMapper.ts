/**
 * Pi edit / write 工具变更差异 -> ZCode V4 `file_diff`（toolResultDisplaySchema）纯转换器。
 * 严格纯 domain 层（无 Node IO、无计时器），保证输出始终满足 toolResultDisplaySchema 校验，
 * 绝不触发信封层 `.catch(undefined)` 静默丢弃。
 */
import type { ToolResultDisplay } from "@zcode/shared/zcode-protocol-v4";

export interface StructuredDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: string[];
}

export type PiFileDiffDisplay = Extract<ToolResultDisplay, { kind: "file_diff" }>;

export interface PiEditPair {
  readonly oldText: string;
  readonly newText: string;
}

const MAX_DIFF_LINES_PER_FILE = 2_000;
const CONTEXT_LINES_AROUND_CHANGE = 2;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "string") return val;
  }
  return undefined;
}

function splitLogicalLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.trunc(value);
  }
  return Math.max(1, Math.trunc(fallback));
}

function toNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return Math.max(0, Math.trunc(fallback));
}

/**
 * 提取 Pi edit 工具参数中的变更对：
 * 优先兼容 Pi v1.5.2 原生 `edits: [{ oldText, newText }]`，同时兼容扁平 `{ oldText, newText }` / `{ old_string, new_string }` / `{ old_str, new_str }`。
 */
export function extractPiEditPairs(args: Record<string, unknown> | undefined): PiEditPair[] {
  if (!args) return [];
  const pairs: PiEditPair[] = [];
  if (Array.isArray(args.edits)) {
    for (const item of args.edits) {
      if (!isPlainRecord(item)) continue;
      const oldText = readOptionalString(item, ["oldText", "old_string", "old_str", "oldString"]);
      const newText = readOptionalString(item, ["newText", "new_string", "new_str", "newString"]);
      if (oldText !== undefined || newText !== undefined) {
        pairs.push({ oldText: oldText ?? "", newText: newText ?? "" });
      }
    }
    if (pairs.length > 0) return pairs;
  }
  const flatOld = readOptionalString(args, ["oldText", "old_string", "old_str", "oldString"]);
  const flatNew = readOptionalString(args, ["newText", "new_string", "new_str", "newString"]);
  if (flatOld !== undefined || flatNew !== undefined) {
    pairs.push({ oldText: flatOld ?? "", newText: flatNew ?? "" });
  }
  return pairs;
}

function finalizeHunk(
  oldStart: number,
  declaredOldLines: number | undefined,
  newStart: number,
  declaredNewLines: number | undefined,
  lines: string[],
): StructuredDiffHunk | null {
  if (lines.length === 0) return null;
  let countedOld = 0;
  let countedNew = 0;
  for (const line of lines) {
    const prefix = line.charAt(0);
    if (prefix === "-") countedOld += 1;
    else if (prefix === "+") countedNew += 1;
    else {
      countedOld += 1;
      countedNew += 1;
    }
  }
  return {
    oldStart: toPositiveInt(oldStart, 1),
    oldLines: toNonNegativeInt(declaredOldLines, countedOld),
    newStart: toPositiveInt(newStart, 1),
    newLines: toNonNegativeInt(declaredNewLines, countedNew),
    lines,
  };
}

/** 解析标准 unified diff（`details.patch`）为结构化 hunk 数组。 */
export function parseUnifiedPatchToStructuredHunks(patchText: string): StructuredDiffHunk[] {
  const rawLines = splitLogicalLines(patchText);
  const hunks: StructuredDiffHunk[] = [];
  const hunkHeaderRe = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

  let currentOldStart = 1;
  let currentOldLines: number | undefined;
  let currentNewStart = 1;
  let currentNewLines: number | undefined;
  let currentLines: string[] = [];
  let inHunk = false;

  const flush = (): void => {
    if (!inHunk) return;
    const finalized = finalizeHunk(
      currentOldStart,
      currentOldLines,
      currentNewStart,
      currentNewLines,
      currentLines,
    );
    if (finalized) hunks.push(finalized);
    currentLines = [];
    inHunk = false;
  };

  for (const line of rawLines) {
    const match = hunkHeaderRe.exec(line);
    if (match) {
      flush();
      currentOldStart = Number(match[1]);
      currentOldLines = match[2] !== undefined ? Number(match[2]) : undefined;
      currentNewStart = Number(match[3]);
      currentNewLines = match[4] !== undefined ? Number(match[4]) : undefined;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      flush();
      continue;
    }
    const prefix = line.charAt(0);
    if (prefix === "+" || prefix === "-" || prefix === " ") {
      currentLines.push(line);
    } else if (line.length === 0) {
      currentLines.push(" ");
    } else {
      currentLines.push(` ${line}`);
    }
  }
  flush();
  return hunks;
}

interface ParsedNumberedLine {
  readonly sign: "+" | "-" | " ";
  readonly lineNumber: number | undefined;
  readonly body: string;
}

function parseLineNumberedDiffRow(line: string): ParsedNumberedLine | "separator" | null {
  if (/^\s*\.\.\.\s*$/.test(line)) return "separator";
  // fake-pi 格式: "1 - const a = 1;" / "1 + const a = 2;"
  const numFirstChange = /^\s*(\d+)\s+([+-])\s?(.*)$/.exec(line);
  if (numFirstChange) {
    return {
      sign: numFirstChange[2] as "+" | "-",
      lineNumber: Number(numFirstChange[1]),
      body: numFirstChange[3] ?? "",
    };
  }
  // Pi 上游 generateDiffString 格式: "+12 content" / "-12 content" / " 12 content"
  const signFirstNum = /^([+-])\s*(\d+)\s(.*)$/.exec(line);
  if (signFirstNum) {
    return {
      sign: signFirstNum[1] as "+" | "-",
      lineNumber: Number(signFirstNum[2]),
      body: signFirstNum[3] ?? "",
    };
  }
  const indentedNumContext = /^\s+(\d+)\s(.*)$/.exec(line);
  if (indentedNumContext) {
    return {
      sign: " ",
      lineNumber: Number(indentedNumContext[1]),
      body: indentedNumContext[2] ?? "",
    };
  }
  const numContext = /^(\d+)\s{2}(.*)$/.exec(line);
  if (numContext) {
    return {
      sign: " ",
      lineNumber: Number(numContext[1]),
      body: numContext[2] ?? "",
    };
  }
  if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
    return {
      sign: line.charAt(0) as "+" | "-" | " ",
      lineNumber: undefined,
      body: line.slice(1),
    };
  }
  return null;
}

/** 解析 Pi `details.diff` 行号差异文本为结构化 hunk 数组。 */
export function parseLineNumberedDiffToStructuredHunks(
  diffText: string,
  firstChangedLine?: number,
): StructuredDiffHunk[] {
  const rawLines = splitLogicalLines(diffText);
  const hunks: StructuredDiffHunk[] = [];
  const defaultStart = toPositiveInt(firstChangedLine, 1);

  let oldStart: number | undefined;
  let newStart: number | undefined;
  let lines: string[] = [];

  const flush = (): void => {
    const finalized = finalizeHunk(
      oldStart ?? defaultStart,
      undefined,
      newStart ?? defaultStart,
      undefined,
      lines,
    );
    if (finalized) hunks.push(finalized);
    oldStart = undefined;
    newStart = undefined;
    lines = [];
  };

  for (const raw of rawLines) {
    const parsed = parseLineNumberedDiffRow(raw);
    if (parsed === null) continue;
    if (parsed === "separator") {
      flush();
      continue;
    }
    if (parsed.lineNumber !== undefined) {
      if (oldStart === undefined && (parsed.sign === "-" || parsed.sign === " ")) {
        oldStart = parsed.lineNumber;
      }
      if (newStart === undefined && (parsed.sign === "+" || parsed.sign === " ")) {
        newStart = parsed.lineNumber;
      }
    }
    lines.push(`${parsed.sign}${parsed.body}`);
  }
  flush();
  return hunks;
}

/** 从 `{ oldText, newText }` 对纯计算结构化 hunk（无外部 diff 依赖）。 */
export function computeStructuredHunksFromEditPairs(
  pairs: readonly PiEditPair[],
  firstChangedLine?: number,
): StructuredDiffHunk[] {
  const hunks: StructuredDiffHunk[] = [];
  let cursor = toPositiveInt(firstChangedLine, 1);

  for (const pair of pairs) {
    const oldLines = splitLogicalLines(pair.oldText);
    const newLines = splitLogicalLines(pair.newText);
    if (oldLines.length === 0 && newLines.length === 0) continue;

    let prefix = 0;
    const minLen = Math.min(oldLines.length, newLines.length);
    while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < minLen - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }

    const leadingStart = Math.max(0, prefix - CONTEXT_LINES_AROUND_CHANGE);
    const trailingCount = Math.min(suffix, CONTEXT_LINES_AROUND_CHANGE);
    const lines: string[] = [];
    for (let idx = leadingStart; idx < prefix; idx += 1) {
      lines.push(` ${oldLines[idx] ?? ""}`);
    }
    for (let idx = prefix; idx < oldLines.length - suffix; idx += 1) {
      lines.push(`-${oldLines[idx] ?? ""}`);
    }
    for (let idx = prefix; idx < newLines.length - suffix; idx += 1) {
      lines.push(`+${newLines[idx] ?? ""}`);
    }
    const suffixStart = oldLines.length - suffix;
    for (let idx = 0; idx < trailingCount; idx += 1) {
      lines.push(` ${oldLines[suffixStart + idx] ?? ""}`);
    }

    const startLine = cursor + leadingStart;
    const finalized = finalizeHunk(startLine, undefined, startLine, undefined, lines);
    if (finalized) hunks.push(finalized);
    cursor += Math.max(oldLines.length, newLines.length, 1);
  }
  return hunks;
}

function buildValidatedFileDiff(
  filePath: string,
  hunks: readonly StructuredDiffHunk[],
  truncated = false,
): PiFileDiffDisplay | undefined {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) return undefined;

  let additions = 0;
  let deletions = 0;
  let remainingBudget = MAX_DIFF_LINES_PER_FILE;
  let wasTruncated = truncated;
  const boundedHunks: StructuredDiffHunk[] = [];

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    if (remainingBudget <= 0) {
      wasTruncated = true;
      continue;
    }
    if (hunk.lines.length <= remainingBudget) {
      boundedHunks.push(hunk);
      remainingBudget -= hunk.lines.length;
    } else {
      const sliced = hunk.lines.slice(0, remainingBudget);
      const clipped = finalizeHunk(hunk.oldStart, undefined, hunk.newStart, undefined, sliced);
      if (clipped) boundedHunks.push(clipped);
      remainingBudget = 0;
      wasTruncated = true;
    }
  }

  return {
    kind: "file_diff",
    filePath: trimmedPath,
    additions: Math.max(0, Math.trunc(additions)),
    deletions: Math.max(0, Math.trunc(deletions)),
    structuredPatch: boundedHunks,
    ...(wasTruncated ? { truncated: true } : {}),
  };
}

/** 构造 Pi `edit` 工具的 `file_diff` 展示载荷（三级回落：details.patch -> details.diff -> args）。 */
export function buildEditFileDiffDisplay(input: {
  filePath: string;
  args?: Record<string, unknown> | undefined;
  details?: Record<string, unknown> | undefined;
}): PiFileDiffDisplay | undefined {
  const trimmedPath = input.filePath.trim();
  if (!trimmedPath) return undefined;

  const firstChangedLine =
    typeof input.details?.firstChangedLine === "number"
      ? input.details.firstChangedLine
      : undefined;

  let hunks: StructuredDiffHunk[] = [];
  if (typeof input.details?.patch === "string" && input.details.patch.trim().length > 0) {
    hunks = parseUnifiedPatchToStructuredHunks(input.details.patch);
  }
  if (
    hunks.length === 0 &&
    typeof input.details?.diff === "string" &&
    input.details.diff.trim().length > 0
  ) {
    hunks = parseLineNumberedDiffToStructuredHunks(input.details.diff, firstChangedLine);
  }
  if (hunks.length === 0) {
    const pairs = extractPiEditPairs(input.args);
    if (pairs.length > 0) {
      hunks = computeStructuredHunksFromEditPairs(pairs, firstChangedLine);
    }
  }

  if (hunks.length === 0) return undefined;
  return buildValidatedFileDiff(trimmedPath, hunks);
}

/** 构造 Pi `write` 工具的 `file_diff` 展示载荷（全量新增 `+N` 行）。 */
export function buildWriteFileDiffDisplay(
  filePath: string,
  content: string,
): PiFileDiffDisplay | undefined {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) return undefined;
  const allLines = splitLogicalLines(content);
  if (allLines.length === 0) {
    return {
      kind: "file_diff",
      filePath: trimmedPath,
      additions: 0,
      deletions: 0,
      structuredPatch: [],
    };
  }
  const truncated = allLines.length > MAX_DIFF_LINES_PER_FILE;
  const shown = truncated ? allLines.slice(0, MAX_DIFF_LINES_PER_FILE) : allLines;
  const hunk: StructuredDiffHunk = {
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: shown.length,
    lines: shown.map((line) => `+${line}`),
  };
  return {
    kind: "file_diff",
    filePath: trimmedPath,
    additions: allLines.length,
    deletions: 0,
    structuredPatch: [hunk],
    ...(truncated ? { truncated: true } : {}),
  };
}
