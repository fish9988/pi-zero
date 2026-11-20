import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPiAgentService } from "#src/pi-runtime/adapters/piAgentService.js";
import { PiAttachmentStore } from "#src/pi-runtime/adapters/piAttachmentStore.js";
import { hydratePiJsonlSession } from "#src/pi-runtime/domain/piJsonlHydrator.js";

function sha256Checksum(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("PiAttachmentStore & V4 attachment pipeline", () => {
  it("supports multi-chunk begin/chunk/commit, idempotency, preview read, and Pi RPC image resolution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-att-test-"));
    try {
      const store = new PiAttachmentStore({ storageDir: dir });
      const pngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      const part1 = pngBytes.subarray(0, 30);
      const part2 = pngBytes.subarray(30);
      const checksum = sha256Checksum(pngBytes);

      const begin = await store.begin({
        workspacePath: dir,
        sessionId: "sess-1",
        uploadId: "upload-1",
        fileName: "screenshot.png",
        mime: "image/png",
        totalBytes: pngBytes.byteLength,
        totalChunks: 2,
        checksum,
      });
      expect(begin).toEqual({ uploadId: "upload-1", state: "staging", nextChunkIndex: 0 });

      const c0 = await store.chunk({
        workspacePath: dir,
        sessionId: "sess-1",
        uploadId: "upload-1",
        chunkIndex: 0,
        dataBase64: part1.toString("base64"),
      });
      expect(c0).toEqual({ uploadId: "upload-1", nextChunkIndex: 1 });

      // Idempotent duplicate chunk retry
      const c0Dup = await store.chunk({
        workspacePath: dir,
        sessionId: "sess-1",
        uploadId: "upload-1",
        chunkIndex: 0,
        dataBase64: part1.toString("base64"),
      });
      expect(c0Dup).toEqual({ uploadId: "upload-1", nextChunkIndex: 1 });

      const c1 = await store.chunk({
        workspacePath: dir,
        sessionId: "sess-1",
        uploadId: "upload-1",
        chunkIndex: 1,
        dataBase64: part2.toString("base64"),
      });
      expect(c1).toEqual({ uploadId: "upload-1", nextChunkIndex: 2 });

      const committed = await store.commit({
        workspacePath: dir,
        sessionId: "sess-1",
        uploadId: "upload-1",
      });
      expect(committed.ref).toMatch(/^pi-att:\/\/[0-9a-f]{64}\/screenshot\.png$/);

      // Idempotent begin after commit returns committed ref immediately
      const beginAfterCommit = await store.begin({
        workspacePath: dir,
        sessionId: "sess-1",
        uploadId: "upload-1",
        fileName: "screenshot.png",
        mime: "image/png",
        totalBytes: pngBytes.byteLength,
        totalChunks: 2,
        checksum,
      });
      expect(beginAfterCommit).toEqual({
        uploadId: "upload-1",
        state: "committed",
        nextChunkIndex: 2,
        ref: committed.ref,
      });

      // Chunked preview read round-trips exact bytes
      const r1 = await store.readForPreview({
        workspacePath: dir,
        sessionId: "sess-1",
        ref: committed.ref,
        offset: 0,
        limit: 40,
      });
      expect(r1.mediaType).toBe("image/png");
      expect(r1.totalBytes).toBe(pngBytes.byteLength);
      expect(r1.nextOffset).toBe(40);

      const r2 = await store.readForPreview({
        workspacePath: dir,
        sessionId: "sess-1",
        ref: committed.ref,
        offset: 40,
        limit: 100,
      });
      expect(r2.nextOffset).toBeNull();
      const roundTripped = Buffer.concat([
        Buffer.from(r1.dataBase64, "base64"),
        Buffer.from(r2.dataBase64, "base64"),
      ]);
      expect(roundTripped.equals(pngBytes)).toBe(true);

      // Resolve into Pi RPC prompt payload
      const resolved = await store.resolvePromptPayload("能看见图吗", [
        {
          ref: committed.ref,
          fileName: "screenshot.png",
          mime: "image/png",
          bytes: pngBytes.byteLength,
        },
      ]);
      expect(resolved.message).toBe("能看见图吗");
      expect(resolved.images).toEqual([
        {
          type: "image",
          data: pngBytes.toString("base64"),
          mimeType: "image/png",
        },
      ]);

      store.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects bad checksum, unauthorized local path reads, and supports authorized local image + non-image files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-att-local-"));
    try {
      const store = new PiAttachmentStore({ storageDir: join(dir, "store") });
      const localImgPath = join(dir, "photo.jpg");
      const localTxtPath = join(dir, "notes.txt");
      const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      await writeFile(localImgPath, fakeJpg);
      await writeFile(localTxtPath, "hello attachment", "utf8");

      // Checksum mismatch rejected
      await store.begin({
        workspacePath: dir,
        sessionId: "sess-2",
        uploadId: "bad-sum",
        fileName: "a.png",
        mime: "image/png",
        totalBytes: 4,
        totalChunks: 1,
        checksum: `sha256:${"0".repeat(64)}`,
      });
      await store.chunk({
        workspacePath: dir,
        sessionId: "sess-2",
        uploadId: "bad-sum",
        chunkIndex: 0,
        dataBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      });
      await expect(
        store.commit({ workspacePath: dir, sessionId: "sess-2", uploadId: "bad-sum" }),
      ).rejects.toThrow("fault.attachment.checksumMismatch");

      // Unauthorized local path rejected on read
      await expect(
        store.readForPreview({
          workspacePath: dir,
          sessionId: "sess-2",
          ref: localImgPath,
          offset: 0,
          limit: 1024,
        }),
      ).rejects.toThrow("fault.attachment.unauthorizedPath");

      // Authorized local path succeeds and normalizes image/jpg -> image/jpeg
      const authorized = new Map([[localImgPath, "image/jpg"]]);
      const readRes = await store.readForPreview(
        {
          workspacePath: dir,
          sessionId: "sess-2",
          ref: localImgPath,
          offset: 0,
          limit: 1024,
        },
        { authorizedLocalRefs: authorized },
      );
      expect(readRes.mediaType).toBe("image/jpeg");
      expect(Buffer.from(readRes.dataBase64, "base64").equals(fakeJpg)).toBe(true);

      // Prompt payload resolves both local image (base64) and local non-image file (disk path note)
      const resolved = await store.resolvePromptPayload("check both", [
        { ref: localImgPath, fileName: "photo.jpg", mime: "image/jpg", bytes: fakeJpg.byteLength },
        { ref: localTxtPath, fileName: "notes.txt", mime: "text/plain", bytes: 16 },
      ]);
      expect(resolved.images).toEqual([
        { type: "image", data: fakeJpg.toString("base64"), mimeType: "image/jpeg" },
      ]);
      expect(resolved.message).toContain("check both");
      expect(resolved.message).toContain(localTxtPath);

      store.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("wires attachmentBeginV4/Chunk/Commit/Read/Stat on createPiAgentService and hydrates JSONL user images", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-att-svc-"));
    const service = createPiAgentService({
      env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent") },
    });
    try {
      const payload = Buffer.from("tiny-png-bytes");
      const begin = await service.attachmentBeginV4({
        workspacePath: dir,
        sessionId: "draft-1",
        uploadId: "up-svc-1",
        fileName: "paste.png",
        mime: "image/png",
        totalBytes: payload.byteLength,
        totalChunks: 1,
        checksum: sha256Checksum(payload),
      });
      expect(begin.state).toBe("staging");

      await service.attachmentChunkV4({
        workspacePath: dir,
        sessionId: "draft-1",
        uploadId: "up-svc-1",
        chunkIndex: 0,
        dataBase64: payload.toString("base64"),
      });
      const { ref } = await service.attachmentCommitV4({
        workspacePath: dir,
        sessionId: "draft-1",
        uploadId: "up-svc-1",
      });

      const source = await service.attachmentPreviewSourceV4({
        workspacePath: dir,
        sessionId: "draft-1",
        ref,
      });
      expect(source).toEqual({ kind: "chunked" });

      const read = await service.attachmentReadV4({
        workspacePath: dir,
        sessionId: "draft-1",
        ref,
        offset: 0,
        limit: 4096,
      });
      expect(Buffer.from(read.dataBase64, "base64").equals(payload)).toBe(true);
      expect(read.mediaType).toBe("image/png");

      const stat = await service.conversationAttachmentStatV4({
        workspacePath: dir,
        sessionId: "draft-1",
        ref,
        target: { rowId: 1, entityId: "user_1" },
        attachmentIndex: 0,
      });
      expect(stat).toEqual({ mediaType: "image/png", totalBytes: payload.byteLength });

      // Hydrating Pi JSONL with user image block extracts AttachmentRef + inline attachment
      const imgB64 = payload.toString("base64");
      const jsonl = [
        JSON.stringify({ type: "session", id: "sess-img", cwd: dir, timestamp: 1700000000000 }),
        JSON.stringify({
          type: "message",
          id: "m1",
          timestamp: 1700000001000,
          message: {
            role: "user",
            content: [
              { type: "text", text: "能看见图吗" },
              { type: "image", data: imgB64, mimeType: "image/png" },
            ],
          },
        }),
      ].join("\n");

      const hydrated = hydratePiJsonlSession({
        rawContent: jsonl,
        fallbackSessionId: "sess-img",
        fallbackCwd: dir,
        fallbackMtimeMs: 1700000001000,
      });
      const userRow = hydrated.rows.find((row) => row.kind === "userInput");
      expect(userRow?.kind).toBe("userInput");
      if (userRow?.kind === "userInput") {
        expect(userRow.attachments).toHaveLength(1);
        expect(userRow.attachments?.[0]?.mime).toBe("image/png");
      }
      expect(hydrated.inlineAttachments).toHaveLength(1);
      expect(hydrated.inlineAttachments[0]?.dataBase64).toBe(imgB64);
    } finally {
      await service.disposeAllAndWait();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
