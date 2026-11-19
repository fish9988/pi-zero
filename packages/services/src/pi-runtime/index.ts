/**
 * pi-runtime 公开入口：跨平台 `pi` 发现、严格 LF JSONL RPC 客户端、握手探针与进程表清理。
 */
export type {
  IPiRpcClient,
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
  PiDiscoverOptions,
  PiEditToolArgs,
  PiEditToolItem,
  PiEditToolResultDetails,
  PiExtensionUiRequestEvent,
  PiExtensionUiResponsePayload,
  PiHandshakeProbeOptions,
  PiHandshakeProbeResult,
  PiImageContent,
  PiLaunch,
  PiModelInfo,
  PiProcessContainment,
  PiPromptDisposition,
  PiQueueDisposition,
  PiRpcCommandType,
  PiRpcEvent,
  PiRpcExitInfo,
  PiRpcResponse,
  PiRpcResponseFailure,
  PiRpcResponseSuccess,
  PiRpcSpawnOptions,
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
  PiVersionProbeResult,
} from "#src/pi-runtime/contract.js";

export { isPiRecord } from "#src/pi-runtime/domain/piRpcTypes.js";

export {
  discoverPi,
  formatRedactedPiError,
  getTestPiOverride,
  parsePiCmdShim,
  probePiVersion,
  resolvePiAgentDir,
  setTestPiOverride,
} from "#src/pi-runtime/adapters/piDiscover.js";

export { PiRpcClient, PiRpcError } from "#src/pi-runtime/adapters/piRpcClient.js";

export {
  disposeAllPiProcesses,
  disposeAllPiProcessesAndWait,
  getActivePiProcessCount,
} from "#src/pi-runtime/adapters/piProcessRegistry.js";

export { probePiRpcHandshake } from "#src/pi-runtime/adapters/piHandshakeProbe.js";
