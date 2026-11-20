/**
 * Pi 上下文容量分解、缓存命中率与费用计算纯函数模块（domain 层，0 IO）。
 *
 * 1. 上下文来源分解（对齐 `ZCodeContextUsageBreakdownItem` 规范枚举）：
 *    - 仅统计最近一次 compaction 之后的可见行，避免已压缩历史虚增占比；
 *    - 区分 `messages`（用户/助手/思考）、`system_tool_schemas`（内置工具调用与返回）、
 *      `mcp_tool_schemas`（MCP 工具调用与返回）及 `system_prompt`（系统提示词/AGENTS.md/工具定义余量）。
 * 2. 缓存命中率：同时追踪最近一轮与全会话累计的 `cacheRead / (input + cacheRead + cacheWrite)`。
 * 3. 花销计算：优先采用 Pi RPC / `.jsonl` 回传的 `usage.cost`，若缺失或为 0 则按
 *    Pi 模型目录 / `~/.pi/agent/models.json` 中的 `cost`（美元 / 百万 token）自动估算，并计算缓存节省金额。
 */
import type { ZCodeContextUsageBreakdownItem } from "@zcode/shared";
import type { ConversationSnapshot, WireConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { PiModelInfo, PiUsage } from "#src/pi-runtime/domain/piRpcTypes.js";

export type PiModelCostRates = NonNullable<PiModelInfo["cost"]>;

export type SessionUsageCost = NonNullable<ConversationSnapshot["usage"]["cost"]>;

/** 中英混合代码对话的经验字符/token 换算比（用于将字符估算与真实 usedTokens 对齐）。 */
const APPROX_CHARS_PER_TOKEN = 3.2;

function safePositiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function estimateUnknownTextChars(value: unknown, depth = 0): number {
  if (value === null || value === undefined || depth > 4) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) {
    let sum = 0;
    const limit = Math.min(value.length, 64);
    for (let i = 0; i < limit; i += 1) {
      sum += estimateUnknownTextChars(value[i], depth + 1);
    }
    return sum;
  }
  if (typeof value === "object") {
    let sum = 0;
    let count = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (count >= 48) break;
      count += 1;
      sum += k.length + 2 + estimateUnknownTextChars(v, depth + 1);
    }
    return sum;
  }
  return 0;
}

/**
 * 基于当前活跃上下文行与真实 `usedTokens`，计算用于上下文面板展示的分类占比。
 * 若最后存在 compaction 行，仅统计压缩点之后的可见行。
 */
export function computePiContextBreakdown(
  rows: readonly WireConversationRow[],
  usedTokens: number,
): ZCodeContextUsageBreakdownItem[] | undefined {
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return undefined;

  let startIndex = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const candidate = rows[i];
    if (
      candidate?.kind === "timelineMarker" &&
      candidate.marker.type === "compact" &&
      candidate.marker.status === "success"
    ) {
      startIndex = i + 1;
      break;
    }
  }

  let messagesChars = 0;
  let systemToolChars = 0;
  let mcpToolChars = 0;

  for (let i = startIndex; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    switch (row.kind) {
      case "userInput": {
        messagesChars += row.text.length;
        if (row.conversationQuotes) {
          for (const q of row.conversationQuotes) {
            messagesChars += q.text.length;
          }
        }
        if (row.attachments) {
          for (const att of row.attachments) {
            messagesChars += (att.fileName?.length ?? 0) + 128;
          }
        }
        break;
      }
      case "assistantText":
      case "reasoning":
        messagesChars += row.text.length;
        break;
      case "toolCall": {
        const inputLen =
          row.inputText && row.inputText.length > 0
            ? row.inputText.length
            : estimateUnknownTextChars(row.input);
        const outputLen = estimateUnknownTextChars(row.output);
        const total = inputLen + outputLen + row.toolName.length + 32;
        if (row.display?.kind === "mcp_tool") {
          mcpToolChars += total;
        } else {
          systemToolChars += total;
        }
        break;
      }
      default:
        break;
    }
  }

  const visibleChars = messagesChars + systemToolChars + mcpToolChars;
  const targetTotalChars = Math.max(visibleChars, Math.round(usedTokens * APPROX_CHARS_PER_TOKEN));
  // 模型实际消耗的上下文通常会大于纯可见消息字符数，差额主要来自系统提示词、AGENTS.md、Skills 与工具 Schema。
  const systemPromptChars = Math.max(0, targetTotalChars - visibleChars);

  const items: ZCodeContextUsageBreakdownItem[] = [];
  if (messagesChars > 0) items.push({ source: "messages", chars: Math.round(messagesChars) });
  if (systemToolChars > 0) {
    items.push({ source: "system_tool_schemas", chars: Math.round(systemToolChars) });
  }
  if (mcpToolChars > 0) {
    items.push({ source: "mcp_tool_schemas", chars: Math.round(mcpToolChars) });
  }
  if (systemPromptChars > 0) {
    items.push({ source: "system_prompt", chars: Math.round(systemPromptChars) });
  }

  return items.length > 0 ? items : undefined;
}

