/**
 * Pi 对话生态（24+ 斜杠命令、/btw、/export、分支树 / fork / rewindTo）及分组变更载荷契约（浏览器安全）。
 */
import type {
  PiBuiltinExtensionId,
  PiConfigScope,
  PiCustomProviderSaveInput,
  PiCustomProviderSummary,
  PiEnvVarStatus,
  PiProviderAuthStatus,
  PiSettingWriteResult,
  PiSystemDocKind,
  PiThinkingLevel,
} from "./typesCore.js";
import type {
  PiKeybindingEntry,
  PiMcpServerItem,
  PiMcpServerSaveInput,
  PiPackageAction,
  PiPackageActionResult,
  PiPromptTemplate,
  PiResourcesSnapshot,
  PiSkillEntry,
  PiSystemDoc,
} from "./typesResources.js";

export type PiSlashCommandSource = "builtin" | "extension" | "prompt" | "skill";

export type PiSlashCommandCategory = "session" | "model" | "tools" | "config" | "custom";

export interface PiSlashCommandDef {
  readonly name: string;
  readonly aliases?: readonly string[] | undefined;
  readonly descriptionZh: string;
  readonly descriptionEn: string;
  readonly category: PiSlashCommandCategory;
  readonly source: PiSlashCommandSource;
  readonly argsHint?: string | undefined;
  readonly supportsDraft?: boolean | undefined;
}

export interface PiBtwRequest {
  readonly workspacePath: string;
  readonly sessionId?: string | undefined;
  readonly question: string;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
}

export interface PiBtwResult {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly status: "completed" | "error" | "aborted";
  readonly error?: string | undefined;
  readonly durationMs: number;
  readonly createdAt: number;
}

export interface PiExportHtmlResult {
  readonly html: string;
  readonly suggestedFileName: string;
  readonly savedPath?: string | undefined;
  readonly messageCount: number;
}

export interface PiSessionTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly role?: string | undefined;
  readonly preview: string;
  readonly timestamp: number;
  readonly isActiveBranch: boolean;
  readonly isLeaf: boolean;
  readonly label?: string | undefined;
  readonly model?: string | undefined;
  readonly canRewind: boolean;
}

export interface PiSessionTreeSnapshot {
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly leafId: string | null;
  readonly nodes: readonly PiSessionTreeNode[];
}

export interface PiForkSessionResult {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly title: string;
}

export interface PiRewindSessionResult {
  readonly sessionId: string;
  readonly droppedLines: number;
  readonly leafId: string | null;
  readonly backupFile: string | null;
}

// ── IPiConfigService 分组变更与结果联合类型（保持接口 <= 12 公开方法）──

export type PiSettingsMutation =
  | {
      readonly op: "set";
      readonly key: string;
      readonly valueJson: string;
      readonly scope?: PiConfigScope | undefined;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "reset";
      readonly key: string;
      readonly scope?: PiConfigScope | undefined;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "setModelDefaults";
      readonly model: { readonly provider: string; readonly modelId: string } | null;
      readonly thinkingLevel?: PiThinkingLevel | null | undefined;
      readonly scope?: PiConfigScope | undefined;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "saveKeybinding";
      readonly action: string;
      readonly chords: readonly string[] | null;
    };

export type PiSettingsMutationResult =
  | { readonly op: "set" | "reset"; readonly write: PiSettingWriteResult }
  | { readonly op: "setModelDefaults"; readonly ok: true }
  | { readonly op: "saveKeybinding"; readonly keybindings: readonly PiKeybindingEntry[] };

export interface PiAuthAndProvidersSnapshot {
  readonly auth: readonly PiProviderAuthStatus[];
  readonly envVars: readonly PiEnvVarStatus[];
  readonly customProviders: readonly PiCustomProviderSummary[];
  readonly loginCommand: {
    readonly command: string;
    readonly args: readonly string[];
    readonly displayCommand: string;
  };
}

