/**
 * `IPiConfigService` 完整 Host 实现工厂（adapters 层）：
 * 聚合运行时检测/受管安装、settings.json、只写凭据/models.json、资源包/MCP/Skills/Prompts/文档/快捷键、
 * 本地 `.jsonl` 用量统计与会话生态（24+ 斜杠命令、`/btw`、`/export`、分支树/`fork`/`rewindTo`）。
 */
import { Emitter } from "@zcode/rpc";
import {
  mergePiSlashCommands,
  type PiConfigChangeEvent,
  type PiSlashCommandDef,
} from "@zcode/shared/pi-config";
import type { PiAgentService } from "#src/pi-runtime/contract.js";
import { discoverPi, resolvePiAgentDir, type PiModelCatalog } from "#src/pi-runtime/index.js";
import type { IPiConfigService } from "../contract.js";
import {
  readPiAuthAndProvidersSnapshot,
  removePiCustomProvider,
  removePiEnvVariable,
  removePiProviderCredential,
  savePiCustomProvider,
  savePiEnvVariable,
  savePiProviderApiKey,
} from "./piAuthModelsStore.js";
import {
  deletePiMcpServer,
  deletePiPromptTemplate,
  deletePiSkillFolder,
  importPiSkillFolder,
  readPiResourcesSnapshot,
  runPiPackageAction,
  savePiMcpServer,
  savePiPromptTemplate,
  setPiBuiltinExtensionEnabled,
  setPiCustomExtensions,
  setPiMcpServerEnabled,
  setPiSkillEnabled,
} from "./piResourcesStore.js";
import {
  executePiSessionEcosystemAction,
  inspectPiRuntimeStatus,
  installOrUpgradeManagedPiRuntime,
  resolveDefaultManagedRuntimeDir,
  scanPiLocalUsageSummary,
} from "./piRuntimeAndEcosystem.js";
import {
  readPiSettingsSnapshot,
  readPiSystemDoc,
  resetPiSettingValue,
  savePiKeybindingEntry,
  savePiSystemDoc,
  setPiSettingValue,
  writePiModelDefaults,
} from "./piSettingsStore.js";

const SLASH_CACHE_TTL_MS = 15_000;

export interface CreatePiConfigServiceOptions {
  readonly catalog?: PiModelCatalog | null | undefined;
  readonly agentService?: PiAgentService | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly managedRuntimeDir?: string | undefined;
}

export type ManagedPiConfigService = IPiConfigService & {
  dispose(): void;
};

