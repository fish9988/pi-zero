/**
 * Pi 1.5.2+ 运行时、settings.json、只写凭据（auth.json / .env）与 models.json 核心契约类型（浏览器安全）。
 */

export type PiConfigScope = "global" | "project";

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type PiMcpExposure = "codemode" | "deferred" | "direct" | "hidden";

export const PI_MCP_EXPOSURES: readonly PiMcpExposure[] = [
  "codemode",
  "deferred",
  "direct",
  "hidden",
];

export type PiBuiltinToolId =
  | "read"
  | "bash"
  | "powershell"
  | "edit"
  | "write"
  | "grep"
  | "find"
  | "ls"
  | "codemode"
  | "tool_search";

export const PI_BUILTIN_TOOLS: readonly PiBuiltinToolId[] = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "codemode",
  "tool_search",
];

export type PiBuiltinExtensionId =
  | "builtin:mcp"
  | "builtin:codemode"
  | "builtin:tool-search"
  | "builtin:llama.cpp";

export const PI_BUILTIN_EXTENSIONS: readonly PiBuiltinExtensionId[] = [
  "builtin:mcp",
  "builtin:codemode",
  "builtin:tool-search",
  "builtin:llama.cpp",
];

export type PiSystemDocKind = "AGENTS.md" | "SYSTEM.md" | "APPEND_SYSTEM.md";

export const PI_SYSTEM_DOC_KINDS: readonly PiSystemDocKind[] = [
  "AGENTS.md",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
];

export type PiConfigFileKind =
  | "settings.json"
  | "models.json"
  | "mcp.json"
  | "keybindings.json"
  | "auth.json";

export interface PiRuntimeStatus {
  readonly found: boolean;
  readonly source: "test" | "managed" | "path" | "none";
  readonly command: string | null;
  readonly cliPath: string | null;
  readonly version: string | null;
  readonly agentDir: string;
  readonly managedRuntimeDir: string;
  readonly healthy: boolean;
  readonly error?: string | undefined;
}

export interface PiRuntimeInstallResult {
  readonly ok: boolean;
  readonly status: PiRuntimeStatus;
  readonly output: string;
  readonly error?: string | undefined;
}

export type PiSettingValueType = "boolean" | "number" | "string" | "enum" | "array" | "record";

export type PiSettingsTab =
  | "models"
  | "interaction"
  | "tools"
  | "compaction"
  | "resources"
  | "network";

export interface PiSettingSchemaEntry {
  readonly key: string;
  readonly tab: PiSettingsTab;
  readonly type: PiSettingValueType;
  readonly options: readonly string[] | null;
  readonly defaultValue: unknown;
  readonly hasDefault: boolean;
  readonly globalOnly?: boolean | undefined;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly descZh: string;
  readonly descEn: string;
}

export interface PiSettingItem {
  readonly key: string;
  readonly tab: PiSettingsTab;
  readonly type: PiSettingValueType;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly description: string;
  readonly options: readonly string[] | null;
  readonly value: unknown;
  readonly hasValue: boolean;
  readonly redacted: boolean;
  readonly defaultValue: unknown;
  readonly hasDefault: boolean;
  readonly globalOnly?: boolean | undefined;
}

export interface PiSettingsSnapshot {
  readonly piVersion: string | null;
  readonly agentDir: string;
  readonly tabs: readonly PiSettingsTab[];
  readonly items: readonly PiSettingItem[];
  readonly projectOverrides: readonly string[];
  readonly modelDefaults: {
    readonly provider: string | null;
    readonly modelId: string | null;
    readonly thinkingLevel: PiThinkingLevel | null;
  };
}

export interface PiSettingWriteResult {
  readonly key: string;
  readonly value: unknown;
  readonly hasValue: boolean;
  readonly redacted: boolean;
  readonly overriddenBy?: "project" | undefined;
}

export interface PiBuiltinProviderMeta {
  readonly id: string;
  readonly name: string;
  readonly supportsOAuth: boolean;
  readonly acceptsApiKey: boolean;
  readonly envVars: readonly string[];
}

export interface PiProviderAuthStatus {
  readonly id: string;
  readonly name: string;
  readonly supportsOAuth: boolean;
  readonly acceptsApiKey: boolean;
  readonly envVars: readonly string[];
  readonly activeEnvVar: string | null;
  readonly authType: "oauth" | "api_key" | null;
  readonly configured: boolean;
  readonly maskedHint: string | null;
  readonly accountHint: string | null;
  readonly modelCount: number;
}

export interface PiEnvVarStatus {
  readonly name: string;
  readonly source: "system" | "env-file" | "missing";
  readonly configured: boolean;
}

export type PiCustomKeyState =
  | { readonly kind: "none" }
  | { readonly kind: "literal"; readonly configured: true }
  | { readonly kind: "command"; readonly configured: true }
  | {
      readonly kind: "env";
      readonly name: string;
      readonly source: "system" | "env-file" | "missing";
    };

export type PiCustomThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

export interface PiCustomModelEntry {
  readonly id: string;
  readonly name?: string | null | undefined;
  readonly reasoning?: boolean | null | undefined;
  readonly images?: boolean | null | undefined;
  readonly contextWindow?: number | null | undefined;
  readonly maxTokens?: number | null | undefined;
  readonly thinkingLevelMap?: PiCustomThinkingLevelMap | null | undefined;
}

export interface PiCustomProviderSummary {
  readonly id: string;
  readonly baseUrl: string | null;
  readonly api: string | null;
  readonly key: PiCustomKeyState;
  readonly models: readonly PiCustomModelEntry[];
}

export type PiCustomKeyWriteInput =
  | { readonly kind: "keep" }
  | { readonly kind: "none" }
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "env"; readonly name: string; readonly value?: string | undefined };

export interface PiCustomProviderSaveInput {
  readonly id: string;
  readonly baseUrl: string;
  readonly api: string;
  readonly key: PiCustomKeyWriteInput;
  readonly models: readonly PiCustomModelEntry[];
}

export interface PiConfigChangeEvent {
  readonly area: "settings" | "models" | "auth" | "resources" | "runtime" | "extensionUi";
  readonly sessionId?: string | undefined;
}