export function computePiCacheUsage(
  prevCache: NonNullable<ConversationSnapshot["usage"]["contextWindow"]>["cache"] | undefined,
  addedInput: number,
  addedCacheRead: number,
  addedCacheWrite: number,
): NonNullable<NonNullable<ConversationSnapshot["usage"]["contextWindow"]>["cache"]> | undefined {
  const latestDenominator = addedInput + addedCacheRead + addedCacheWrite;
  const prevTotalInput = prevCache?.totalInputTokens ?? 0;
  const prevTotalCacheRead = prevCache?.totalCacheReadTokens ?? 0;
  const prevTotalCacheWrite = prevCache?.totalCacheWriteTokens ?? 0;
  const prevRequestCount = prevCache?.hitRateRequestCount ?? 0;

  const totalInputTokens = prevTotalInput + addedInput;
  const totalCacheReadTokens = prevTotalCacheRead + addedCacheRead;
  const totalCacheWriteTokens = prevTotalCacheWrite + addedCacheWrite;
  const totalDenominator = totalInputTokens + totalCacheReadTokens + totalCacheWriteTokens;

  if (totalDenominator <= 0 && latestDenominator <= 0) return prevCache;

  const latestHitRate = latestDenominator > 0 ? addedCacheRead / latestDenominator : null;
  const hitRate = totalDenominator > 0 ? totalCacheReadTokens / totalDenominator : null;

  return {
    inputTokens: Math.round(addedInput),
    cacheReadTokens: Math.round(addedCacheRead),
    cacheWriteTokens: Math.round(addedCacheWrite),
    latestHitRate,
    hitRateRequestCount: prevRequestCount + (latestDenominator > 0 ? 1 : 0),
    totalInputTokens: Math.round(totalInputTokens),
    totalCacheReadTokens: Math.round(totalCacheReadTokens),
    totalCacheWriteTokens: Math.round(totalCacheWriteTokens),
    hitRate,
  };
}

export function hasPositiveModelCostRates(rates: PiModelCostRates | null | undefined): boolean {
  if (!rates) return false;
  return (
    safePositiveNumber(rates.input) > 0 ||
    safePositiveNumber(rates.output) > 0 ||
    safePositiveNumber(rates.cacheRead) > 0 ||
    safePositiveNumber(rates.cacheWrite) > 0
  );
}

