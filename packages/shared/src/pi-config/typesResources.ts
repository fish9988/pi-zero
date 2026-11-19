/**
 * Pi MCP、扩展包、Skills、Prompts、系统文档、快捷键与本地用量统计契约类型（浏览器安全）。
 */
import type {
  PiBuiltinExtensionId,
  PiConfigScope,
  PiMcpExposure,
  PiSystemDocKind,
} from "./typesCore.js";

export interface PiMcpServerItem {
  readonly name: string;
  readonly scope: PiConfigScope;
  readonly transport: "stdio" | "http";
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly envKeys: readonly string[];
  readonly cwd?: string | undefined;
  readonly url?: string | undefined;
  readonly headerKeys: readonly string[];
  readonly enabled: boolean;
  readonly exposure: PiMcpExposure;
  readonly timeout?: number | undefined;
  readonly description?: string | undefined;
}

export interface PiMcpServerSaveInput {
  readonly scope: PiConfigScope;
  readonly workspacePath?: string | undefined;
  readonly previousName?: string | undefined;
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly clearEnv?: boolean | undefined;
  readonly cwd?: string | undefined;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly clearHeaders?: boolean | undefined;
  readonly enabled: boolean;
  readonly exposure: PiMcpExposure;
  readonly timeout?: number | undefined;
  readonly description?: string | undefined;
}

export interface PiPackageItem {
  readonly source: string;
  readonly scope: PiConfigScope;
  readonly kind: "npm" | "git" | "local";
}

export type PiPackageAction = "install" | "remove" | "update";

export interface PiPackageActionResult {
  readonly ok: boolean;
  readonly output: string;
  readonly packages: readonly PiPackageItem[];
}

export interface PiBuiltinExtensionState {
  readonly id: PiBuiltinExtensionId;
  readonly enabled: boolean;
}

export interface PiSkillEntry {
  readonly name: string;
  readonly description: string;
  readonly scope: PiConfigScope;
  readonly provider: "pi" | "agents";
  readonly enabled: boolean;
  readonly filePath: string;
  readonly folderPath: string;
  readonly removable: boolean;
}

export interface PiPromptTemplate {
  readonly name: string;
  readonly scope: PiConfigScope;
  readonly description: string;
  readonly fileName: string;
  readonly content?: string | undefined;
}

export interface PiSystemDoc {
  readonly kind: PiSystemDocKind;
  readonly scope: PiConfigScope;
  readonly exists: boolean;
  readonly content: string;
  readonly filePath: string;
}

export interface PiKeybindingEntry {
  readonly action: string;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly chords: readonly string[];
  readonly defaultChords: readonly string[];
  readonly customized: boolean;
}

export interface PiResourcesSnapshot {
  readonly packages: readonly PiPackageItem[];
  readonly builtinExtensions: readonly PiBuiltinExtensionState[];
  readonly customExtensions: readonly string[];
  readonly mcpServers: readonly PiMcpServerItem[];
  readonly skills: readonly PiSkillEntry[];
  readonly prompts: readonly PiPromptTemplate[];
  readonly keybindings: readonly PiKeybindingEntry[];
  readonly enableSkillCommands: boolean;
}

export interface PiLocalModelUsage {
  readonly provider: string;
  readonly modelId: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export interface PiLocalDailyUsage {
  readonly date: string;
  readonly sessions: number;
  readonly requests: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export interface PiLocalUsageSummary {
  readonly totalSessions: number;
  readonly totalRequests: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheWriteTokens: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly byModel: readonly PiLocalModelUsage[];
  readonly byDay: readonly PiLocalDailyUsage[];
  readonly scannedAt: number;
}
