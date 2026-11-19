/**
 * 本地 Pi `.jsonl` 会话用量聚合纯逻辑（domain 层，0 Node IO / 0 计时器）。
 */
import type {
  PiLocalDailyUsage,
  PiLocalModelUsage,
  PiLocalUsageSummary,
} from "@zcode/shared/pi-config";
import { isPlainRecord } from "./piConfigHelpers.js";

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function toUtcDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseTimestampMs(value: unknown, fallbackMs: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallbackMs;
}

interface MutableModelAgg {
  provider: string;
  modelId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

interface MutableDayAgg {
  date: string;
  sessions: number;
  requests: number;
  totalTokens: number;
  costUsd: number;
}

export interface LocalUsageAccumulatorState {
  totalSessions: number;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  readonly byModel: Map<string, MutableModelAgg>;
  readonly byDay: Map<string, MutableDayAgg>;
}

export function createLocalUsageAccumulator(): LocalUsageAccumulatorState {
  return {
    totalSessions: 0,
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    byModel: new Map(),
    byDay: new Map(),
  };
}

/** 聚合单个 `.jsonl` 会话文件内容到累计器（仅统计 `sinceMs` 之后的消息）。 */
export function accumulatePiJsonlUsage(input: {
  rawContent: string;
  fallbackMtimeMs: number;
  sinceMs: number;
  acc: LocalUsageAccumulatorState;
}): void {
  const { acc, sinceMs } = input;
  const sessionDaysSeen = new Set<string>();
  let countedInSession = false;

  for (const rawLine of input.rawContent.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainRecord(parsed) || parsed["type"] !== "message") continue;
    const msg = parsed["message"];
    if (!isPlainRecord(msg) || msg["role"] !== "assistant" || !isPlainRecord(msg["usage"])) {
      continue;
    }

    const ts = parseTimestampMs(msg["timestamp"] ?? parsed["timestamp"], input.fallbackMtimeMs);
    if (ts < sinceMs) continue;

    const u = msg["usage"];
    const inputTokens = num(u["input"]);
    const outputTokens = num(u["output"]);
    const cacheReadTokens = num(u["cacheRead"]);
    const cacheWriteTokens = num(u["cacheWrite"]);
    const totalTokens =
      num(u["totalTokens"]) || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    const costUsd = isPlainRecord(u["cost"]) ? num(u["cost"]["total"]) : 0;

    const provider =
      typeof msg["provider"] === "string" && msg["provider"].trim()
        ? msg["provider"].trim()
        : "unknown";
    const modelId =
      typeof msg["model"] === "string" && msg["model"].trim() ? msg["model"].trim() : "unknown";

    countedInSession = true;
    acc.totalRequests += 1;
    acc.totalInputTokens += inputTokens;
    acc.totalOutputTokens += outputTokens;
    acc.totalCacheReadTokens += cacheReadTokens;
    acc.totalCacheWriteTokens += cacheWriteTokens;
    acc.totalTokens += totalTokens;
    acc.totalCostUsd += costUsd;

    const modelKey = `${provider}/${modelId}`;
    let modelRow = acc.byModel.get(modelKey);
    if (!modelRow) {
      modelRow = {
        provider,
        modelId,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      };
      acc.byModel.set(modelKey, modelRow);
    }
    modelRow.requests += 1;
    modelRow.inputTokens += inputTokens;
    modelRow.outputTokens += outputTokens;
    modelRow.cacheReadTokens += cacheReadTokens;
    modelRow.cacheWriteTokens += cacheWriteTokens;
    modelRow.totalTokens += totalTokens;
    modelRow.costUsd += costUsd;

    const dateKey = toUtcDateKey(ts);
    let dayRow = acc.byDay.get(dateKey);
    if (!dayRow) {
      dayRow = { date: dateKey, sessions: 0, requests: 0, totalTokens: 0, costUsd: 0 };
      acc.byDay.set(dateKey, dayRow);
    }
    if (!sessionDaysSeen.has(dateKey)) {
      sessionDaysSeen.add(dateKey);
      dayRow.sessions += 1;
    }
    dayRow.requests += 1;
    dayRow.totalTokens += totalTokens;
    dayRow.costUsd += costUsd;
  }

  if (countedInSession) {
    acc.totalSessions += 1;
  }
}

export function finalizeLocalUsageSummary(
  acc: LocalUsageAccumulatorState,
  scannedAt: number,
): PiLocalUsageSummary {
  const byModel: PiLocalModelUsage[] = [...acc.byModel.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens,
  );
  const byDay: PiLocalDailyUsage[] = [...acc.byDay.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  return {
    totalSessions: acc.totalSessions,
    totalRequests: acc.totalRequests,
    totalInputTokens: acc.totalInputTokens,
    totalOutputTokens: acc.totalOutputTokens,
    totalCacheReadTokens: acc.totalCacheReadTokens,
    totalCacheWriteTokens: acc.totalCacheWriteTokens,
    totalTokens: acc.totalTokens,
    totalCostUsd: Number(acc.totalCostUsd.toFixed(6)),
    byModel,
    byDay,
    scannedAt,
  };
}
