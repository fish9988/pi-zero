import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPiSessionInfoJsonlLine,
  buildSmartRenamePromptText,
  extractSmartRenameContextFromJsonl,
  findActiveJsonlLeafId,
  sanitizeSmartRenameTitle,
} from "#src/pi-config/domain/piSmartRenameDomain.js";
import {
  deletePiSessionOnDisk,
  persistPiSessionTitle,
} from "#src/pi-config/adapters/piSessionSmartOps.js";
import { encodePiSessionBucketDir } from "#src/pi-runtime/index.js";

describe("Pi smart rename domain & disk session ops", () => {
  it("extracts active branch context from JSONL and ignores abandoned fork branches", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "s1", cwd: "/repo", timestamp: 1700000000000 }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        message: { role: "user", content: "排查图片上传红点失败原因" },
      }),
      JSON.stringify({
        type: "message",
        id: "abandoned",
        parentId: "u1",
        message: { role: "assistant", content: "这是被放弃的旧分支" },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "已定位 piUnsupportedMethods 桩函数导致上传失败" },
            { type: "toolCall", id: "tc1", name: "edit", arguments: {} },
          ],
        },
      }),
    ].join("\n");

    const ctx = extractSmartRenameContextFromJsonl(jsonl);
    expect(ctx).toContain("排查图片上传红点失败原因");
    expect(ctx).toContain("piUnsupportedMethods");
    expect(ctx).toContain("[tools: edit]");
    expect(ctx).not.toContain("被放弃的旧分支");
    expect(findActiveJsonlLeafId(jsonl)).toBe("a1");

    const promptWithPlaceholder = buildSmartRenamePromptText("总结：{{context}}", ctx);
    expect(promptWithPlaceholder).toContain("总结：User:");

    const promptDefault = buildSmartRenamePromptText("", ctx);
    expect(promptDefault).toContain("<conversation>");
    expect(promptDefault).toContain("排查图片上传红点失败原因");
  });

  it("sanitizes LLM title outputs (strips think tags, quotes, prefixes, markdown, punctuation)", () => {
    expect(sanitizeSmartRenameTitle("<think>思考过程...</think>\n标题：「修复图片上传故障」")).toBe(
      "修复图片上传故障",
    );
    expect(sanitizeSmartRenameTitle("```text\n# **Pi Zero 附件上传修复。**\n```")).toBe(
      "Pi Zero 附件上传修复",
    );
    expect(sanitizeSmartRenameTitle('Title: "Fix image upload flow"\nExtra explanation')).toBe(
      "Fix image upload flow",
    );
    expect(
      sanitizeSmartRenameTitle(
        buildPiSessionInfoJsonlLine({
          id: "x",
          parentId: null,
          timestampIso: "2026-01-01T00:00:00Z",
          title: "ok",
        }),
      ),
    ).toBeTruthy();
  });

  it("persists session_info title idempotently and permanently deletes only files under sessions/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-smart-ops-"));
    try {
      const agentDir = join(dir, "agent");
      const workspacePath = join(dir, "proj");
      const bucketDir = join(agentDir, "sessions", encodePiSessionBucketDir(workspacePath));
      await mkdir(bucketDir, { recursive: true });
      const sessionFile = join(bucketDir, "2026-11-20_sess-1.jsonl");
      await writeFile(
        sessionFile,
        [
          JSON.stringify({ type: "session", id: "sess-1", cwd: workspacePath }),
          JSON.stringify({
            type: "message",
            id: "m1",
            parentId: null,
            message: { role: "user", content: "hello" },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const deps = {
        agentDir,
        managedRuntimeDir: join(dir, "runtime"),
        resolveSessionFile: async () => sessionFile,
      };

      const persisted1 = await persistPiSessionTitle(
        { workspacePath, sessionId: "sess-1", title: "智能命名测试" },
        deps,
      );
      expect(persisted1).toBe(true);
      // Idempotent second call does not append duplicate line
      await persistPiSessionTitle(
        { workspacePath, sessionId: "sess-1", title: "智能命名测试" },
        deps,
      );

      const lines = (await readFile(sessionFile, "utf8"))
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(3);
      const last = JSON.parse(lines[2]!) as Record<string, unknown>;
      expect(last["type"]).toBe("session_info");
      expect(last["parentId"]).toBe("m1");
      expect(last["name"]).toBe("智能命名测试");

      // Refuses deleting file outside <agentDir>/sessions
      const outsideFile = join(dir, "outside.jsonl");
      await writeFile(outsideFile, "{}", "utf8");
      await expect(
        deletePiSessionOnDisk(
          { workspacePath, sessionId: "sess-outside", mode: "permanent" },
          { ...deps, resolveSessionFile: async () => outsideFile },
        ),
      ).rejects.toThrow("Refusing to delete file outside Pi sessions directory");
      expect(existsSync(outsideFile)).toBe(true);

      // Permanently deletes target .jsonl inside sessions dir
      const deleted = await deletePiSessionOnDisk(
        { workspacePath, sessionId: "sess-1", mode: "permanent" },
        deps,
      );
      expect(deleted).toEqual({
        sessionId: "sess-1",
        deletedFile: sessionFile,
        trashed: false,
        mode: "permanent",
      });
      expect(existsSync(sessionFile)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
