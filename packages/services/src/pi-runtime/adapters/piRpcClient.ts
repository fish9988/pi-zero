/**
 * `pi --mode rpc` 子进程 JSONL RPC 客户端与全局活跃进程注册表。
 *
 * 硬性约束：
 * - 严格按 `\n` 切帧（剥离可选末尾 `\r`），禁用 `readline` 以保护正文中的 U+2028/U+2029；
 * - 按请求唯一 `id` 关联响应，不依赖 FIFO；
 * - stderr 与错误文本统一经 `redactAgentDiagnosticSecrets` 脱敏；
 * - 所有活跃实例统一登记在进程表中，供 `disposeAllPiProcessesAndWait()` 在桌面退出时零孤儿回收。
 */
import { StringDecoder } from "node:string_decoder";
import { redactAgentDiagnosticSecrets } from "@zcode/shared/agent-crash-diagnostic";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  IPiRpcClient,
  PiAgentMessage,
  PiCommandInfo,
  PiCompactResult,
  PiExtensionUiResponsePayload,
  PiImageContent,
  PiModelInfo,
  PiProcessContainment,
  PiPromptDisposition,
  PiQueueDisposition,
  PiRpcEvent,
  PiRpcExitInfo,
  PiRpcSpawnOptions,
  PiSessionStats,
  PiStateData,
  PiTreeNode,
} from "#src/pi-runtime/contract.js";
import { isPiRecord } from "#src/pi-runtime/domain/piRpcTypes.js";
import { formatRedactedPiError } from "#src/pi-runtime/adapters/piDiscover.js";
import {
  registerActivePiProcess,
  unregisterActivePiProcess,
} from "#src/pi-runtime/adapters/piProcessRegistry.js";
import {
  buildPiRpcArgs,
  spawnPiProcess,
  type SpawnedPiProcess,
} from "#src/pi-runtime/adapters/piProcessSpawn.js";

const logger = createServiceLogger("pi-runtime");

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const MAX_STDERR_CHARS = 8_192;

export class PiRpcError extends Error {
  readonly command: string;
  readonly requestId: string | undefined;

  constructor(message: string, command: string, requestId?: string) {
    super(redactAgentDiagnosticSecrets(message));
    this.name = "PiRpcError";
    this.command = command;
    this.requestId = requestId;
  }
}

