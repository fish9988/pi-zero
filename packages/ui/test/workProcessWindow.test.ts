import { describe, expect, it } from "vitest";
import type { AssistantWorkRow } from "../src/v4/conversationTurnFlowItems.js";
import {
  DEFAULT_VISIBLE_PROCESS_WINDOW_ITEMS,
  getAssistantSummaryToolCategory,
  hasWorkProcessActivity,
  sliceVisibleProcessItems,
  summarizeWorkProcess,
} from "../src/v4/conversationAssistantWorkItems.js";

function makeToolRow(
  rowId: number,
  toolName: string,
  status: "running" | "success" | "inputStreaming" = "success",
  input?: Record<string, unknown>,
): AssistantWorkRow {
  return {
    kind: "toolCall",
    rowId,
    turnId: "turn-1",
    createdAt: 1700000000000 + rowId * 100,
    toolCallId: `tc-${rowId}`,
    toolName,
    status,
    inputText: input ? JSON.stringify(input) : "",
    ...(input ? { input } : {}),
  };
}

function makeTextRow(rowId: number, text: string): AssistantWorkRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: "turn-1",
    createdAt: 1700000000000 + rowId * 100,
    text,
    state: "complete",
  };
}

function makeReasoningRow(rowId: number, state: "streaming" | "complete"): AssistantWorkRow {
  return {
    kind: "reasoning",
    rowId,
    turnId: "turn-1",
    createdAt: 1700000000000 + rowId * 100,
    text: "analyzing...",
    state,
  };
}

describe("Work Process Window helpers", () => {
  it("distinguishes pure text turns from turns with tool/reasoning process activity", () => {
    expect(hasWorkProcessActivity([])).toBe(false);
    expect(hasWorkProcessActivity([makeTextRow(1, "你好")])).toBe(false);
    expect(hasWorkProcessActivity([makeTextRow(1, "先看一下"), makeToolRow(2, "read")])).toBe(true);
    expect(hasWorkProcessActivity([makeReasoningRow(1, "streaming")])).toBe(true);
  });

  it("summarizes step count and active running step label cleanly", () => {
    const rows: AssistantWorkRow[] = [
      makeReasoningRow(1, "complete"),
      makeToolRow(2, "read", "success", { path: "src/app/index.ts" }),
      makeTextRow(3, "我来重新生成答辩图表"),
      makeToolRow(4, "bash", "running", {
        description: "regenerate refined matplotlib defense charts",
        command: "python build_charts.py",
      }),
    ];
    const summary = summarizeWorkProcess(rows, "zh-CN");
    expect(summary.stepCount).toBe(2);
    expect(summary.activeLabel).toBe("正在运行 regenerate refined matplotlib defense charts");

    const enSummary = summarizeWorkProcess(rows, "en-US");
    expect(enSummary.activeLabel).toBe("Running regenerate refined matplotlib defense charts");

    const readingRows = [makeToolRow(10, "read", "running", { file_path: "C:\\a\\b\\thesis.txt" })];
    expect(summarizeWorkProcess(readingRows, "zh-CN").activeLabel).toBe("正在读取 thesis.txt");

    const thinkingRows = [makeReasoningRow(11, "streaming")];
    expect(summarizeWorkProcess(thinkingRows, "zh-CN")).toEqual({
      stepCount: 1,
      activeLabel: "正在思考",
    });
  });

  it("groups MCP and custom Pi extension tools under run category without swallowing subagents", () => {
    expect(getAssistantSummaryToolCategory(makeToolRow(1, "mcp__github__list_issues"))).toBe("run");
    expect(getAssistantSummaryToolCategory(makeToolRow(2, "ask_question"))).toBe("run");
    expect(getAssistantSummaryToolCategory(makeToolRow(3, "Agent"))).toBeNull();
    expect(getAssistantSummaryToolCategory(makeToolRow(4, "subagent"))).toBeNull();
  });

  it("windows long step lists to the latest N items until expanded", () => {
    const items = Array.from({ length: 65 }, (_, i) => `step-${i + 1}`);
    const windowed = sliceVisibleProcessItems(items, false);
    expect(windowed.hiddenCount).toBe(65 - DEFAULT_VISIBLE_PROCESS_WINDOW_ITEMS);
    expect(windowed.visibleItems).toHaveLength(DEFAULT_VISIBLE_PROCESS_WINDOW_ITEMS);
    expect(windowed.visibleItems[0]).toBe(`step-${65 - DEFAULT_VISIBLE_PROCESS_WINDOW_ITEMS + 1}`);
    expect(windowed.visibleItems.at(-1)).toBe("step-65");

    const expanded = sliceVisibleProcessItems(items, true);
    expect(expanded.hiddenCount).toBe(0);
    expect(expanded.visibleItems).toHaveLength(65);
  });
});
