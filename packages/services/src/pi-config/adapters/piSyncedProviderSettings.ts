/**
 * Pi `<agentDir>/models.json` <-> `IProviderSettingsService` 真正双向同步适配器：
 * - 读取路径：实时读取 `<agentDir>/models.json` 全部自定义 Provider，并合并进 `ProviderSettingsView`
 *   （`models.json` 中已有的 Provider 与模型优先完整展现，不再被旧版 ZCode 私有配置遮蔽）；
 * - 写入路径：对仅存在于 `models.json` 的原生 Pi Provider 直接读写 `models.json`（含增删改模型、
 *   多档思考强度映射、`/models` 批量拉取、重排与删除），对同时存在于 `base` 的 Provider 双向落盘；
 * - 安全边界：绝不向 UI 返回明文 API Key，留空保存一律按 `keep` 保留原密钥。
 */
import path from "node:path";
import { Emitter } from "@zcode/rpc";
import type {
  ModelConfigObject,
  ModelConfigResolution,
  ProviderConfigObject,
  ProviderSettingsProviderView,
  ProviderSettingsView,
} from "@zcode/provider";
import type {
  PiCustomModelEntry,
  PiCustomProviderSaveInput,
  PiCustomProviderSummary,
} from "@zcode/shared/pi-config";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  BatchAddPersonalModelInput,
  IProviderSettingsService,
} from "#src/model-provider/providerFacadeServices.js";
import { parseConfiguredEnvKeys, stripBom } from "../domain/piConfigHelpers.js";
import {
  convertZCodeModelConfigToPiModelEntry,
  convertZCodeProviderViewToPiSaveInput,
  mapPiApiToZCodeApiType,
  mapZCodeApiTypeToPiApi,
  normalizePiBaseUrl,
  parsePiCustomProviders,
  projectPiCustomModelToSettingsView,
  projectPiCustomProviderToSettingsView,
  reorderPiCustomProvidersInText,
  resolvePiCustomProviderRawApiKeyFromText,
  resolvePiKeyWriteInputFromUiValue,
  resolvePiProviderConnectivityTargetFromText,
  type EnvVarSource,
} from "../domain/piModelsJsonCodec.js";
import { atomicWritePiFile, enqueuePiFileWrite, readPiTextIfExists } from "./piAtomicFile.js";
import { removePiCustomProvider, savePiCustomProvider } from "./piAuthModelsStore.js";
import { probePiProviderModelConnectivity } from "./piProviderConnectivityProbe.js";

const logger = createServiceLogger("pi-synced-provider-settings");

function parseDotEnvValuesForHostOnly(text: string | null): Record<string, string> {
  if (!text) return {};
  const map: Record<string, string> = {};
  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (name && val) map[name] = val;
  }
  return map;
}

function mergeProviderWithPiCustom(
  baseProvider: ProviderSettingsProviderView,
  piProvider: ProviderSettingsProviderView,
): ProviderSettingsProviderView {
  // 一旦该 Provider 已存在于 ~/.pi/agent/models.json，models.json 即是唯一事实源（模型列表与连接配置均以它为准），
  // 仅保留 base 中无冲突的 UI 展示名称/Logo，防止删除 models.json 模型后被旧版 ZCode 残留复活。
  return {
    ...piProvider,
    providerName: baseProvider.providerName ?? piProvider.providerName,
    effectiveConfig: {
      ...piProvider.effectiveConfig,
      ...(baseProvider.effectiveConfig.logo ? { logo: baseProvider.effectiveConfig.logo } : {}),
    },
  };
}

