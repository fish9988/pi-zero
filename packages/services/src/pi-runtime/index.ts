/**
 * pi-runtime 公开入口：跨平台 `pi` 发现、严格 LF JSONL RPC 客户端、握手探针与进程表清理。
 */
export type {
  BeginUserTurnInput,
  IPiRpcClient,
  PiAgentMessage,
  PiAgentService,
  PiAgentServiceOptions,
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
  PiModelCatalogOptions,
  PiModelCatalogSnapshot,
  PiModelInfo,
  PiPrepareSessionCreation,
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
  PiThinkingCapability,
  PiThinkingContent,
  PiThinkingLevel,
  PiThinkingLevelMap,
  PiToolCallContent,
  PiToolResultMessage,
  PiTreeNode,
  PiUsage,
  PiUsageCost,
  PiUserMessage,
  PiVersionProbeResult,
  ProjectionCommit,
  RecordGuidedInputParams,
} from "#src/pi-runtime/contract.js";

export { isPiRecord } from "#src/pi-runtime/domain/piRpcTypes.js";

export {
  PI_THINKING_LEVEL_ORDER,
  buildWorkspaceConfigStateFromPiModels,
  clampPiThinkingLevel,
  getSupportedThinkingLevels,
  mergePiModelsIntoSelectionView,
  piModelsToModelSelectionProviders,
  pickDefaultThinkingLevel,
} from "#src/pi-runtime/domain/piModelCapability.js";

export { PiEventProjector } from "#src/pi-runtime/domain/piEventProjector.js";

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
  registerActivePiProcess,
  unregisterActivePiProcess,
  type DisposablePiProcess,
} from "#src/pi-runtime/adapters/piProcessRegistry.js";

export {
  PiSessionIndexScanner,
  encodePiSessionBucketDir,
  normalizeWorkspacePathKey,
} from "#src/pi-runtime/adapters/piSessionIndexScanner.js";

export { probePiRpcHandshake } from "#src/pi-runtime/adapters/piHandshakeProbe.js";

export {
  PiModelCatalog,
  createPiAugmentedModelSelectionService,
} from "#src/pi-runtime/adapters/piModelCatalog.js";

export { createPiAgentService } from "#src/pi-runtime/adapters/piAgentService.js";

export {
  applyPiExtensionUiEvent,
  clearPiSessionExtensionUiState,
  getPiSessionExtensionUiSnapshot,
  stripAnsiSequences,
  subscribePiExtensionUiState,
} from "#src/pi-runtime/adapters/piExtensionUiStateStore.js";
