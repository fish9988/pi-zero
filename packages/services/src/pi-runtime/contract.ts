/**
 * pi-runtime 公开契约：发现结果、RPC 客户端接口、握手探针、V4 适配器选项与进程托管类型。
 * 跨模块调用方只允许从本契约或 index.ts 导入；严禁反向导入 adapters/ 以避免环依赖。
 */
import type { IZCodeAgentService, ZCodeAgentSessionTarget } from "#src/zcode-agent/zcodeAgent.js";
import type {
  PiCommandInfo,
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

export type {
  PiModelCatalogSnapshot,
  PiThinkingCapability,
  PiThinkingLevelMap,
} from "#src/pi-runtime/domain/piModelCapability.js";

export type {
  BeginUserTurnInput,
  ProjectionCommit,
  RecordGuidedInputParams,
} from "#src/pi-runtime/domain/piEventProjector.js";

export interface PiModelCatalogOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly managedRuntimeDir?: string | undefined;
  readonly defaultCwd?: string | undefined;
  readonly ttlMs?: number | undefined;
}

export type PiPrepareSessionCreation = (
  target: Omit<ZCodeAgentSessionTarget, "sessionId"> & {
    sessionId?: string | undefined;
    projectId: string | null;
    creationCommand?: { clientId: string; commandId: string } | undefined;
    additionalDirectories?: string[] | undefined;
  },
) => Promise<{ sessionId: string; additionalDirectories: string[] }>;

export interface PiAgentServiceOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly managedRuntimeDir?: string | undefined;
  readonly prepareSessionCreation?: PiPrepareSessionCreation | undefined;
}

export interface PiDiscoveredSessionRecord {
  readonly sessionId: string;
  readonly cwd: string;
  readonly normalizedCwd: string;
  readonly file?: string | undefined;
  readonly title: string;
  readonly titleSource: "custom" | "default";
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly lastOutcome?: "completed" | "interrupted" | "error" | undefined;
  readonly parentSessionId?: string | undefined;
  readonly live: boolean;
}

export type PiAgentService = IZCodeAgentService & {
  disposeAllAndWait(): Promise<void>;
  /** 内部协作辅助：获取会话当前绑定的 `.jsonl` 路径（若存在）。 */
  getSessionFilePath?(workspacePath: string, sessionId: string): Promise<string | null>;
  /** 内部协作辅助：在安全停掉子进程并截断 `.jsonl` 后重新水合会话控制器。 */
  reloadSessionAfterRewind?(workspacePath: string, sessionId: string): Promise<void>;
  /** 内部协作辅助：向活跃或临时 Pi 进程拉取动态 `get_commands` 列表。 */
  listDynamicCommands?(workspacePath?: string): Promise<PiCommandInfo[]>;
  /** 内部协作辅助：扫描全部磁盘 `~/.pi/agent/sessions` 与内存活跃 Pi 会话，供项目/任务目录统一索引。 */
  listAllPiSessions?(): Promise<readonly PiDiscoveredSessionRecord[]>;
  /** 内部协作辅助：监听 `~/.pi/agent/sessions` 磁盘变更及内存 Pi 会话发布/删除，返回幂等清理函数。 */
  watchAllPiSessions?(onChange: () => void): () => void;
};