function mergeViewsWithPiModelsJson(
  baseView: ProviderSettingsView,
  piCustomProviders: readonly PiCustomProviderSummary[],
  localRevisionBump: number,
): ProviderSettingsView {
  if (piCustomProviders.length === 0) {
    return localRevisionBump > 0
      ? { ...baseView, revision: baseView.revision + localRevisionBump }
      : baseView;
  }

  const piProjectedById = new Map<string, ProviderSettingsProviderView>();
  for (const custom of piCustomProviders) {
    piProjectedById.set(custom.id, projectPiCustomProviderToSettingsView(custom));
  }

  const baseById = new Map(baseView.providers.map((p) => [p.providerId, p]));
  const consumedIds = new Set<string>();
  const mergedProviders: ProviderSettingsProviderView[] = [];

  // 1) 优先按 ~/.pi/agent/models.json 的顺序呈现全部 Pi 原生自定义 Provider。
  for (const custom of piCustomProviders) {
    const piView = piProjectedById.get(custom.id)!;
    const baseMatch = baseById.get(custom.id);
    mergedProviders.push(
      baseMatch && baseMatch.effectiveConfig.group === "standard-personal"
        ? mergeProviderWithPiCustom(baseMatch, piView)
        : piView,
    );
    consumedIds.add(custom.id);
  }

  // 2) 保留 base 中尚未落盘到 models.json 的新建草稿或其余条目（非冲突项）。
  for (const baseProvider of baseView.providers) {
    if (consumedIds.has(baseProvider.providerId)) continue;
    mergedProviders.push(baseProvider);
    consumedIds.add(baseProvider.providerId);
  }

  const providerOrder: string[] = [];
  const orderSeen = new Set<string>();
  for (const custom of piCustomProviders) {
    if (!orderSeen.has(custom.id)) {
      providerOrder.push(custom.id);
      orderSeen.add(custom.id);
    }
  }
  for (const id of baseView.providerOrder) {
    if (!orderSeen.has(id)) {
      providerOrder.push(id);
      orderSeen.add(id);
    }
  }
  for (const provider of mergedProviders) {
    if (!orderSeen.has(provider.providerId)) {
      providerOrder.push(provider.providerId);
      orderSeen.add(provider.providerId);
    }
  }

  return {
    ...baseView,
    revision: baseView.revision + localRevisionBump,
    providerOrder,
    providers: mergedProviders,
  };
}