interface PendingCommand {
  command: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class PiRpcClient implements IPiRpcClient {
  private readonly proc: SpawnedPiProcess;
  private readonly defaultTimeoutMs: number;
  private readonly traceId: string | undefined;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly eventListeners = new Set<(event: PiRpcEvent) => void>();
  private readonly exitListeners = new Set<(info: PiRpcExitInfo) => void>();
  private readonly parseErrorListeners = new Set<(error: string) => void>();
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private stderrRing = "";
  private nextRequestId = 0;
  private exited = false;
  private closingPromise: Promise<void> | null = null;

  private constructor(proc: SpawnedPiProcess, defaultTimeoutMs: number, traceId?: string) {
    this.proc = proc;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.traceId = traceId;

    const child = proc.child;
    child.stdin.on("error", () => {
      // 子进程异步退出时忽略 stdin EPIPE/EOF。
    });

    child.stdout.on("data", (chunk: Buffer) => {
      this.consumeStdoutChunk(this.stdoutDecoder.write(chunk));
    });

    child.stdout.on("end", () => {
      const tail = this.stdoutDecoder.end();
      if (tail.length > 0) {
        this.consumeStdoutChunk(tail);
      }
      this.flushTrailingStdoutLine();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.appendRedactedStderr(this.stderrDecoder.write(chunk));
    });

    child.stderr.on("end", () => {
      const tail = this.stderrDecoder.end();
      if (tail.length > 0) {
        this.appendRedactedStderr(tail);
      }
    });

    child.on("error", (err) => {
      this.failAllPending(
        new Error(`Failed to spawn pi RPC process: ${formatRedactedPiError(err)}`),
      );
    });

    // 等 child "close"（确保 stdout/stderr 已完全排空）后再结算退出事件，
    // 并优先取 Windows runtime host 报告的真实根进程退出码，消除命名管道与 stdout 竞态。
    child.on("close", (hostCode, hostSignal) => {
      this.exited = true;
      unregisterActivePiProcess(this);
      const rootExit = this.proc.getRootExit();
      const code = rootExit?.code ?? hostCode;
      const signal = rootExit?.signal ?? hostSignal;
      const stderrSummary = redactAgentDiagnosticSecrets(this.stderrRing.trim());
      const detail = stderrSummary !== "" ? `: ${stderrSummary}` : "";
      this.failAllPending(
        new Error(
          `pi RPC process exited (code=${String(code)}, signal=${String(signal)})${detail}`,
        ),
      );
      for (const listener of this.exitListeners) {
        listener({ code, signal, stderr: stderrSummary });
      }
    });
  }

  static async spawn(options: PiRpcSpawnOptions): Promise<PiRpcClient> {
    const args = buildPiRpcArgs(options);
    const childEnv: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      ...options.launch.env,
    };

    const proc = await spawnPiProcess({
      command: options.launch.command,
      args,
      cwd: options.cwd,
      env: childEnv,
      signal: options.signal,
      traceId: options.traceId,
    });

    const client = new PiRpcClient(
      proc,
      options.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      options.traceId,
    );
    registerActivePiProcess(client);

    try {
      await proc.start();
    } catch (error) {
      unregisterActivePiProcess(client);
      await proc.closeAndWait(0).catch(() => {});
      throw error;
    }

    logger.debug(options.traceId, "Pi RPC process started", {
      pid: client.pid,
      containment: client.containment,
      noSession: options.noSession === true,
    });
    return client;
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  get alive(): boolean {
    return !this.exited && this.closingPromise === null;
  }

  get containment(): PiProcessContainment {
    return this.proc.containment;
  }

  get stderrTail(): string {
    return redactAgentDiagnosticSecrets(this.stderrRing);
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onExit(listener: (info: PiRpcExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  onParseError(listener: (error: string) => void): () => void {
    this.parseErrorListeners.add(listener);
    return () => {
      this.parseErrorListeners.delete(listener);
    };
  }

  request<T = unknown>(
    type: string,
    params?: Readonly<Record<string, unknown>>,
    timeoutMs: number | null = this.defaultTimeoutMs,
  ): Promise<T> {
    if (this.exited || this.closingPromise !== null) {
      return Promise.reject(
        new Error(`Cannot send "${type}": pi RPC process is closing or has exited`),
      );
    }

    const id = `req_${++this.nextRequestId}`;
    const record: Record<string, unknown> = {
      ...params,
      id,
      type,
    };
    const payload = `${JSON.stringify(record)}\n`;

    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs !== null && timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new PiRpcError(`RPC command "${type}" timed out after ${timeoutMs}ms`, type, id),
              );
            }, timeoutMs)
          : null;

      this.pending.set(id, {
        command: type,
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });

      try {
        this.proc.child.stdin.write(payload, "utf8", (writeErr) => {
          if (writeErr !== null && writeErr !== undefined) {
            const entry = this.pending.get(id);
            if (entry !== undefined) {
              this.pending.delete(id);
              if (entry.timer !== null) clearTimeout(entry.timer);
              entry.reject(
                new Error(
                  `Failed to write RPC command "${type}": ${formatRedactedPiError(writeErr)}`,
                ),
              );
            }
          }
        });
      } catch (err) {
        this.pending.delete(id);
        if (timer !== null) clearTimeout(timer);
        reject(new Error(`Failed to write RPC command "${type}": ${formatRedactedPiError(err)}`));
      }
    });
  }

  // ───────── 类型化 RPC 命令方法（Pi v1.5.2） ─────────

  getState(): Promise<PiStateData> {
    return this.request<PiStateData>("get_state");
  }

  getMessages(): Promise<{ messages: PiAgentMessage[] }> {
    return this.request<{ messages: PiAgentMessage[] }>("get_messages");
  }

  getAvailableModels(): Promise<{ models: PiModelInfo[] }> {
    return this.request<{ models: PiModelInfo[] }>("get_available_models");
  }

  getAvailableThinkingLevels(): Promise<{ levels: string[] }> {
    return this.request<{ levels: string[] }>("get_available_thinking_levels");
  }

  getCommands(): Promise<{ commands: PiCommandInfo[] }> {
    return this.request<{ commands: PiCommandInfo[] }>("get_commands");
  }

  getSessionStats(): Promise<PiSessionStats> {
    return this.request<PiSessionStats>("get_session_stats");
  }

  prompt(
    message: string,
    options?: {
      images?: readonly PiImageContent[] | undefined;
      streamingBehavior?: "steer" | "followUp" | undefined;
    },
  ): Promise<{ disposition: PiPromptDisposition }> {
    return this.request<{ disposition: PiPromptDisposition }>("prompt", {
      message,
      ...(options?.images !== undefined && options.images.length > 0
        ? { images: options.images }
        : {}),
      ...(options?.streamingBehavior !== undefined
        ? { streamingBehavior: options.streamingBehavior }
        : {}),
    });
  }

  steer(
    message: string,
    options?: { images?: readonly PiImageContent[] | undefined },
  ): Promise<{ disposition: PiQueueDisposition }> {
    return this.request<{ disposition: PiQueueDisposition }>("steer", {
      message,
      ...(options?.images !== undefined && options.images.length > 0
        ? { images: options.images }
        : {}),
    });
  }

  followUp(
    message: string,
    options?: { images?: readonly PiImageContent[] | undefined },
  ): Promise<{ disposition: PiQueueDisposition }> {
    return this.request<{ disposition: PiQueueDisposition }>("follow_up", {
      message,
      ...(options?.images !== undefined && options.images.length > 0
        ? { images: options.images }
        : {}),
    });
  }

  async abort(): Promise<void> {
    await this.request("abort", undefined, 30_000);
  }

  clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.request<{ steering: string[]; followUp: string[] }>("clear_queue");
  }

  newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }>(
      "new_session",
      parentSession !== undefined ? { parentSession } : undefined,
    );
  }

  switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }>("switch_session", { sessionPath });
  }

  setModel(provider: string, modelId: string): Promise<PiModelInfo> {
    return this.request<PiModelInfo>("set_model", { provider, modelId });
  }

  cycleModel(): Promise<{ model: PiModelInfo; thinkingLevel: string; isScoped: boolean } | null> {
    return this.request<{ model: PiModelInfo; thinkingLevel: string; isScoped: boolean } | null>(
      "cycle_model",
    );
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.request("set_thinking_level", { level });
  }

  cycleThinkingLevel(): Promise<{ level: string } | null> {
    return this.request<{ level: string } | null>("cycle_thinking_level");
  }

  compact(customInstructions?: string): Promise<PiCompactResult> {
    return this.request<PiCompactResult>(
      "compact",
      customInstructions !== undefined && customInstructions !== ""
        ? { customInstructions }
        : undefined,
      null,
    );
  }

  exportHtml(outputPath?: string): Promise<{ path: string }> {
    return this.request<{ path: string }>(
      "export_html",
      outputPath !== undefined && outputPath !== "" ? { outputPath } : undefined,
    );
  }

  fork(entryId: string): Promise<{ text?: string | undefined; cancelled: boolean }> {
    return this.request<{ text?: string | undefined; cancelled: boolean }>("fork", { entryId });
  }

  clone(): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }>("clone");
  }

  getForkMessages(): Promise<{ messages: { entryId: string; text: string }[] }> {
    return this.request<{ messages: { entryId: string; text: string }[] }>("get_fork_messages");
  }

  getTree(): Promise<{ tree: PiTreeNode[]; leafId: string | null }> {
    return this.request<{ tree: PiTreeNode[]; leafId: string | null }>("get_tree");
  }

  getEntries(options?: { since?: string | undefined }): Promise<{
    entries: Record<string, unknown>[];
    leafId?: string | null | undefined;
  }> {
    return this.request<{
      entries: Record<string, unknown>[];
      leafId?: string | null | undefined;
    }>("get_entries", options?.since !== undefined ? { since: options.since } : undefined);
  }

  getLastAssistantText(): Promise<{ text: string | null }> {
    return this.request<{ text: string | null }>("get_last_assistant_text");
  }

  async setSessionName(name: string): Promise<void> {
    await this.request("set_session_name", { name });
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.request("set_steering_mode", { mode });
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.request("set_follow_up_mode", { mode });
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.request("set_auto_compaction", { enabled });
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.request("set_auto_retry", { enabled });
  }

  async abortRetry(): Promise<void> {
    await this.request("abort_retry");
  }

  bash(
    command: string,
    excludeFromContext?: boolean,
  ): Promise<{
    output: string;
    exitCode: number;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath?: string | undefined;
  }> {
    return this.request(
      "bash",
      {
        command,
        ...(excludeFromContext !== undefined ? { excludeFromContext } : {}),
      },
      null,
    );
  }

  async abortBash(): Promise<void> {
    await this.request("abort_bash");
  }

  sendExtensionUiResponse(response: PiExtensionUiResponsePayload): void {
    if (this.exited || this.closingPromise !== null) return;
    const record = {
      type: "extension_ui_response",
      ...response,
    };
    try {
      this.proc.child.stdin.write(`${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // 关闭阶段忽略写入失败。
    }
  }

  closeAndWait(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<void> {
    if (this.exited) {
      unregisterActivePiProcess(this);
      return Promise.resolve();
    }
    this.closingPromise ??= this.proc.closeAndWait(timeoutMs).finally(() => {
      unregisterActivePiProcess(this);
      logger.debug(this.traceId, "Pi RPC process closed", { pid: this.pid });
    });
    return this.closingPromise;
  }

  // ───────── 严格 LF（\n）切帧与分发 ─────────

  private consumeStdoutChunk(chunkText: string): void {
    this.stdoutBuffer += chunkText;
    let lfIndex = this.stdoutBuffer.indexOf("\n");
    while (lfIndex !== -1) {
      let line = this.stdoutBuffer.slice(0, lfIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(lfIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.length > 0) {
        this.handleStdoutLine(line);
      }
      lfIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private flushTrailingStdoutLine(): void {
    let line = this.stdoutBuffer;
    this.stdoutBuffer = "";
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (line.length > 0) {
      this.handleStdoutLine(line);
    }
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isPiRecord(parsed) || typeof parsed["type"] !== "string") {
      return;
    }

    if (parsed["type"] === "response") {
      const id = typeof parsed["id"] === "string" ? parsed["id"] : undefined;
      const command = typeof parsed["command"] === "string" ? parsed["command"] : "unknown";
      const success = parsed["success"] === true;
      const rawErrText =
        typeof parsed["error"] === "string" ? parsed["error"] : `RPC command "${command}" failed`;
      const errText = redactAgentDiagnosticSecrets(rawErrText);

      if (id !== undefined) {
        const pending = this.pending.get(id);
        if (pending !== undefined) {
          this.pending.delete(id);
          if (pending.timer !== null) clearTimeout(pending.timer);
          if (success) {
            pending.resolve(parsed["data"]);
          } else {
            pending.reject(new PiRpcError(errText, command, id));
          }
        }
      } else if (!success) {
        for (const listener of this.parseErrorListeners) {
          listener(errText);
        }
      }
      return;
    }

    const event = parsed as unknown as PiRpcEvent;
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private appendRedactedStderr(text: string): void {
    this.stderrRing += redactAgentDiagnosticSecrets(text);
    if (this.stderrRing.length > MAX_STDERR_CHARS) {
      this.stderrRing = this.stderrRing.slice(this.stderrRing.length - MAX_STDERR_CHARS);
    }
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
