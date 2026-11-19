/**
 * Pi v3 `.jsonl` 文档拆行、活动分支追溯与单条字段解析辅助（纯 domain 层，无 IO/计时器）。
 */
import type {
  TurnHeaderRow,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { isPiRecord, type PiUsage } from "#src/pi-runtime/domain/piRpcTypes.js";
import type { PiFileDiffDisplay } from "#src/pi-runtime/domain/piEditDiffMapper.js";
import { cleanPiSessionTitle } from "#src/pi-runtime/domain/piJsonlIndexParser.js";
import type { PiTurnFileChangeEntry } from "#src/pi-runtime/domain/piTurnSettlement.js";

export interface ParsedPiJsonlDocument {
  readonly header: Record<string, unknown> | null;
  readonly slotTitle: string | null;
  readonly entries: Record<string, unknown>[];
}

/** 严格按 `\n`（剥离可选 `\r`）拆分 `.jsonl`，容错跳过损坏行。 */
export function parsePiJsonlDocument(rawContent: string): ParsedPiJsonlDocument {
  const lines = rawContent.split("\n");
  let header: Record<string, unknown> | null = null;
  let slotTitle: string | null = null;
  const entries: Record<string, unknown>[] = [];

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPiRecord(parsed)) continue;
    if (parsed["type"] === "session" && header === null) {
      header = parsed;
      continue;
    }
    if (parsed["type"] === "title" && header === null) {
      if (typeof parsed["title"] === "string") {
        const cleaned = cleanPiSessionTitle(parsed["title"]);
        if (cleaned) slotTitle = cleaned;
      }
      continue;
    }
    entries.push(parsed);
  }

  return { header, slotTitle, entries };
}

/**
 * 活动分支解析：v2/v3 树形文件从末条含 `id` 的条目沿 `parentId` 逆推（带环检测与断链保护）；
 * v1 线性文件原序返回。已放弃的 fork 侧分支不会出现在结果中。
 */
export function resolveActivePiBranchEntries(
  entries: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  let leafId: string | null = null;
  for (const entry of entries) {
    const id = typeof entry["id"] === "string" && entry["id"].trim() !== "" ? entry["id"] : null;
    if (id) {
      byId.set(id, entry);
      leafId = id;
    }
  }
  if (!leafId) return [...entries];

  const chain: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    chain.push(node);
    const parentId = node["parentId"];
    cursor = typeof parentId === "string" && parentId.trim() !== "" ? parentId : null;
  }
  chain.reverse();
  return chain;
}

export function readPiUserContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const block of content) {
    if (isPiRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
      chunks.push(block["text"]);
    }
  }
  return chunks.join("\n");
}

export function parsePiModelChangeEntry(entry: Record<string, unknown>): {
  provider: string;
  model: string;
} | null {
  const directProvider = typeof entry["provider"] === "string" ? entry["provider"].trim() : "";
  const directModelId = typeof entry["modelId"] === "string" ? entry["modelId"].trim() : "";
  if (directProvider && directModelId) {
    return { provider: directProvider, model: directModelId };
  }
  const combined = typeof entry["model"] === "string" ? entry["model"].trim() : "";
  if (combined.includes("/")) {
    const slashIdx = combined.indexOf("/");
    const prov = combined.slice(0, slashIdx).trim();
    const mod = combined.slice(slashIdx + 1).trim();
    if (prov && mod) return { provider: prov, model: mod };
  }
  return null;
}

export function recordHydratedFileDiff(
  turnChanges: Map<string, PiTurnFileChangeEntry>,
  canonicalToolName: string,
  fileDiff: PiFileDiffDisplay,
): void {
  const key = fileDiff.filePath.trim().replace(/\\/g, "/");
  if (!key) return;
  const existing = turnChanges.get(key);
  if (existing) {
    existing.additions += fileDiff.additions;
    existing.deletions += fileDiff.deletions;
    existing.writeCount += 1;
    if (!existing.toolNames.includes(canonicalToolName)) {
      existing.toolNames.push(canonicalToolName);
    }
    existing.patches.push(...fileDiff.structuredPatch);
  } else {
    turnChanges.set(key, {
      path: fileDiff.filePath,
      additions: fileDiff.additions,
      deletions: fileDiff.deletions,
      writeCount: 1,
      toolNames: [canonicalToolName],
      patches: [...fileDiff.structuredPatch],
    });
  }
}

export function buildHydratedTurnFileChangesSnapshot(
  turnChanges: Map<string, PiTurnFileChangeEntry>,
): {
  summary: NonNullable<TurnHeaderRow["fileChanges"]>;
  detail: V4ConversationFileChangesResult;
} | null {
  if (turnChanges.size === 0) return null;
  let additions = 0;
  let deletions = 0;
  const items: V4ConversationFileChangesResult["items"] = [];
  for (const entry of turnChanges.values()) {
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
  return {
    summary: { additions, deletions, files: items.length, state: "active" },
    detail: { files: items.length, additions, deletions, state: "active", items },
  };
}

export function readPiUsageRecord(value: unknown): PiUsage | null {
  if (!isPiRecord(value)) return null;
  const input = typeof value["input"] === "number" ? value["input"] : 0;
  const output = typeof value["output"] === "number" ? value["output"] : 0;
  const cacheRead = typeof value["cacheRead"] === "number" ? value["cacheRead"] : 0;
  const cacheWrite = typeof value["cacheWrite"] === "number" ? value["cacheWrite"] : 0;
  const totalTokens =
    typeof value["totalTokens"] === "number"
      ? value["totalTokens"]
      : input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, totalTokens };
}
