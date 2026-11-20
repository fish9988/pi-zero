import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPiExtensionUiResponseFromAnswer,
  mapPiExtensionUiRequestToInteraction,
} from "#src/pi-runtime/domain/piExtensionUiBridge.js";
import {
  PI_BUILTIN_ASK_QUESTION_TOOL_NAME,
  ensureBuiltinAskQuestionExtensionFile,
} from "#src/pi-runtime/adapters/piBuiltinAskQuestionExtension.js";

describe("Pi extension QA UI mapping & built-in ask_question extension", () => {
  it("avoids duplicate header/question and strips redundant option numbering while keeping exact Pi response values", () => {
    const rawOptions = [
      "1. 答辩准备 — 12 月答辩，离 deadline 最近",
      "2. 自用小工具 — 你想做个工具/脚本",
      "3. Other (free-form)",
    ];
    const mapped = mapPiExtensionUiRequestToInteraction(
      {
        type: "extension_ui_request",
        id: "req-1",
        method: "select",
        title: "审什么：这次要审的是哪件事？",
        options: rawOptions,
      },
      1700000000000,
      10,
    );

    expect(mapped).not.toBeNull();
    expect(mapped!.interaction.payload.kind).toBe("userInput");
    if (mapped!.interaction.payload.kind === "userInput") {
      const q = mapped!.interaction.payload.questions?.[0];
      expect(q).toBeDefined();
      // Header empty when identical to question so UI never duplicates it
      expect(q?.header).toBe("");
      expect(q?.question).toBe("审什么：这次要审的是哪件事？");
      // Option labels strip redundant "1. " prefix & split " — " description,
      // while preserving exact original string as value
      expect(q?.options?.[0]).toEqual({
        value: rawOptions[0],
        label: "答辩准备",
        description: "12 月答辩，离 deadline 最近",
      });
      expect(q?.options?.[1]).toEqual({
        value: rawOptions[1],
        label: "自用小工具",
        description: "你想做个工具/脚本",
      });
      expect(q?.options?.[2]).toEqual({
        value: rawOptions[2],
        label: "Other (free-form)",
      });
    }

    // Selecting option 0 echoes exact raw Pi option string back
    const response = buildPiExtensionUiResponseFromAnswer(mapped!.meta, {
      action: "accept",
      content: { answer: rawOptions[0] },
    });
    expect(response).toEqual({ id: "req-1", value: rawOptions[0] });
  });

  it("extracts short [header] tag from bracketed select title", () => {
    const mapped = mapPiExtensionUiRequestToInteraction(
      {
        type: "extension_ui_request",
        id: "req-2",
        method: "select",
        title: "[部署方式] 你希望部署到哪里？",
        options: ["Cloudflare Workers — 边缘节点", "本地 Docker — 私有化部署"],
      },
      1700000000000,
      11,
    );

    expect(mapped?.interaction.payload.kind).toBe("userInput");
    if (mapped?.interaction.payload.kind === "userInput") {
      const q = mapped.interaction.payload.questions?.[0];
      expect(q?.header).toBe("部署方式");
      expect(q?.question).toBe("你希望部署到哪里？");
      expect(q?.options?.[0]).toEqual({
        value: "Cloudflare Workers — 边缘节点",
        label: "Cloudflare Workers",
        description: "边缘节点",
      });
    }
  });

  it("materializes valid ESM built-in ask_question extension that registers tool and calls ctx.ui.select", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-ask-ext-"));
    try {
      const filePath = await ensureBuiltinAskQuestionExtensionFile(dir);
      expect(existsSync(filePath)).toBe(true);
      // Calling again reuses identical file
      const filePath2 = await ensureBuiltinAskQuestionExtensionFile(dir);
      expect(filePath2).toBe(filePath);

      const mod = (await import(pathToFileURL(filePath).href)) as {
        default: (pi: { registerTool: (def: Record<string, unknown>) => void }) => void;
      };
      const registered: Record<string, unknown>[] = [];
      mod.default({ registerTool: (def) => registered.push(def) });

      expect(registered).toHaveLength(1);
      const tool = registered[0]!;
      expect(tool["name"]).toBe(PI_BUILTIN_ASK_QUESTION_TOOL_NAME);
      expect(tool["defaultActive"]).toBe(true);

      const selectCalls: Array<{ title: string; options: string[] }> = [];
      const execute = tool["execute"] as (
        id: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: { ui: { select: (title: string, options: string[]) => Promise<string | undefined> } },
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        details: Record<string, unknown>;
      }>;

      const res = await execute(
        "tc-1",
        {
          questions: [
            {
              header: "范围",
              question: "这次改动包含哪些模块？",
              options: [
                { label: "仅 UI", description: "只修布局" },
                { label: "UI + 扩展", description: "同时内置问答工具" },
              ],
            },
          ],
        },
        undefined,
        undefined,
        {
          ui: {
            select: async (title, options) => {
              selectCalls.push({ title, options });
              return options[1];
            },
          },
        },
      );

      expect(selectCalls).toEqual([
        {
          title: "[范围] 这次改动包含哪些模块？",
          options: ["仅 UI — 只修布局", "UI + 扩展 — 同时内置问答工具"],
        },
      ]);
      expect(res.content[0]?.text).toContain("UI + 扩展 — 同时内置问答工具");
      expect(res.details["cancelled"]).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
