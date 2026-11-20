import { isSettingsSectionEnabled, type SettingsSectionId } from "@/lib/settingsNavigation.js";

export interface SettingsSearchAvailability {
  desktop: boolean;
  macDesktop: boolean;
  windowsHost: boolean;
  tray: boolean;
  notWindows: boolean;
  workflow: boolean;
  computerUse: boolean;
}

// 翻译 key 同时作为稳定定位 id；索引只描述入口，不持有任何配置值。
const ALL_SETTINGS_SEARCH_ITEMS = [
  {
    id: "settings.taskAutoArchive",
    section: "archives",
    description: "settings.taskAutoArchiveDescription",
    visibility: "all",
  },
  {
    id: "settings.taskAutoArchiveDays",
    section: "archives",
    description: "settings.taskAutoArchiveDaysDescription",
    visibility: "all",
  },
  {
    id: "settings.locale",
    section: "general",
    description: "settings.localeDescription",
    visibility: "all",
  },
  {
    id: "settings.interfaceMode",
    section: "general",
    description: "settings.interfaceMode.description",
    visibility: "all",
  },
  {
    id: "settings.terminalProfile",
    section: "general",
    description: "settings.terminalProfileDescription",
    visibility: "all",
  },
  {
    id: "settings.terminalFontFamily",
    section: "general",
    description: "settings.terminalFontFamilyDescription",
    visibility: "all",
  },
  {
    id: "settings.integratedTerminalShell",
    section: "general",
    description: "settings.integratedTerminalShellDescription",
    visibility: "windowsHost",
  },
  {
    id: "settings.httpProxy",
    section: "general",
    description: "settings.httpProxyDescription",
    visibility: "all",
  },
  {
    id: "settings.httpProxyNoProxy",
    section: "general",
    description: "settings.httpProxyNoProxyDescription",
    visibility: "all",
  },
  {
    id: "settings.httpProxyCaCertPath",
    section: "general",
    description: "settings.httpProxyCaCertPathDescription",
    visibility: "all",
  },
  {
    id: "settings.desktopChromiumHardwareAcceleration",
    section: "general",
    description: "settings.desktopChromiumHardwareAccelerationDescription",
    visibility: "desktop",
  },
  {
    id: "settings.receivePreviewUpdates",
    section: "general",
    description: "settings.receivePreviewUpdatesDescription",
    visibility: "desktop",
  },
  {
    id: "settings.autoDownloadAndInstallUpdates",
    section: "general",
    description: "settings.autoDownloadAndInstallUpdatesDescription",
    visibility: "desktop",
  },
  {
    id: "settings.notification",
    section: "general",
    description: "settings.notificationDescription",
    visibility: "all",
  },
  {
    id: "settings.notificationSound",
    section: "general",
    description: "settings.notificationSoundDescription",
    visibility: "all",
  },
  {
    id: "settings.mobilePush",
    section: "general",
    description: "settings.mobilePushDescription",
    visibility: "desktop",
  },
  {
    id: "settings.closeToTrayOnWindows",
    section: "general",
    description: "settings.closeToTrayUnavailable",
    visibility: "tray",
  },
  {
    id: "settings.keepAwakeWhileRunning",
    section: "general",
    description: "settings.keepAwakeWhileRunningDescription",
    visibility: "desktop",
  },
  {
    id: "settings.dataBaseDir",
    section: "general",
    description: "settings.dataBaseDirDescription",
    visibility: "all",
  },
  {
    id: "settings.onboarding",
    section: "general",
    description: "settings.onboardingDescription",
    visibility: "all",
  },
  {
    id: "settings.toolSearch",
    section: "agentBehavior",
    description: "settings.toolSearchDescription",
    visibility: "all",
  },
  {
    id: "settings.nativeSearchEnhancements",
    section: "agentBehavior",
    description: "settings.nativeSearchEnhancementsDescription",
    visibility: "all",
  },
  {
    id: "settings.zcodeInteractionBehavior",
    section: "agentBehavior",
    description: "settings.zcodeInteractionBehaviorDescription",
    visibility: "all",
  },
  {
    id: "settings.askUserQuestionAutoResolution",
    section: "agentBehavior",
    description: "settings.askUserQuestionAutoResolutionDescription",
    visibility: "all",
  },
  {
    id: "settings.modelIoFullRetention",
    section: "agentBehavior",
    description: "settings.modelIoFullRetentionDescription",
    visibility: "all",
  },
  {
    id: "settings.messageStreamShowReasoning",
    section: "agentBehavior",
    description: "settings.messageStreamShowReasoningDescription",
    visibility: "all",
  },
  {
    id: "settings.messageStreamShowTodos",
    section: "agentBehavior",
    description: "settings.messageStreamShowTodosDescription",
    visibility: "all",
  },
  {
    id: "settings.contextCompression",
    section: "agentBehavior",
    description: "settings.contextCompression.engineDescription",
    visibility: "all",
  },
  {
    id: "settings.contextCompression.defaultEffectiveWindow",
    section: "agentBehavior",
    description: "settings.contextCompression.defaultEffectiveWindowDescription",
    visibility: "all",
  },
  // 模型设置分区顶部四行（docs/ui/default-model-and-subscription-ui.md）。
  {
    id: "settings.defaultModel",
    section: "modelProvider",
    description: "settings.defaultModelDescription",
    visibility: "all",
  },
  {
    id: "settings.preferDefaultModel",
    section: "modelProvider",
    description: "settings.preferDefaultModelDescription",
    visibility: "all",
  },
  {
    id: "settings.themeMode",
    section: "appearance",
    description: "settings.themeModeDescription",
    visibility: "all",
  },
  {
    id: "settings.fontSmoothing",
    section: "appearance",
    description: "settings.fontSmoothingDescription",
    visibility: "macDesktop",
  },
  {
    id: "settings.uiFontSize",
    section: "appearance",
    description: "settings.uiFontSizeDescription",
    visibility: "all",
  },
  {
    id: "settings.lightTheme",
    section: "appearance",
    description: "settings.lightThemeDescription",
    visibility: "all",
  },
  {
    id: "settings.darkTheme",
    section: "appearance",
    description: "settings.darkThemeDescription",
    visibility: "all",
  },
  {
    id: "settings.showLineNumbers",
    section: "appearance",
    description: "settings.showLineNumbersDescription",
    visibility: "all",
  },
  {
    id: "settings.wrapLongLines",
    section: "appearance",
    description: "settings.wrapLongLinesDescription",
    visibility: "all",
  },
  {
    id: "settings.fontSize",
    section: "appearance",
    description: "settings.fontSizeDescription",
    visibility: "all",
  },
  {
    id: "settings.browser.control.title",
    section: "browser",
    description: "settings.browser.control.description",
    visibility: "all",
  },
  {
    id: "settings.browser.import.title",
    section: "browser",
    description: "settings.browser.import.description",
    visibility: "notWindows",
  },
  {
    id: "settings.embeddedBrowserAllowInsecureCertificates",
    section: "browser",
    description: "settings.embeddedBrowserAllowInsecureCertificatesDescription",
    visibility: "desktop",
  },
  {
    id: "settings.browser.clearCache.title",
    section: "browser",
    description: "settings.browser.clearCache.description",
    visibility: "all",
  },
  {
    id: "settings.browser.clearAll.title",
    section: "browser",
    description: "settings.browser.clearAll.description",
    visibility: "all",
  },
  {
    id: "settings.computerUse.toggleLabel",
    section: "computerUse",
    description: "settings.computerUse.toggleDescription",
    visibility: "computerUse",
  },
  {
    id: "settings.computerUse.composerEntry.label",
    section: "computerUse",
    description: "settings.computerUse.composerEntry.description",
    visibility: "computerUse",
  },
  {
    id: "settings.memory.workspaceMemory",
    section: "memory",
    description: "settings.memoryDescription",
    visibility: "all",
  },
  {
    id: "settings.pluginAutoRecommendation",
    section: "agentBehavior",
    description: "settings.pluginAutoRecommendationDescription",
    visibility: "all",
  },
  {
    id: "settings.dynamicWorkflow",
    section: "agentBehavior",
    description: "settings.dynamicWorkflowDescription",
    visibility: "workflow",
  },
  {
    id: "chat.officeSuggestions.setting",
    section: "general",
    description: "chat.officeSuggestions.settingDescription",
    visibility: "all",
  },
  {
    id: "settings.browser.htmlClickOpensBrowser",
    section: "browser",
    description: "settings.browser.htmlClickOpensBrowserDescription",
    visibility: "desktop",
  },
  // Pi 6 大核心设置分区检索索引
  {
    id: "settings.piRuntime.cliStatus",
    section: "pi-runtime",
    description: "settings.piRuntime.cliStatusDescription",
    visibility: "all",
  },
  {
    id: "settings.piRuntime.agentDir",
    section: "pi-runtime",
    description: "settings.piRuntime.agentDirDescription",
    visibility: "all",
  },
  {
    id: "settings.piRuntime.defaultShell",
    section: "pi-runtime",
    description: "settings.piRuntime.defaultShellDescription",
    visibility: "all",
  },
  {
    id: "settings.piCredentials.oauthLogin",
    section: "pi-credentials",
    description: "settings.piCredentials.oauthLoginDescription",
    visibility: "all",
  },
  {
    id: "settings.piCredentials.apiKeys",
    section: "pi-credentials",
    description: "settings.piCredentials.apiKeysDescription",
    visibility: "all",
  },
  {
    id: "settings.piCredentials.envVars",
    section: "pi-credentials",
    description: "settings.piCredentials.envVarsDescription",
    visibility: "all",
  },
  {
    id: "settings.piContext.systemDocs",
    section: "pi-context",
    description: "settings.piContext.systemDocsDescription",
    visibility: "all",
  },
  {
    id: "settings.piContext.compaction",
    section: "pi-context",
    description: "settings.piContext.compactionDescription",
    visibility: "all",
  },
  {
    id: "settings.piContext.queueMode",
    section: "pi-context",
    description: "settings.piContext.queueModeDescription",
    visibility: "all",
  },
  {
    id: "settings.piContext.enabledModels",
    section: "pi-context",
    description: "settings.piContext.enabledModelsDescription",
    visibility: "all",
  },
  {
    id: "settings.piExtensions.subagent",
    section: "pi-extensions",
    description: "settings.piExtensions.subagentDescription",
    visibility: "all",
  },
  {
    id: "settings.piExtensions.packages",
    section: "pi-extensions",
    description: "settings.piExtensions.packagesDescription",
    visibility: "all",
  },
  {
    id: "settings.piExtensions.builtin",
    section: "pi-extensions",
    description: "settings.piExtensions.builtinDescription",
    visibility: "all",
  },
  {
    id: "settings.piExtensions.skills",
    section: "pi-extensions",
    description: "settings.piExtensions.skillsDescription",
    visibility: "all",
  },
  {
    id: "settings.piExtensions.prompts",
    section: "pi-extensions",
    description: "settings.piExtensions.promptsDescription",
    visibility: "all",
  },
  {
    id: "settings.piMcpTools.mcpServers",
    section: "pi-mcp-tools",
    description: "settings.piMcpTools.mcpServersDescription",
    visibility: "all",
  },
  {
    id: "settings.piMcpTools.builtinTools",
    section: "pi-mcp-tools",
    description: "settings.piMcpTools.builtinToolsDescription",
    visibility: "all",
  },
  {
    id: "settings.piMcpTools.codeMode",
    section: "pi-mcp-tools",
    description: "settings.piMcpTools.codeModeDescription",
    visibility: "all",
  },
  {
    id: "settings.piKeybindingsNetwork.transport",
    section: "pi-keybindings-network",
    description: "settings.piKeybindingsNetwork.transportDescription",
    visibility: "all",
  },
  {
    id: "settings.piKeybindingsNetwork.keybindings",
    section: "pi-keybindings-network",
    description: "settings.piKeybindingsNetwork.keybindingsDescription",
    visibility: "all",
  },
  {
    id: "settings.piKeybindingsNetwork.fileSearchExcludes",
    section: "pi-keybindings-network",
    description: "settings.piKeybindingsNetwork.fileSearchExcludesDescription",
    visibility: "all",
  },
] as const satisfies readonly {
  id: string;
  section: SettingsSectionId;
  description: string | undefined;
  visibility: "all" | keyof SettingsSearchAvailability;
}[];

export type SettingsSearchId = (typeof ALL_SETTINGS_SEARCH_ITEMS)[number]["id"];

export const SETTINGS_SEARCH_ITEMS = ALL_SETTINGS_SEARCH_ITEMS.filter((item) =>
  isSettingsSectionEnabled(item.section),
);
