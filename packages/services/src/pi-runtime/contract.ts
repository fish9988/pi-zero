/**
 * pi-runtime 公开契约：发现结果、RPC 客户端接口、握手探针与进程托管类型。
 * 跨模块调用方只允许从本契约或 index.ts 导入。
 */
import type {
  PiExtensionUiResponsePayload,
  PiModelInfo,
  PiRpcEvent,
  PiStateData,
} from "#src/pi-runtime/domain/piRpcTypes.js";

export type {
  PiAgentMessage,
  PiAssistantMessage,
  PiAssistantMessageEvent,
  PiAssistantStopReason,
  PiBashExecutionMessage,
  PiBuiltinToolName,
  PiCommandInfo,
  PiCompactResult,
  PiCompactionReason,
  PiContentBlock,
  PiCustomAgentMessage,
  PiEditToolArgs,
  PiEditToolItem,
  PiEditToolResultDetails,
  PiExtensionUiRequestEvent,
  PiExtensionUiResponsePayload,
  PiImageContent,
  PiModelInfo,
  PiPromptDisposition,
  PiQueueDisposition,
  PiRpcCommandType,
  PiRpcEvent,
  PiRpcResponse,
  PiRpcResponseFailure,
  PiRpcResponseSuccess,
  PiSessionEntry,
  PiSessionEntryBase,
  PiSessionHeaderEntry,
  PiSessionStats,
  PiStateData,
  PiSystemMessage,
  PiTextContent,
  PiThinkingContent,
  PiThinkingLevel,
  PiToolCallContent,
  PiToolResultMessage,
  PiTreeNode,
  PiUsage,
  PiUsageCost,
  PiUserMessage,
} from "#src/pi-runtime/domain/piRpcTypes.js";

export interface PiLaunch {
  command: string;
  prefixArgs: string[];
  env: Record<string, string>;
  displayPath: string;
}

export interface PiDiscoverOptions {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  managedRuntimeDir?: string | undefined;
  allowTestOverride?: boolean | undefined;
}

export type PiVersionProbeResult =
  | { ok: true; version: string; launch: PiLaunch }
  | { ok: false; message: string; launch: PiLaunch | null };

export type PiProcessContainment = "windows-runtime-host" | "direct-process-tree";

export interface PiRpcSpawnOptions {
  launch: PiLaunch;
  cwd: string;
  sessionFile?: string | undefined;
  sessionDir?: string | undefined;
  forkFrom?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  thinkingLevel?: string | undefined;
  noSession?: boolean | undefined;
  sessionName?: string | undefined;
  extraArgs?: readonly string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  defaultTimeoutMs?: number | undefined;
  traceId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface PiRpcExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface PiHandshakeProbeOptions {
  cwd: string;
  agentDir?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  managedRuntimeDir?: string | undefined;
  timeoutMs?: number | undefined;
  traceId?: string | undefined;
}

export type PiHandshakeProbeResult =
  | {
      ok: true;
      version: string;
      launchPath: string;
      containment: PiProcessContainment;
      state: PiStateData;
      models: PiModelInfo[];
      durationMs: number;
    }
  | {
      ok: false;
      stage: "discover" | "version" | "spawn" | "handshake";
      message: string;
      durationMs: number;
    };

export interface IPiRpcClient {
  readonly pid: number | undefined;
  readonly alive: boolean;
  readonly containment: PiProcessContainment;
  readonly stderrTail: string;
  onEvent(listener: (event: PiRpcEvent) => void): () => void;
  onExit(listener: (info: PiRpcExitInfo) => void): () => void;
  onParseError(listener: (error: string) => void): () => void;
  request<T = unknown>(
    type: string,
    params?: Readonly<Record<string, unknown>>,
    timeoutMs?: number | null,
  ): Promise<T>;
  sendExtensionUiResponse(response: PiExtensionUiResponsePayload): void;
  closeAndWait(timeoutMs?: number): Promise<void>;
}
