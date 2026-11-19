/**
 * Pi 运行时在 Phase 1 (M2) 尚未接入的 IZCodeAgentService 旁路方法默认实现。
 * 被动只读查询返回严格符合 schema 的空结果以保证桌面无噪启动；写操作与未实现能力明确报错。
 */
import { Event as RpcEvent } from "@zcode/rpc";
import { resolveWorkspaceKey, type AppUsageSnapshot } from "@zcode/shared";
import { emptyInputPredictionResult } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";

function unsupported(operation: string): Promise<never> {
  return Promise.reject(new Error(`Pi runtime does not support "${operation}" yet`));
}

function emptyAppUsageSnapshot(
  range: AppUsageSnapshot["range"],
  timeZone?: string,
): AppUsageSnapshot {
  return {
    range,
    generatedAt: Date.now(),
    timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    source: "agent-db",
    summary: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      totalSessions: 0,
      totalTurns: 0,
      toolCallCount: 0,
      toolErrorRate: 0,
      modelErrorRate: 0,
      avgTimeToFirstTokenMs: null,
      avgTurnDurationMs: null,
      activeDays: 0,
      currentStreakDays: 0,
      longestSessionMs: 0,
      longestStreakDays: 0,
      peakDayTokens: 0,
      favoriteModel: null,
    },
    heatmap: {
      startDate: null,
      endDate: null,
      maxTokens: 0,
      weeks: [],
    },
    dailyModelUsage: [],
    models: [],
    tools: [],
  };
}

export type PiUnsupportedAgentMethods = Pick<
  IZCodeAgentService,
  | "prepareStorage"
  | "getStorageStartupState"
  | "onDynamicStorageStartupState"
  | "syncAppRuntimePreferences"
  | "syncDynamicWorkflowUserMode"
  | "listSessionSubagents"
  | "getAppUsageStats"
  | "supportsWorktreeCwd"
  | "supportsExtensionInputSource"
  | "supportsConversationQuoteComment"
  | "getTaskTokenUsage"
  | "readSessionMessages"
  | "readSessionDebug"
  | "readSessionEvents"
  | "readWorkspacePresentation"
  | "grantWorkspaceHookTrust"
  | "setWorkspaceMcpTrust"
  | "listMcpServerStatuses"
  | "listPlugins"
  | "getPluginReferenceCatalog"
  | "getSkillReferenceCatalog"
  | "openMcpUiInstance"
  | "validateMcpUiInstance"
  | "recycleMcpUiInstance"
  | "closeMcpUiInstance"
  | "readMcpResource"
  | "sampleMcpApp"
  | "cancelMcpAppSampling"
  | "callMcpToolForUi"
  | "cancelMcpToolCallForUi"
  | "readMcpResourceForUi"
  | "listMcpResourcesForUi"
  | "listMcpResourceTemplatesForUi"
  | "subscribeMcpResourceForUi"
  | "unsubscribeMcpResourceForUi"
  | "registerAppToolsForUi"
  | "unregisterAppToolsForUi"
  | "claimAppToolCallForUi"
  | "resolveAppToolCallForUi"
  | "listPluginUiSurfaces"
  | "listSavedWorkflows"
  | "getSavedWorkflow"
  | "updateSavedWorkflowMeta"
  | "deleteSavedWorkflow"
  | "listSavedWorkflowRuns"
  | "moveSavedWorkflow"
  | "saveSavedWorkflowFromRun"
  | "findSavedWorkflowForRun"
  | "resolveSuggestedPluginReference"
  | "onDynamicPluginOperationProgress"
  | "getPluginsOverview"
  | "collectLocalRuntimeChildProcesses"
  | "addPluginMarketplace"
  | "removePluginMarketplace"
  | "updatePluginMarketplace"
  | "installPlugin"
  | "cancelPluginOperation"
  | "uninstallPlugin"
  | "updatePlugin"
  | "restoreBuiltinPlugin"
  | "configurePlugin"
  | "resetPluginConfig"
  | "validatePlugin"
  | "describePlugin"
  | "setPluginEnabled"
  | "listAutomations"
  | "listAllAutomations"
  | "createAutomation"
  | "updateAutomation"
  | "deleteAutomation"
  | "setAutomationEnabled"
  | "restartAutomation"
  | "runAutomationNow"
  | "listAutomationRuns"
  | "deleteAutomationRun"
  | "generateWorkspaceText"
  | "testModelConnectivity"
  | "sendPrompt"
  | "compactSession"
  | "goalSession"
  | "setModel"
  | "setThoughtLevel"
  | "setMode"
  | "respondProviderRuntimeHeaders"
  | "respondSessionRuntimePreferences"
  | "onDynamicProviderRuntimeHeadersRequest"
  | "onDynamicWorkspaceProviderRuntimeHeadersRequest"
  | "onDynamicWorkspaceProviderRuntimeHeadersCancelled"
  | "onDynamicSessionRuntimePreferencesRequest"
  | "onDynamicProcessResourceSample"
  | "onDynamicPluginStartupDegraded"
  | "onDynamicRemoteConversationTelemetry"
  | "onDynamicMcpTelemetry"
  | "onDynamicMcpResourceSamples"
  | "onDynamicToolExecResource"
  | "onDynamicSessionEvent"
  | "conversationPlansV4"
  | "conversationInputPredictionV4"
  | "conversationWorkflowRunEventsV4"
  | "conversationWorkflowRunsV4"
  | "conversationWorkflowRunArtifactsV4"
  | "conversationWorkflowRunArtifactDataV4"
  | "conversationWorkflowRunArtifactReadV4"
  | "conversationWorkflowRunWorkspaceV4"
  | "conversationWorkflowRunNodeResultV4"
  | "backgroundBashOutputV4"
  | "conversationFileChangesV4"
  | "conversationFileRewindPreviewV4"
  | "attachmentBeginV4"
  | "attachmentChunkV4"
  | "attachmentCommitV4"
  | "attachmentAbortV4"
  | "attachmentPreviewSourceV4"
  | "attachmentReadV4"
  | "conversationAttachmentReadV4"
  | "conversationAttachmentStatV4"
  | "onDynamicLocalTtftFacts"
  | "onDynamicConversationTelemetryFact"
  | "getContextComposition"
  | "getPluginMentionItems"
  | "onDynamicContextCompositionChanged"
  | "onDynamicModelRequestMetrics"
  | "onDynamicOffPeakLifecycle"
  | "controlOffPeakExecutionV4"
  | "onDynamicCuaPermissionObservation"
  | "onDynamicPluginUiToolResult"
  | "hasActiveCuaOperationTurn"