export function createPiConfigService(
  options: CreatePiConfigServiceOptions = {},
): ManagedPiConfigService {
  const platform = options.platform ?? process.platform;
  const managedRuntimeDir =
    options.managedRuntimeDir ?? resolveDefaultManagedRuntimeDir(options.env, platform);
  const changeEmitter = new Emitter<PiConfigChangeEvent>();
  const slashCache = new Map<string, { expiresAt: number; commands: PiSlashCommandDef[] }>();
  let disposed = false;

  const getAgentDir = (): string => resolvePiAgentDir(options.env);
  const emitChange = (area: PiConfigChangeEvent["area"]): void => {
    if (!disposed) changeEmitter.fire({ area });
  };
  const refreshCatalogQuietly = (): void => {
    if (!options.catalog || disposed) return;
    void options.catalog.refresh().catch(() => undefined);
  };

  const buildLoginCommand = async () => {
    const launch = await discoverPi({
      env: options.env,
      platform,
      managedRuntimeDir,
    });
    if (!launch) {
      return { command: "pi", args: ["/login"], displayCommand: "pi /login" };
    }
    return {
      command: launch.command,
      args: [...launch.prefixArgs, "/login"],
      displayCommand: "pi /login",
    };
  };

  return {
    onDidChange: changeEmitter.event,

    async getRuntimeStatus(params) {
      return inspectPiRuntimeStatus({
        env: options.env,
        platform,
        managedRuntimeDir,
        checkHealth: params?.checkHealth,
      });
    },

    async installOrUpgradeManagedRuntime() {
      const result = await installOrUpgradeManagedPiRuntime({
        managedRuntimeDir,
        env: options.env,
        platform,
      });
      if (result.ok) {
        refreshCatalogQuietly();
        emitChange("runtime");
      }
      return result;
    },

    async getSettingsSnapshot(params) {
      const status = await inspectPiRuntimeStatus({
        env: options.env,
        platform,
        managedRuntimeDir,
      });
      return readPiSettingsSnapshot(getAgentDir(), status.version, params?.workspacePath);
    },

    async mutateSettings(op) {
      const agentDir = getAgentDir();
      switch (op.op) {
        case "set": {
          const write = await setPiSettingValue({
            agentDir,
            key: op.key,
            valueJson: op.valueJson,
            scope: op.scope,
            workspacePath: op.workspacePath,
          });
          emitChange("settings");
          if (
            op.key === "defaultProvider" ||
            op.key === "defaultModel" ||
            op.key === "defaultThinkingLevel"
          ) {
            refreshCatalogQuietly();
          }
          return { op: "set", write };
        }
        case "reset": {
          const write = await resetPiSettingValue({
            agentDir,
            key: op.key,
            scope: op.scope,
            workspacePath: op.workspacePath,
          });
          emitChange("settings");
          return { op: "reset", write };
        }
        case "setModelDefaults": {
          await writePiModelDefaults({
            agentDir,
            model: op.model,
            thinkingLevel: op.thinkingLevel,
            scope: op.scope,
            workspacePath: op.workspacePath,
          });
          refreshCatalogQuietly();
          emitChange("settings");
          return { op: "setModelDefaults", ok: true };
        }
        case "saveKeybinding": {
          const keybindings = await savePiKeybindingEntry(agentDir, op.action, op.chords, platform);
          emitChange("resources");
          return { op: "saveKeybinding", keybindings };
        }
      }
    },

    async listAuthAndProviders() {
      const loginCommand = await buildLoginCommand();
      return readPiAuthAndProvidersSnapshot({
        agentDir: getAgentDir(),
        env: options.env,
        availableModels: options.catalog?.getSnapshot().models,
        loginCommand,
      });
    },

    async mutateAuthOrProvider(op) {
      const agentDir = getAgentDir();
      switch (op.op) {
        case "saveApiKey":
          await savePiProviderApiKey(agentDir, op.providerId, op.apiKey);
          emitChange("auth");
          break;
        case "removeCredential":
          await removePiProviderCredential(agentDir, op.providerId);
          emitChange("auth");
          break;
        case "saveEnv":
          await savePiEnvVariable(agentDir, op.name, op.value);
          emitChange("auth");
          break;
        case "removeEnv":
          await removePiEnvVariable(agentDir, op.name);
          emitChange("auth");
          break;
        case "saveCustomProvider":
          await savePiCustomProvider(agentDir, op.input);
          emitChange("models");
          break;
        case "removeCustomProvider":
          await removePiCustomProvider(agentDir, op.providerId);
          emitChange("models");
          break;
      }
      refreshCatalogQuietly();
      const loginCommand = await buildLoginCommand();
      return readPiAuthAndProvidersSnapshot({
        agentDir,
        env: options.env,
        availableModels: options.catalog?.getSnapshot().models,
        loginCommand,
      });
    },

    async getResourcesSnapshot(params) {
      return readPiResourcesSnapshot(getAgentDir(), params?.workspacePath, platform);
    },

    async mutateResource(op) {
      const agentDir = getAgentDir();
      switch (op.op) {
        case "setBuiltinExtension":
          await setPiBuiltinExtensionEnabled({
            agentDir,
            id: op.id,
            enabled: op.enabled,
            scope: op.scope,
            workspacePath: op.workspacePath,
          });
          slashCache.clear();
          emitChange("resources");
          return {
            op: "snapshot",
            resources: await readPiResourcesSnapshot(agentDir, op.workspacePath, platform),
          };
        case "setCustomExtensions":
          await setPiCustomExtensions({
            agentDir,
            paths: op.paths,
            scope: op.scope,
            workspacePath: op.workspacePath,
          });
          slashCache.clear();
          emitChange("resources");
          return {
            op: "snapshot",
            resources: await readPiResourcesSnapshot(agentDir, op.workspacePath, platform),
          };
        case "runPackageAction": {
          const launch = await discoverPi({ env: options.env, platform, managedRuntimeDir });
          if (!launch) throw new Error("Pi CLI not found; install Pi runtime first");
          const result = await runPiPackageAction({
            launch,
            agentDir,
            action: op.action,
            source: op.source,
            scope: op.scope ?? "global",
            workspacePath: op.workspacePath,
            env: options.env,
          });
          slashCache.clear();
          refreshCatalogQuietly();
          emitChange("resources");
          return { op: "package", result };
        }
        case "setSkillEnabled": {
          const skills = await setPiSkillEnabled({
            agentDir,
            skillNameOrPath: op.skillNameOrPath,
            enabled: op.enabled,
            scope: op.scope,
            workspacePath: op.workspacePath,
          });
          slashCache.clear();
          emitChange("resources");
          return { op: "skills", skills };
        }
        case "importSkillFolder": {
          const skills = await importPiSkillFolder({
            agentDir,
            sourceDir: op.sourceDir,
            scope: op.scope,
            workspacePath: op.workspacePath,
          });
          slashCache.clear();
          emitChange("resources");
          return { op: "skills", skills };
        }
        case "deleteSkillFolder": {
          const skills = await deletePiSkillFolder({
            agentDir,
            folderPath: op.folderPath,
            workspacePath: op.workspacePath,
          });
          slashCache.clear();
          emitChange("resources");
          return { op: "skills", skills };
        }
        case "savePromptTemplate": {
          const prompts = await savePiPromptTemplate({
            agentDir,
            name: op.name,
            content: op.content,
            scope: op.scope,
            workspacePath: op.workspacePath,
          });
          slashCache.clear();
          emitChange("resources");
          return { op: "prompts", prompts };
        }
        case "deletePromptTemplate": {
          const prompts = await deletePiPromptTemplate({
            agentDir,
            fileName: op.fileName,
            scope: op.scope,
            workspacePath: op.workspacePath,
          });
          slashCache.clear();
          emitChange("resources");
          return { op: "prompts", prompts };
        }
        case "saveMcpServer": {
          const server = await savePiMcpServer(agentDir, op.input);
          emitChange("resources");
          return { op: "mcpServer", server };
        }
        case "deleteMcpServer": {
          const deleted = await deletePiMcpServer(agentDir, op.scope, op.name, op.workspacePath);
          emitChange("resources");
          return { op: "deleted", deleted };
        }
        case "setMcpServerEnabled": {
          const server = await setPiMcpServerEnabled(
            agentDir,
            op.scope,
            op.name,
            op.enabled,
            op.workspacePath,
          );
          emitChange("resources");
          return { op: "mcpServer", server };
        }
        case "getSystemDoc": {
          const doc = await readPiSystemDoc(agentDir, op.scope, op.kind, op.workspacePath);
          return { op: "systemDoc", doc };
        }
        case "saveSystemDoc": {
          const doc = await savePiSystemDoc(
            agentDir,
            op.scope,
            op.kind,
            op.content,
            op.workspacePath,
          );
          emitChange("resources");
          return { op: "systemDoc", doc };
        }
      }
    },

    async getLocalUsageSummary(params) {
      return scanPiLocalUsageSummary(getAgentDir(), params?.days ?? 90);
    },

    async listSlashCommands(params) {
      const cacheKey = params?.workspacePath?.trim() || "__global__";
      const now = Date.now();
      const cached = slashCache.get(cacheKey);
      if (!params?.refresh && cached && cached.expiresAt > now) {
        return cached.commands;
      }
      const dynamicRaw = await options.agentService
        ?.listDynamicCommands?.(params?.workspacePath)
        .catch(() => []);
      const mapped = (dynamicRaw ?? []).map((cmd) => {
        const source: "skill" | "prompt" | "extension" =
          cmd.source === "skill" ? "skill" : cmd.source === "prompt" ? "prompt" : "extension";
        return {
          name: cmd.name,
          description: cmd.description,
          source,
        };
      });
      const merged = mergePiSlashCommands(mapped);
      slashCache.set(cacheKey, { expiresAt: now + SLASH_CACHE_TTL_MS, commands: merged });
      return merged;
    },

    async runSessionAction(op) {
      return executePiSessionEcosystemAction(op, {
        agentDir: getAgentDir(),
        managedRuntimeDir,
        env: options.env,
        platform,
        agentService: options.agentService,
      });
    },

    dispose() {
      disposed = true;
      slashCache.clear();
      changeEmitter.dispose();
    },
  };
}