/** 累加单次模型回复的花销，支持 Pi 原生 `usage.cost` 与 `models.json`/Catalog 定价兜底。 */
export function accumulatePiSessionCost(
  prevCost: SessionUsageCost | undefined,
  usage: PiUsage,
  modelPricing: PiModelCostRates | null | undefined,
): SessionUsageCost {
  const addedInput = safePositiveNumber(usage.input);
  const addedOutput = safePositiveNumber(usage.output);
  const addedCacheRead = safePositiveNumber(usage.cacheRead);
  const addedCacheWrite = safePositiveNumber(usage.cacheWrite);

  const rawCost = usage.cost;
  const hasReportedCost = Boolean(
    rawCost &&
    (safePositiveNumber(rawCost.total) > 0 ||
      safePositiveNumber(rawCost.input) > 0 ||
      safePositiveNumber(rawCost.output) > 0 ||
      safePositiveNumber(rawCost.cacheRead) > 0 ||
      safePositiveNumber(rawCost.cacheWrite) > 0),
  );
  const hasRates = hasPositiveModelCostRates(modelPricing);

  let deltaInputUsd = 0;
  let deltaOutputUsd = 0;
  let deltaCacheReadUsd = 0;
  let deltaCacheWriteUsd = 0;
  let deltaTotalUsd = 0;
  let deltaCacheSavedUsd = 0;

  if (hasReportedCost && rawCost) {
    deltaInputUsd = safePositiveNumber(rawCost.input);
    deltaOutputUsd = safePositiveNumber(rawCost.output);
    deltaCacheReadUsd = safePositiveNumber(rawCost.cacheRead);
    deltaCacheWriteUsd = safePositiveNumber(rawCost.cacheWrite);
    const componentSum = deltaInputUsd + deltaOutputUsd + deltaCacheReadUsd + deltaCacheWriteUsd;
    deltaTotalUsd = Math.max(safePositiveNumber(rawCost.total), componentSum);
    if (addedCacheRead > 0) {
      if (hasRates && modelPricing) {
        const savedPerToken =
          Math.max(
            0,
            safePositiveNumber(modelPricing.input) - safePositiveNumber(modelPricing.cacheRead),
          ) / 1_000_000;
        deltaCacheSavedUsd = addedCacheRead * savedPerToken;
      } else if (addedInput > 0 && deltaInputUsd > 0) {
        const impliedInputPrice = deltaInputUsd / addedInput;
        const impliedCachePrice = deltaCacheReadUsd / addedCacheRead;
        deltaCacheSavedUsd = addedCacheRead * Math.max(0, impliedInputPrice - impliedCachePrice);
      }
    }
  } else if (hasRates && modelPricing) {
    const inputRate = safePositiveNumber(modelPricing.input);
    const outputRate = safePositiveNumber(modelPricing.output);
    const cacheReadRate = safePositiveNumber(modelPricing.cacheRead);
    const cacheWriteRate = safePositiveNumber(modelPricing.cacheWrite);
    deltaInputUsd = (addedInput * inputRate) / 1_000_000;
    deltaOutputUsd = (addedOutput * outputRate) / 1_000_000;
    deltaCacheReadUsd = (addedCacheRead * cacheReadRate) / 1_000_000;
    deltaCacheWriteUsd = (addedCacheWrite * cacheWriteRate) / 1_000_000;
    deltaTotalUsd = deltaInputUsd + deltaOutputUsd + deltaCacheReadUsd + deltaCacheWriteUsd;
    if (addedCacheRead > 0 && inputRate > cacheReadRate) {
      deltaCacheSavedUsd = (addedCacheRead * (inputRate - cacheReadRate)) / 1_000_000;
    }
  }

  return {
    totalUsd: (prevCost?.totalUsd ?? 0) + deltaTotalUsd,
    inputUsd: (prevCost?.inputUsd ?? 0) + deltaInputUsd,
    outputUsd: (prevCost?.outputUsd ?? 0) + deltaOutputUsd,
    cacheReadUsd: (prevCost?.cacheReadUsd ?? 0) + deltaCacheReadUsd,
    cacheWriteUsd: (prevCost?.cacheWriteUsd ?? 0) + deltaCacheWriteUsd,
    cacheSavedUsd: (prevCost?.cacheSavedUsd ?? 0) + deltaCacheSavedUsd,
    pricingKnown: Boolean(prevCost?.pricingKnown || hasReportedCost || hasRates),
  };
}