>;

export function createPiUnsupportedAgentMethods(): PiUnsupportedAgentMethods {
  return {
    prepareStorage: async () => {},
    getStorageStartupState: async () => ({ generation: 1, state: null }),
    onDynamicStorageStartupState: () => RpcEvent.None,
    syncAppRuntimePreferences: async () => {},
    syncDynamicWorkflowUserMode: async () => {},
    listSessionSubagents: async () => ({
      revision: 0,
      childSessionIds: [],
      running: [],
      ended: { total: 0, items: [] },
    }),
    getAppUsageStats: async (params) => emptyAppUsageSnapshot(params.range, params.timeZone),
    supportsWorktreeCwd: async () => false,
    supportsExtensionInputSource: async () => false,
    supportsConversationQuoteComment: async () => false,
    getTaskTokenUsage: async (params) => ({
      sessionId: params.sessionId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    }),
    readSessionMessages: async () => [],
    readSessionDebug: () => unsupported("readSessionDebug"),
    readSessionEvents: async () => [],
    readWorkspacePresentation: async (params) => ({
      workspace: {
        workspacePath: params.workspacePath,
        workspaceKey: resolveWorkspaceKey(params),
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      },
      mode: "build",
      slashCommands: [],
    }),
    grantWorkspaceHookTrust: () => unsupported("grantWorkspaceHookTrust"),
    setWorkspaceMcpTrust: () => unsupported("setWorkspaceMcpTrust"),
    listMcpServerStatuses: async () => ({ statuses: {} }),
    listPlugins: async () => ({ plugins: [], diagnostics: [] }),
    getPluginReferenceCatalog: async (params) => ({
      authority: params.sessionId ? "session" : "workspace",
      plugins: [],
    }),
    getSkillReferenceCatalog: async (params) => ({
      authority: params.sessionId ? "session" : "workspace",
      skills: [],
    }),
    openMcpUiInstance: () => unsupported("openMcpUiInstance"),
    validateMcpUiInstance: async () => {},
    recycleMcpUiInstance: async () => false,
    closeMcpUiInstance: async () => {},
    readMcpResource: () => unsupported("readMcpResource"),
    sampleMcpApp: () => unsupported("sampleMcpApp"),
    cancelMcpAppSampling: async () => ({ cancelled: false }),
    callMcpToolForUi: () => unsupported("callMcpToolForUi"),
    cancelMcpToolCallForUi: () => unsupported("cancelMcpToolCallForUi"),
    readMcpResourceForUi: () => unsupported("readMcpResourceForUi"),
    listMcpResourcesForUi: () => unsupported("listMcpResourcesForUi"),
    listMcpResourceTemplatesForUi: () => unsupported("listMcpResourceTemplatesForUi"),
    subscribeMcpResourceForUi: async () => {},
    unsubscribeMcpResourceForUi: async () => {},
    registerAppToolsForUi: () => unsupported("registerAppToolsForUi"),
    unregisterAppToolsForUi: () => unsupported("unregisterAppToolsForUi"),
    claimAppToolCallForUi: () => unsupported("claimAppToolCallForUi"),
    resolveAppToolCallForUi: () => unsupported("resolveAppToolCallForUi"),
    listPluginUiSurfaces: async () => ({ surfaces: [] }),
    listSavedWorkflows: async (params) => ({
      workflows: [],
      invalid: [],
      dir: params.workspacePath || ".",
    }),
    getSavedWorkflow: () => unsupported("getSavedWorkflow"),
    updateSavedWorkflowMeta: () => unsupported("updateSavedWorkflowMeta"),
    deleteSavedWorkflow: () => unsupported("deleteSavedWorkflow"),
    listSavedWorkflowRuns: async () => ({ runs: [] }),
    moveSavedWorkflow: () => unsupported("moveSavedWorkflow"),
    saveSavedWorkflowFromRun: () => unsupported("saveSavedWorkflowFromRun"),
    findSavedWorkflowForRun: () => unsupported("findSavedWorkflowForRun"),
    resolveSuggestedPluginReference: () => unsupported("resolveSuggestedPluginReference"),
    onDynamicPluginOperationProgress: () => RpcEvent.None,
    getPluginsOverview: async () => ({
      marketplaces: [],
      availablePlugins: [],
      installedPlugins: [],
      restorableBuiltins: [],
      diagnostics: [],
      capability: { supported: false, reason: "Pi runtime does not host ZCode plugins" },
    }),
    collectLocalRuntimeChildProcesses: async () => [],
    addPluginMarketplace: () => unsupported("addPluginMarketplace"),
    removePluginMarketplace: () => unsupported("removePluginMarketplace"),
    updatePluginMarketplace: () => unsupported("updatePluginMarketplace"),
    installPlugin: () => unsupported("installPlugin"),
    cancelPluginOperation: () => unsupported("cancelPluginOperation"),
    uninstallPlugin: () => unsupported("uninstallPlugin"),
    updatePlugin: () => unsupported("updatePlugin"),
    restoreBuiltinPlugin: () => unsupported("restoreBuiltinPlugin"),
    configurePlugin: () => unsupported("configurePlugin"),
    resetPluginConfig: () => unsupported("resetPluginConfig"),
    validatePlugin: () => unsupported("validatePlugin"),
    describePlugin: () => unsupported("describePlugin"),
    setPluginEnabled: () => unsupported("setPluginEnabled"),
    listAutomations: async () => [],
    listAllAutomations: async () => [],
    createAutomation: () => unsupported("createAutomation"),
    updateAutomation: () => unsupported("updateAutomation"),
    deleteAutomation: async () => {},
    setAutomationEnabled: async () => {},
    restartAutomation: async () => {},
    runAutomationNow: () => unsupported("runAutomationNow"),
    listAutomationRuns: async () => [],
    deleteAutomationRun: async () => {},
    generateWorkspaceText: () => unsupported("generateWorkspaceText"),
    testModelConnectivity: () => unsupported("testModelConnectivity"),
    sendPrompt: () => unsupported("sendPrompt"),
    compactSession: () => unsupported("compactSession"),
    goalSession: () => unsupported("goalSession"),
    setModel: () => unsupported("setModel"),
    setThoughtLevel: () => unsupported("setThoughtLevel"),
    setMode: () => unsupported("setMode"),
    respondProviderRuntimeHeaders: async () => {},
    respondSessionRuntimePreferences: async () => {},
    onDynamicProviderRuntimeHeadersRequest: () => RpcEvent.None,
    onDynamicWorkspaceProviderRuntimeHeadersRequest: () => RpcEvent.None,
    onDynamicWorkspaceProviderRuntimeHeadersCancelled: () => RpcEvent.None,
    onDynamicSessionRuntimePreferencesRequest: () => RpcEvent.None,
    onDynamicProcessResourceSample: () => RpcEvent.None,
    onDynamicPluginStartupDegraded: () => RpcEvent.None,
    onDynamicRemoteConversationTelemetry: () => RpcEvent.None,
    onDynamicMcpTelemetry: () => RpcEvent.None,
    onDynamicMcpResourceSamples: () => RpcEvent.None,
    onDynamicToolExecResource: () => RpcEvent.None,
    onDynamicSessionEvent: () => RpcEvent.None,
    conversationPlansV4: async () => ({ plans: [], atSeq: 0, atLogEpoch: "pi-epoch-0" }),
    conversationInputPredictionV4: async (params) =>
      emptyInputPredictionResult("unavailable", params.requestId),
    conversationWorkflowRunEventsV4: async () => ({ events: [], hasMore: false }),
    conversationWorkflowRunsV4: async () => ({ runs: [] }),
    conversationWorkflowRunArtifactsV4: async () => ({ artifacts: [] }),
    conversationWorkflowRunArtifactDataV4: () =>
      unsupported("conversationWorkflowRunArtifactDataV4"),
    conversationWorkflowRunArtifactReadV4: () =>
      unsupported("conversationWorkflowRunArtifactReadV4"),
    conversationWorkflowRunWorkspaceV4: () => unsupported("conversationWorkflowRunWorkspaceV4"),
    conversationWorkflowRunNodeResultV4: () => unsupported("conversationWorkflowRunNodeResultV4"),
    backgroundBashOutputV4: () => unsupported("backgroundBashOutputV4"),
    conversationFileChangesV4: async () => ({
      files: 0,
      additions: 0,
      deletions: 0,
      items: [],
    }),
    conversationFileRewindPreviewV4: () => unsupported("conversationFileRewindPreviewV4"),
    attachmentBeginV4: () => unsupported("attachmentBeginV4"),
    attachmentChunkV4: () => unsupported("attachmentChunkV4"),
    attachmentCommitV4: () => unsupported("attachmentCommitV4"),
    attachmentAbortV4: async () => {},
    attachmentPreviewSourceV4: () => unsupported("attachmentPreviewSourceV4"),
    attachmentReadV4: () => unsupported("attachmentReadV4"),
    conversationAttachmentReadV4: () => unsupported("conversationAttachmentReadV4"),
    conversationAttachmentStatV4: () => unsupported("conversationAttachmentStatV4"),
    onDynamicLocalTtftFacts: () => RpcEvent.None,
    onDynamicConversationTelemetryFact: () => RpcEvent.None,
    getContextComposition: async () => null,
    getPluginMentionItems: async () => ({ supported: false }),
    onDynamicContextCompositionChanged: () => RpcEvent.None,
    onDynamicModelRequestMetrics: () => RpcEvent.None,
    onDynamicOffPeakLifecycle: () => RpcEvent.None,
    controlOffPeakExecutionV4: () => unsupported("controlOffPeakExecutionV4"),
    onDynamicCuaPermissionObservation: () => RpcEvent.None,
    onDynamicPluginUiToolResult: () => RpcEvent.None,
    hasActiveCuaOperationTurn: () => false,
  };
}
