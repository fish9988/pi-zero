/**
 * Pi 运行时本地附件事务存储（V4 begin/chunk/commit/abort + read/stat + Pi RPC 图片解析）。
 *
 * - 上传暂存受 PROTOCOL_V4_LIMITS 并发数、总字节数与 TTL 约束，commit 严格校验 SHA-256；
 * - 已提交附件同时落盘到系统临时目录 `pi-zero-attachments/`，既支持大附件预览与内存淘汰回读，
 *   也可让非图片附件以真实本地路径提供给 Pi 工具读取（不写入用户真实 `~/.pi/agent`）；
 * - 历史 `.jsonl` 水合出的内联图片块以 `pi-inline://` 登记，重开会话可直接缩略图与灯箱预览。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import {
  PROTOCOL_V4_LIMITS,
  type AttachmentRef,
  type QueueItem,
  type V4AttachmentBeginResult,
  type V4AttachmentChunkResult,
  type V4AttachmentCommitResult,
  type V4AttachmentPreviewSourceResult,
  type V4AttachmentReadResult,
  type V4ConversationAttachmentReadResult,
  type V4ConversationAttachmentStatResult,
  type WireConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentPreviewSourceParams,
  ZCodeAgentAttachmentReadParams,
  ZCodeAgentAttachmentTerminalParams,
  ZCodeAgentConversationAttachmentReadParams,
  ZCodeAgentConversationAttachmentStatParams,
} from "#src/zcode-agent/zcodeAgent.js";
import type { HydratedPiInlineAttachment } from "#src/pi-runtime/domain/piJsonlHydrator.js";
import type { PiImageContent } from "#src/pi-runtime/domain/piRpcTypes.js";

const CHECKSUM_RE = /^sha256:([0-9a-f]{64})$/;
const MAX_CACHED_COMMITTED_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_INLINE_ENTRIES = 256;

interface StagedUpload {
  readonly sessionId: string;
  readonly uploadId: string;
  readonly fileName: string;
  readonly mime: string;
  readonly totalBytes: number;
  readonly totalChunks: number;
  readonly checksum: string;
  readonly chunks: Buffer[];
  receivedBytes: number;
  nextChunkIndex: number;
  updatedAt: number;
}

interface CommittedAttachment {
  readonly ref: string;
  readonly fileName: string;
  readonly mime: string;
  readonly totalBytes: number;
  readonly diskPath: string | null;
  bytes: Buffer | null;
  lastAccessAt: number;
}

export interface PiAttachmentReadContext {
  readonly authorizedLocalRefs?: ReadonlyMap<string, string> | undefined;
}

export interface ResolvedPiPromptPayload {
  readonly message: string;
  readonly images: readonly PiImageContent[];
}

export function collectAuthorizedAttachmentLocalRefs(
  rows: readonly WireConversationRow[],
  queueItems: readonly QueueItem[],
): ReadonlyMap<string, string> {
  const authorized = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "userInput" && row.attachments) {
      for (const att of row.attachments) {
        if (isAbsolute(att.ref)) authorized.set(att.ref, att.mime);
        if (att.previewRef && isAbsolute(att.previewRef)) authorized.set(att.previewRef, att.mime);
      }
    }
  }
  for (const item of queueItems) {
    for (const att of item.attachments) {
      if (isAbsolute(att.ref)) authorized.set(att.ref, att.mime);
      if (att.previewRef && isAbsolute(att.previewRef)) authorized.set(att.previewRef, att.mime);
    }
  }
  return authorized;
}

function uploadKey(sessionId: string, uploadId: string): string {
  return `${sessionId}\0${uploadId}`;
}

function sanitizeFileName(fileName: string): string {
  const base = basename(fileName.replace(/\\/g, "/")).replace(/[^A-Za-z0-9._-]/g, "_");
  return (base.length > 0 ? base : "attachment").slice(0, 96);
}

function safeExtension(fileName: string, mime: string): string {
  const fromName = extname(fileName).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(fromName)) return fromName;
  const baseMime = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  switch (baseMime) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    default:
      return ".bin";
  }
}

function inferMimeFromPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".md":
    case ".json":
    case ".csv":
    case ".log":
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".py":
    case ".yaml":
    case ".yml":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function normalizeImageMime(mime: string): string {
  const base = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "image/png";
  return base === "image/jpg" ? "image/jpeg" : base;
}

function normalizePreviewMediaType(mime: string): string {
  const base = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    base.startsWith("image/") ||
    base.startsWith("video/") ||
    base === "application/pdf" ||
    base === "text/plain"
  ) {
    return base === "image/jpg" ? "image/jpeg" : base;
  }
  if (
    base.startsWith("text/") ||
    base === "application/json" ||
    base === "application/xml" ||
    base === "application/javascript"
  ) {
    return "text/plain";
  }
  throw new Error("fault.attachment.unsupportedPreviewMediaType");
}

function decodeStrictBase64(dataBase64: string): Buffer {
  if (dataBase64.length === 0) return Buffer.alloc(0);
  if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw new Error("proto.invalidBase64");
  }
  return Buffer.from(dataBase64, "base64");
}

function isWithinDir(filePath: string, rootDir: string): boolean {
  const resolvedRoot = resolve(rootDir);
  const resolvedFile = resolve(filePath);
  return (
    resolvedFile === resolvedRoot ||
    resolvedFile.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`)
  );
}

export class PiAttachmentStore {
  private readonly storageDir: string;
  private readonly stagedUploads = new Map<string, StagedUpload>();
  private readonly committedByUploadKey = new Map<
    string,
    { readonly ref: string; readonly totalChunks: number }
  >();
  private readonly committedByRef = new Map<string, CommittedAttachment>();
  private readonly inlineByRef = new Map<
    string,
    { readonly fileName: string; readonly mime: string; readonly bytes: Buffer }
  >();
  private cachedCommittedBytes = 0;

  constructor(options?: { readonly storageDir?: string | undefined }) {
    this.storageDir = options?.storageDir ?? join(tmpdir(), "pi-zero-attachments");
  }

  private evictExpiredStaging(nowMs: number): void {
    for (const [key, entry] of this.stagedUploads) {
      if (nowMs - entry.updatedAt > PROTOCOL_V4_LIMITS.attachmentUploadTtlMs) {
        this.stagedUploads.delete(key);
      }
    }
  }

  private totalStagedDeclaredBytes(): number {
    let sum = 0;
    for (const entry of this.stagedUploads.values()) {
      sum += entry.totalBytes;
    }
    return sum;
  }

  private trimCommittedMemoryCache(): void {
    if (this.cachedCommittedBytes <= MAX_CACHED_COMMITTED_BYTES) return;
    const candidates = [...this.committedByRef.values()]
      .filter((entry) => entry.bytes !== null && entry.diskPath !== null)
      .sort((a, b) => a.lastAccessAt - b.lastAccessAt);
    for (const entry of candidates) {
      if (this.cachedCommittedBytes <= MAX_CACHED_COMMITTED_BYTES) break;
      if (entry.bytes) {
        this.cachedCommittedBytes -= entry.bytes.byteLength;
        entry.bytes = null;
      }
    }
  }

  async begin(params: ZCodeAgentAttachmentBeginParams): Promise<V4AttachmentBeginResult> {
    const now = Date.now();
    this.evictExpiredStaging(now);

    if (
      !Number.isInteger(params.totalBytes) ||
      params.totalBytes < 0 ||
      params.totalBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes
    ) {
      throw new Error("proto.payloadTooLarge");
    }
    if (
      !Number.isInteger(params.totalChunks) ||
      params.totalChunks < 0 ||
      params.totalChunks > PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks ||
      (params.totalBytes === 0) !== (params.totalChunks === 0)
    ) {
      throw new Error("proto.invalidUploadChunks");
    }
    if (!CHECKSUM_RE.test(params.checksum)) {
      throw new Error("proto.invalidChecksum");
    }

    const key = uploadKey(params.sessionId, params.uploadId);
    const alreadyCommitted = this.committedByUploadKey.get(key);
    if (alreadyCommitted) {
      return {
        uploadId: params.uploadId,
        state: "committed",
        nextChunkIndex: alreadyCommitted.totalChunks,
        ref: alreadyCommitted.ref,
      };
    }

    const existing = this.stagedUploads.get(key);
    if (existing) {
      existing.updatedAt = now;
      return {
        uploadId: params.uploadId,
        state: "staging",
        nextChunkIndex: existing.nextChunkIndex,
      };
    }

    if (this.stagedUploads.size >= PROTOCOL_V4_LIMITS.attachmentUploadMaxConcurrent) {
      throw new Error("fault.attachment.tooManyConcurrentUploads");
    }
    if (
      this.totalStagedDeclaredBytes() + params.totalBytes >
      PROTOCOL_V4_LIMITS.attachmentUploadMaxStagedBytes
    ) {
      throw new Error("fault.attachment.stagingQuotaExceeded");
    }

    this.stagedUploads.set(key, {
      sessionId: params.sessionId,
      uploadId: params.uploadId,
      fileName: params.fileName,
      mime: params.mime,
      totalBytes: params.totalBytes,
      totalChunks: params.totalChunks,
      checksum: params.checksum,
      chunks: [],
      receivedBytes: 0,
      nextChunkIndex: 0,
      updatedAt: now,
    });

    return {
      uploadId: params.uploadId,
      state: "staging",
      nextChunkIndex: 0,
    };
  }

  async chunk(params: ZCodeAgentAttachmentChunkParams): Promise<V4AttachmentChunkResult> {
    const key = uploadKey(params.sessionId, params.uploadId);
    const staged = this.stagedUploads.get(key);
    if (!staged) throw new Error("fault.attachment.uploadNotFound");

    if (params.chunkIndex < staged.nextChunkIndex) {
      staged.updatedAt = Date.now();
      return { uploadId: params.uploadId, nextChunkIndex: staged.nextChunkIndex };
    }
    if (params.chunkIndex !== staged.nextChunkIndex || params.chunkIndex >= staged.totalChunks) {
      throw new Error("fault.attachment.invalidChunkIndex");
    }

    const bytes = decodeStrictBase64(params.dataBase64);
    if (bytes.byteLength > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      throw new Error("proto.payloadTooLarge");
    }
    if (staged.receivedBytes + bytes.byteLength > staged.totalBytes) {
      throw new Error("fault.attachment.sizeMismatch");
    }

    staged.chunks.push(bytes);
    staged.receivedBytes += bytes.byteLength;
    staged.nextChunkIndex += 1;
    staged.updatedAt = Date.now();

    return {
      uploadId: params.uploadId,
      nextChunkIndex: staged.nextChunkIndex,
    };
  }

  async commit(params: ZCodeAgentAttachmentTerminalParams): Promise<V4AttachmentCommitResult> {
    const key = uploadKey(params.sessionId, params.uploadId);
    const alreadyCommitted = this.committedByUploadKey.get(key);
    if (alreadyCommitted) return { ref: alreadyCommitted.ref };

    const staged = this.stagedUploads.get(key);
    if (!staged) throw new Error("fault.attachment.uploadNotFound");
    if (staged.nextChunkIndex !== staged.totalChunks) {
      throw new Error("fault.attachment.incompleteUpload");
    }

    const combined = Buffer.concat(staged.chunks);
    if (combined.byteLength !== staged.totalBytes) {
      throw new Error("fault.attachment.sizeMismatch");
    }
    const actualHex = createHash("sha256").update(combined).digest("hex");
    if (`sha256:${actualHex}` !== staged.checksum) {
      throw new Error("fault.attachment.checksumMismatch");
    }

    const safeName = sanitizeFileName(staged.fileName);
    const ref = `pi-att://${actualHex}/${safeName}`;
    let diskPath: string | null = join(
      this.storageDir,
      `${actualHex}${safeExtension(staged.fileName, staged.mime)}`,
    );
    try {
      await mkdir(this.storageDir, { recursive: true });
      await writeFile(diskPath, combined);
    } catch {
      diskPath = null;
    }

    const existingCommitted = this.committedByRef.get(ref);
    if (existingCommitted) {
      existingCommitted.lastAccessAt = Date.now();
      if (!existingCommitted.bytes) {
        existingCommitted.bytes = combined;
        this.cachedCommittedBytes += combined.byteLength;
      }
    } else {
      this.committedByRef.set(ref, {
        ref,
        fileName: staged.fileName,
        mime: staged.mime,
        totalBytes: combined.byteLength,
        diskPath,
        bytes: combined,
        lastAccessAt: Date.now(),
      });
      this.cachedCommittedBytes += combined.byteLength;
    }

    this.trimCommittedMemoryCache();
    this.stagedUploads.delete(key);
    this.committedByUploadKey.set(key, { ref, totalChunks: staged.totalChunks });
    return { ref };
  }

  async abort(params: ZCodeAgentAttachmentTerminalParams): Promise<void> {
    this.stagedUploads.delete(uploadKey(params.sessionId, params.uploadId));
  }

  registerInlineAttachments(items: readonly HydratedPiInlineAttachment[]): void {
    for (const item of items) {
      if (this.inlineByRef.has(item.ref)) continue;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(item.dataBase64, "base64");
      } catch {
        continue;
      }
      if (this.inlineByRef.size >= MAX_CACHED_INLINE_ENTRIES) {
        const oldestKey = this.inlineByRef.keys().next().value;
        if (oldestKey !== undefined) this.inlineByRef.delete(oldestKey);
      }
      this.inlineByRef.set(item.ref, {
        fileName: item.fileName,
        mime: item.mime,
        bytes,
      });
    }
  }

  private async loadCommittedBytes(entry: CommittedAttachment): Promise<Buffer> {
    entry.lastAccessAt = Date.now();
    if (entry.bytes) return entry.bytes;
    if (entry.diskPath) {
      const loaded = await readFile(entry.diskPath);
      entry.bytes = loaded;
      this.cachedCommittedBytes += loaded.byteLength;
      this.trimCommittedMemoryCache();
      return loaded;
    }
    throw new Error("fault.attachment.notFound");
  }

  private async resolveStoredOrAuthorizedBytes(
    ref: string,
    context?: PiAttachmentReadContext,
    maxBytes: number = PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes,
  ): Promise<{ readonly bytes: Buffer; readonly mime: string }> {
    const committed = this.committedByRef.get(ref);
    if (committed) {
      return { bytes: await this.loadCommittedBytes(committed), mime: committed.mime };
    }
    const inline = this.inlineByRef.get(ref);
    if (inline) {
      return { bytes: inline.bytes, mime: inline.mime };
    }
    if (isAbsolute(ref)) {
      const authorizedMime = context?.authorizedLocalRefs?.get(ref);
      const allowed = authorizedMime !== undefined || isWithinDir(ref, this.storageDir);
      if (!allowed) throw new Error("fault.attachment.unauthorizedPath");
      const info = await stat(ref);
      if (!info.isFile()) throw new Error("fault.attachment.notFound");
      if (info.size > maxBytes) throw new Error("proto.payloadTooLarge");
      const bytes = await readFile(ref);
      return { bytes, mime: authorizedMime || inferMimeFromPath(ref) };
    }
    throw new Error("fault.attachment.notFound");
  }

  async previewSource(
    _params: ZCodeAgentAttachmentPreviewSourceParams,
  ): Promise<V4AttachmentPreviewSourceResult> {
    return { kind: "chunked" };
  }

  async readForPreview(
    params: ZCodeAgentAttachmentReadParams,
    context?: PiAttachmentReadContext,
  ): Promise<V4AttachmentReadResult> {
    const { bytes, mime } = await this.resolveStoredOrAuthorizedBytes(params.ref, context);
    const mediaType = normalizePreviewMediaType(mime);
    const totalBytes = bytes.byteLength;
    if (
      (mediaType.startsWith("image/") || mediaType === "text/plain") &&
      totalBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes
    ) {
      throw new Error("proto.payloadTooLarge");
    }
    const offset = Math.max(0, Math.min(params.offset, totalBytes));
    const limit = Math.max(1, Math.min(params.limit, PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes));
    const end = Math.min(offset + limit, totalBytes);
    return {
      dataBase64: bytes.subarray(offset, end).toString("base64"),
      mediaType,
      totalBytes,
      nextOffset: end < totalBytes ? end : null,
    };
  }

  async readForConversation(
    params: ZCodeAgentConversationAttachmentReadParams,
    context?: PiAttachmentReadContext,
  ): Promise<V4ConversationAttachmentReadResult> {
    const { bytes, mime } = await this.resolveStoredOrAuthorizedBytes(params.ref, context);
    const totalBytes = bytes.byteLength;
    const offset = Math.max(0, Math.min(params.offset, totalBytes));
    const limit = Math.max(1, Math.min(params.limit, PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes));
    const end = Math.min(offset + limit, totalBytes);
    return {
      dataBase64: bytes.subarray(offset, end).toString("base64"),
      mediaType: mime,
      totalBytes,
      nextOffset: end < totalBytes ? end : null,
    };
  }

  async statForConversation(
    params: ZCodeAgentConversationAttachmentStatParams,
    context?: PiAttachmentReadContext,
  ): Promise<V4ConversationAttachmentStatResult> {
    const committed = this.committedByRef.get(params.ref);
    if (committed) {
      return { mediaType: committed.mime, totalBytes: committed.totalBytes };
    }
    const inline = this.inlineByRef.get(params.ref);
    if (inline) {
      return { mediaType: inline.mime, totalBytes: inline.bytes.byteLength };
    }
    if (isAbsolute(params.ref)) {
      const authorizedMime = context?.authorizedLocalRefs?.get(params.ref);
      const allowed = authorizedMime !== undefined || isWithinDir(params.ref, this.storageDir);
      if (!allowed) throw new Error("fault.attachment.unauthorizedPath");
      const info = await stat(params.ref);
      if (!info.isFile()) throw new Error("fault.attachment.notFound");
      return {
        mediaType: authorizedMime || inferMimeFromPath(params.ref),
        totalBytes: info.size,
      };
    }
    throw new Error("fault.attachment.notFound");
  }

  /** 将 V4 AttachmentRef 列表解析为 Pi RPC `prompt/steer/follow_up` 可直接消费的正文与图片块。 */
  async resolvePromptPayload(
    text: string,
    attachments?: readonly AttachmentRef[] | undefined,
  ): Promise<ResolvedPiPromptPayload> {
    if (!attachments || attachments.length === 0) {
      return { message: text, images: [] };
    }

    const images: PiImageContent[] = [];
    const fileNotes: string[] = [];

    for (const att of attachments) {
      const mime = att.mime || inferMimeFromPath(att.fileName);
      if (mime.toLowerCase().startsWith("image/")) {
        const bytes = await this.readAttachmentBytesForSend(att.ref);
        if (bytes) {
          images.push({
            type: "image",
            data: bytes.toString("base64"),
            mimeType: normalizeImageMime(mime),
          });
          continue;
        }
      }

      const committed = this.committedByRef.get(att.ref);
      const diskPath = committed?.diskPath ?? (isAbsolute(att.ref) ? att.ref : null);
      if (diskPath) {
        fileNotes.push(`[Attached file: ${att.fileName} (${mime}) at ${diskPath}]`);
      } else {
        fileNotes.push(`[Attached file: ${att.fileName} (${mime})]`);
      }
    }

    const message =
      fileNotes.length > 0
        ? text.trim().length > 0
          ? `${text}\n\n${fileNotes.join("\n")}`
          : fileNotes.join("\n")
        : text;

    return { message, images };
  }

  private async readAttachmentBytesForSend(ref: string): Promise<Buffer | null> {
    const committed = this.committedByRef.get(ref);
    if (committed) {
      return this.loadCommittedBytes(committed).catch(() => null);
    }
    const inline = this.inlineByRef.get(ref);
    if (inline) return inline.bytes;
    if (isAbsolute(ref)) {
      try {
        const info = await stat(ref);
        if (!info.isFile() || info.size > PROTOCOL_V4_LIMITS.attachmentMaxBytes) return null;
        return await readFile(ref);
      } catch {
        return null;
      }
    }
    return null;
  }

  dispose(): void {
    this.stagedUploads.clear();
    this.committedByUploadKey.clear();
    this.committedByRef.clear();
    this.inlineByRef.clear();
    this.cachedCommittedBytes = 0;
  }
}