export function createPiSyncedProviderSettingsService(input: {
  base: IProviderSettingsService;
  agentDir: string;
  env?: NodeJS.ProcessEnv | undefined;
  fetchImpl?: typeof fetch | undefined;
  readProviderApiKey?:
    | ((providerId: string, credentialKey?: string) => Promise<string | null>)
    | undefined;
  onSynced?: (() => void) | undefined;
}): IProviderSettingsService {
  const processEnv = input.env ?? process.env;
  const modelsPath = path.join(input.agentDir, "models.json");
  const envPath = path.join(input.agentDir, ".env");
  const changeEmitter = new Emitter<ProviderSettingsView>();
  let localRevisionBump = 0;

  const readPiCustomProviders = async (): Promise<PiCustomProviderSummary[]> => {
    const [modelsText, envText] = await Promise.all([
      readPiTextIfExists(modelsPath),
      readPiTextIfExists(envPath),
    ]);
    const fileEnvKeys = parseConfiguredEnvKeys(envText);
    const sourceOf = (name: string): EnvVarSource => {
      const sysVal = processEnv[name];
      if (typeof sysVal === "string" && sysVal.trim() !== "") return "system";
      if (fileEnvKeys.has(name)) return "env-file";
      return "missing";
    };
    return parsePiCustomProviders(modelsText, sourceOf);
  };

  const buildMergedView = async (
    baseViewPromise?: Promise<ProviderSettingsView>,
  ): Promise<ProviderSettingsView> => {
    const [baseView, piCustom] = await Promise.all([
      baseViewPromise ?? input.base.getView(),
      readPiCustomProviders(),
    ]);
    return mergeViewsWithPiModelsJson(baseView, piCustom, localRevisionBump);
  };

  const emitMergedChange = async (
    baseView?: ProviderSettingsView,
  ): Promise<ProviderSettingsView> => {
    const merged = await buildMergedView(baseView ? Promise.resolve(baseView) : undefined);
    changeEmitter.fire(merged);
    return merged;
  };

  input.base.onDidChange((baseView) => {
    void emitMergedChange(baseView).catch(() => undefined);
  });

  const hasProviderInBase = async (providerId: string): Promise<boolean> => {
    const baseView = await input.base.getView();
    return baseView.providers.some((p) => p.providerId === providerId);
  };

  const findPiCustomProvider = async (
    providerId: string,
  ): Promise<PiCustomProviderSummary | null> => {
    const list = await readPiCustomProviders();
    return list.find((item) => item.id === providerId) ?? null;
  };

  const isInPiModelsJson = async (providerId: string): Promise<boolean> => {
    return (await findPiCustomProvider(providerId)) !== null;
  };

  const mutatePiProvider = async (
    providerId: string,
    mutator: (current: PiCustomProviderSummary) => PiCustomProviderSaveInput,
  ): Promise<ProviderSettingsView> => {
    const current = await findPiCustomProvider(providerId);
    if (!current) {
      throw new Error(`Pi custom provider "${providerId}" not found in models.json`);
    }
    const nextInput = mutator(current);
    await savePiCustomProvider(input.agentDir, nextInput);
    localRevisionBump += 1;
    input.onSynced?.();
    return emitMergedChange();
  };

  const syncProviderFromView = async (
    view: ProviderSettingsView,
    providerId: string,
  ): Promise<void> => {
    const provider = view.providers.find((p) => p.providerId === providerId);
    if (!provider || provider.effectiveConfig.group !== "standard-personal") return;
    let keyWrite: PiCustomProviderSaveInput["key"] = { kind: "keep" };
    const access = provider.effectiveConfig.access;
    if (
      access &&
      (access.type === "api-key" || access.type === "zhipu-coding-plan-api-key") &&
      typeof access.apiKey === "string" &&
      access.apiKey.trim() !== ""
    ) {
      keyWrite = resolvePiKeyWriteInputFromUiValue(access.apiKey);
    } else if (input.readProviderApiKey) {
      const legacyAccess = access as { credentialKey?: unknown } | undefined;
      const credentialKey =
        typeof legacyAccess?.credentialKey === "string" && legacyAccess.credentialKey.trim()
          ? legacyAccess.credentialKey.trim()
          : undefined;
      const secret = await input.readProviderApiKey(providerId, credentialKey).catch(() => null);
      if (secret && secret.trim()) {
        keyWrite = resolvePiKeyWriteInputFromUiValue(secret);
      }
    }
    const payload = convertZCodeProviderViewToPiSaveInput(provider, keyWrite);
    if (!payload) return;
    try {
      await savePiCustomProvider(input.agentDir, payload);
      input.onSynced?.();
    } catch (error) {
      logger.warn(undefined, `Failed to sync provider=${providerId} to Pi models.json`, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    onDidChange: changeEmitter.event,
    getView: () => buildMergedView(),
    refresh: (reason) => buildMergedView(input.base.refresh(reason)),

    async createPersonalProvider(arg) {
      const created = await input.base.createPersonalProvider(arg);
      await syncProviderFromView(created.view, created.providerId);
      const merged = await emitMergedChange(created.view);
      return { providerId: created.providerId, view: merged };
    },

    async resolveModelConfig(arg): Promise<ModelConfigResolution> {
      const piCustom = await findPiCustomProvider(arg.providerId);
      if (!piCustom && (await hasProviderInBase(arg.providerId))) {
        return input.base.resolveModelConfig(arg);
      }
      const apiType = mapPiApiToZCodeApiType(piCustom?.api);
      const existing = piCustom?.models.find((m) => m.id === arg.modelId);
      const baseCfg = projectPiCustomModelToSettingsView(
        existing ?? { id: arg.modelId },
        apiType,
      ).effectiveConfig;
      const personal = "personalConfig" in arg ? arg.personalConfig : undefined;
      const effectiveConfig: ModelConfigObject = personal
        ? {
            ...baseCfg,
            ...personal,
            properties: {
              ...baseCfg.properties,
              ...personal.properties,
              inputFormat: {
                ...baseCfg.properties?.inputFormat,
                ...personal.properties?.inputFormat,
              },
              outputFormat: {
                ...baseCfg.properties?.outputFormat,
                ...personal.properties?.outputFormat,
              },
            },
            optionSpecs: {
              ...baseCfg.optionSpecs,
              ...personal.optionSpecs,
              ...(baseCfg.optionSpecs?.reasoningLevel || personal.optionSpecs?.reasoningLevel
                ? {
                    reasoningLevel: {
                      ...baseCfg.optionSpecs?.reasoningLevel,
                      ...personal.optionSpecs?.reasoningLevel,
                    },
                  }
                : {}),
              ...(baseCfg.optionSpecs?.maxOutputTokens || personal.optionSpecs?.maxOutputTokens
                ? {
                    maxOutputTokens: {
                      ...baseCfg.optionSpecs?.maxOutputTokens,
                      ...personal.optionSpecs?.maxOutputTokens,
                    },
                  }
                : {}),
            },
          }
        : baseCfg;
      return {
        inheritedConfig: baseCfg,
        effectiveConfig,
        issues: [],
      };
    },

    async fetchRemoteModels(arg) {
      let effectiveApiKey = arg.apiKey?.trim() ?? "";
      if (!effectiveApiKey && arg.providerId) {
        const [modelsText, envText] = await Promise.all([
          readPiTextIfExists(modelsPath),
          readPiTextIfExists(envPath),
        ]);
        const dotEnvValues = parseDotEnvValuesForHostOnly(envText);
        const resolved = resolvePiCustomProviderRawApiKeyFromText(
          modelsText,
          arg.providerId,
          (name) => processEnv[name] ?? dotEnvValues[name],
        );
        if (resolved) effectiveApiKey = resolved;
      }
      return input.base.fetchRemoteModels({
        ...arg,
        ...(effectiveApiKey ? { apiKey: effectiveApiKey } : {}),
      });
    },

    async reorderPersonalProviders(providerIds) {
      await enqueuePiFileWrite(modelsPath, async () => {
        const existing = await readPiTextIfExists(modelsPath);
        const reordered = reorderPiCustomProvidersInText(existing, providerIds);
        if (reordered.changed) {
          await atomicWritePiFile(modelsPath, reordered.text, {
            mode: 0o600,
            backup: true,
            tag: "pi-models",
          });
        }
      });
      const baseView = await input.base.getView();
      const basePersonalIds = new Set(
        baseView.providers
          .filter((p) => p.effectiveConfig.group === "standard-personal")
          .map((p) => p.providerId),
      );
      const filteredForBase = providerIds.filter((id) => basePersonalIds.has(id));
      const nextBaseView =
        filteredForBase.length > 0
          ? await input.base.reorderPersonalProviders(filteredForBase)
          : baseView;
      localRevisionBump += 1;
      input.onSynced?.();
      return emitMergedChange(nextBaseView);
    },

    async testModelConnectivity(arg) {
      const [modelsText, envText] = await Promise.all([
        readPiTextIfExists(modelsPath),
        readPiTextIfExists(envPath),
      ]);
      const dotEnvValues = parseDotEnvValuesForHostOnly(envText);
      const target = resolvePiProviderConnectivityTargetFromText(
        modelsText,
        arg.providerId,
        arg.modelId,
        (name) => processEnv[name] ?? dotEnvValues[name],
      );
      if (!target) {
        return input.base.testModelConnectivity(arg);
      }
      if (!target.baseUrl) {
        return {
          success: false,
          error: {
            message: `Provider "${arg.providerId}" is missing a valid Base URL in models.json.`,
          },
        };
      }
      if (target.keyProblem === "missing-env") {
        return {
          success: false,
          error: {
            message: `Environment variable $${target.missingEnvName ?? "API_KEY"} is not configured.`,
          },
        };
      }
      if (target.keyProblem === "command-unsupported") {
        return {
          success: false,
          error: {
            message:
              "Command-based API keys (!command) cannot be tested directly from Settings; verify in chat.",
          },
        };
      }
      return probePiProviderModelConnectivity(target, {
        fetchImpl: input.fetchImpl,
      });
    },

    async savePersonalProviderOverlay(providerId, config, metadata) {
      if (await isInPiModelsJson(providerId)) {
        const nextConfig = config as ProviderConfigObject;
        return mutatePiProvider(providerId, (current) => {
          const nextBaseUrl = nextConfig.api?.baseUrl?.trim() || current.baseUrl || "";
          if (!normalizePiBaseUrl(nextBaseUrl)) {
            throw new Error(`Invalid base URL for Pi provider "${providerId}": "${nextBaseUrl}"`);
          }
          const nextApi = nextConfig.api?.type
            ? mapZCodeApiTypeToPiApi(nextConfig.api.type)
            : (current.api ?? "openai-completions");
          const rawKey =
            nextConfig.access &&
            (nextConfig.access.type === "api-key" ||
              nextConfig.access.type === "zhipu-coding-plan-api-key")
              ? nextConfig.access.apiKey
              : undefined;
          return {
            id: current.id,
            baseUrl: nextBaseUrl,
            api: nextApi,
            key: resolvePiKeyWriteInputFromUiValue(rawKey),
            models: current.models,
          };
        });
      }
      const view = await input.base.savePersonalProviderOverlay(providerId, config, metadata);
      await syncProviderFromView(view, providerId);
      return emitMergedChange(view);
    },

    async deletePersonalProvider(providerId) {
      let baseView: ProviderSettingsView | undefined;
      if (await hasProviderInBase(providerId)) {
        baseView = await input.base.deletePersonalProvider(providerId);
      }
      await removePiCustomProvider(input.agentDir, providerId).catch(() => undefined);
      localRevisionBump += 1;
      input.onSynced?.();
      return emitMergedChange(baseView);
    },

    async reorderPersonalModels(providerId, modelIds) {
      if (await isInPiModelsJson(providerId)) {
        return mutatePiProvider(providerId, (current) => {
          const byId = new Map(current.models.map((m) => [m.id, m]));
          const ordered: PiCustomModelEntry[] = [];
          const seen = new Set<string>();
          for (const id of modelIds) {
            const hit = byId.get(id);
            if (hit && !seen.has(id)) {
              ordered.push(hit);
              seen.add(id);
            }
          }
          for (const m of current.models) {
            if (!seen.has(m.id)) ordered.push(m);
          }
          return {
            id: current.id,
            baseUrl: current.baseUrl ?? "",
            api: current.api ?? "openai-completions",
            key: { kind: "keep" },
            models: ordered,
          };
        });
      }
      const view = await input.base.reorderPersonalModels(providerId, modelIds);
      await syncProviderFromView(view, providerId);
      return emitMergedChange(view);
    },

    async addPersonalModel(providerId, modelId, config, useRecommendedConfig) {
      if (await isInPiModelsJson(providerId)) {
        return mutatePiProvider(providerId, (current) => {
          const trimmedId = modelId.trim();
          const existing = current.models.find((m) => m.id === trimmedId);
          const entry = convertZCodeModelConfigToPiModelEntry(trimmedId, config, existing);
          const nextModels = existing
            ? current.models.map((m) => (m.id === trimmedId ? entry : m))
            : [...current.models, entry];
          return {
            id: current.id,
            baseUrl: current.baseUrl ?? "",
            api: current.api ?? "openai-completions",
            key: { kind: "keep" },
            models: nextModels,
          };
        });
      }
      const view = await input.base.addPersonalModel(
        providerId,
        modelId,
        config,
        useRecommendedConfig,
      );
      await syncProviderFromView(view, providerId);
      return emitMergedChange(view);
    },

    async addPersonalModels(providerId, models: readonly BatchAddPersonalModelInput[]) {
      if (await isInPiModelsJson(providerId)) {
        return mutatePiProvider(providerId, (current) => {
          const byId = new Map(current.models.map((m) => [m.id, m]));
          const nextModels = [...current.models];
          for (const item of models) {
            const trimmedId = item.modelId.trim();
            if (!trimmedId) continue;
            const existing = byId.get(trimmedId);
            const entry = convertZCodeModelConfigToPiModelEntry(trimmedId, item.config, existing);
            if (existing) {
              const idx = nextModels.findIndex((m) => m.id === trimmedId);
              if (idx >= 0) nextModels[idx] = entry;
            } else {
              nextModels.push(entry);
            }
            byId.set(trimmedId, entry);
          }
          return {
            id: current.id,
            baseUrl: current.baseUrl ?? "",
            api: current.api ?? "openai-completions",
            key: { kind: "keep" },
            models: nextModels,
          };
        });
      }
      const view = await input.base.addPersonalModels(providerId, models);
      await syncProviderFromView(view, providerId);
      return emitMergedChange(view);
    },

    async renamePersonalModel(providerId, currentModelId, nextModelId) {
      if (await isInPiModelsJson(providerId)) {
        return mutatePiProvider(providerId, (current) => {
          const trimmedNext = nextModelId.trim();
          const nextModels = current.models.map((m) =>
            m.id === currentModelId ? { ...m, id: trimmedNext, name: trimmedNext } : m,
          );
          return {
            id: current.id,
            baseUrl: current.baseUrl ?? "",
            api: current.api ?? "openai-completions",
            key: { kind: "keep" },
            models: nextModels,
          };
        });
      }
      const view = await input.base.renamePersonalModel(providerId, currentModelId, nextModelId);
      await syncProviderFromView(view, providerId);
      return emitMergedChange(view);
    },

    async deletePersonalModel(providerId, modelId) {
      if (await isInPiModelsJson(providerId)) {
        return mutatePiProvider(providerId, (current) => ({
          id: current.id,
          baseUrl: current.baseUrl ?? "",
          api: current.api ?? "openai-completions",
          key: { kind: "keep" },
          models: current.models.filter((m) => m.id !== modelId),
        }));
      }
      const view = await input.base.deletePersonalModel(providerId, modelId);
      await syncProviderFromView(view, providerId);
      return emitMergedChange(view);
    },

    async savePersonalModelDraft(draft) {
      if (await isInPiModelsJson(draft.providerId)) {
        return mutatePiProvider(draft.providerId, (current) => {
          const nextId = draft.nextModelId.trim();
          const existing = current.models.find((m) => m.id === draft.originalModelId);
          const updated = convertZCodeModelConfigToPiModelEntry(
            nextId,
            draft.personalConfig,
            existing,
          );
          const found = current.models.some((m) => m.id === draft.originalModelId);
          const nextModels = found
            ? current.models.map((m) => (m.id === draft.originalModelId ? updated : m))
            : [...current.models, updated];
          return {
            id: current.id,
            baseUrl: current.baseUrl ?? "",
            api: current.api ?? "openai-completions",
            key: { kind: "keep" },
            models: nextModels,
          };
        });
      }
      const view = await input.base.savePersonalModelDraft(draft);
      await syncProviderFromView(view, draft.providerId);
      return emitMergedChange(view);
    },

    async setPersonalModelEnabled(providerId, modelId, enabled) {
      if (await isInPiModelsJson(providerId)) {
        // Pi models.json 无单模型 disabled 字段；保持视图同步（删除请走删除模型）。
        return emitMergedChange();
      }
      const view = await input.base.setPersonalModelEnabled(providerId, modelId, enabled);
      await syncProviderFromView(view, providerId);
      return emitMergedChange(view);
    },
  };
}