export type PiAuthOrProviderMutation =
  | { readonly op: "saveApiKey"; readonly providerId: string; readonly apiKey: string }
  | { readonly op: "removeCredential"; readonly providerId: string }
  | { readonly op: "saveEnv"; readonly name: string; readonly value: string }
  | { readonly op: "removeEnv"; readonly name: string }
  | { readonly op: "saveCustomProvider"; readonly input: PiCustomProviderSaveInput }
  | { readonly op: "removeCustomProvider"; readonly providerId: string };

export type PiResourceMutation =
  | {
      readonly op: "setBuiltinExtension";
      readonly id: PiBuiltinExtensionId;
      readonly enabled: boolean;
      readonly scope?: PiConfigScope | undefined;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "setCustomExtensions";
      readonly paths: readonly string[];
      readonly scope?: PiConfigScope | undefined;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "runPackageAction";
      readonly action: PiPackageAction;
      readonly source?: string | null | undefined;
      readonly scope?: PiConfigScope | undefined;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "setSkillEnabled";
      readonly skillNameOrPath: string;
      readonly enabled: boolean;
      readonly scope?: PiConfigScope | undefined;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "importSkillFolder";
      readonly sourceDir: string;
      readonly scope?: PiConfigScope | undefined;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "deleteSkillFolder";
      readonly folderPath: string;
      readonly scope?: PiConfigScope | undefined;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "savePromptTemplate";
      readonly name: string;
      readonly content: string;
      readonly scope?: PiConfigScope | undefined;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "deletePromptTemplate";
      readonly fileName: string;
      readonly scope?: PiConfigScope | undefined;
      readonly workspacePath?: string | undefined;
    }
  | { readonly op: "saveMcpServer"; readonly input: PiMcpServerSaveInput }
  | {
      readonly op: "deleteMcpServer";
      readonly scope: PiConfigScope;
      readonly name: string;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "setMcpServerEnabled";
      readonly scope: PiConfigScope;
      readonly name: string;
      readonly enabled: boolean;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "getSystemDoc";
      readonly scope: PiConfigScope;
      readonly kind: PiSystemDocKind;
      readonly workspacePath?: string | undefined;
    }
  | {
      readonly op: "saveSystemDoc";
      readonly scope: PiConfigScope;
      readonly kind: PiSystemDocKind;
      readonly content: string;
      readonly workspacePath?: string | undefined;
    };

export type PiResourceMutationResult =
  | { readonly op: "snapshot"; readonly resources: PiResourcesSnapshot }
  | { readonly op: "package"; readonly result: PiPackageActionResult }
  | { readonly op: "skills"; readonly skills: readonly PiSkillEntry[] }
  | { readonly op: "prompts"; readonly prompts: readonly PiPromptTemplate[] }
  | { readonly op: "mcpServer"; readonly server: PiMcpServerItem }
  | { readonly op: "deleted"; readonly deleted: boolean }
  | { readonly op: "systemDoc"; readonly doc: PiSystemDoc };

export type PiSessionEcosystemAction =
  | { readonly op: "btw"; readonly request: PiBtwRequest }
  | {
      readonly op: "exportHtml";
      readonly workspacePath: string;
      readonly sessionId: string;
      readonly saveToPath?: string | undefined;
    }
  | { readonly op: "getTree"; readonly workspacePath: string; readonly sessionId: string }
  | {
      readonly op: "fork";
      readonly workspacePath: string;
      readonly sessionId: string;
      readonly entryId?: string | null | undefined;
      readonly title?: string | undefined;
    }
  | {
      readonly op: "rewindTo";
      readonly workspacePath: string;
      readonly sessionId: string;
      readonly entryId: string;
    };

export type PiSessionEcosystemResult =
  | { readonly op: "btw"; readonly result: PiBtwResult }
  | { readonly op: "exportHtml"; readonly result: PiExportHtmlResult }
  | { readonly op: "getTree"; readonly tree: PiSessionTreeSnapshot }
  | { readonly op: "fork"; readonly result: PiForkSessionResult }
  | { readonly op: "rewindTo"; readonly result: PiRewindSessionResult };
