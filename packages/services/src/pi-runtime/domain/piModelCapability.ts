/**
 * Pi 模型思考档位能力计算与 ZCode ModelSelectionView / WorkspaceConfig 投影（纯 domain 层）。
 * 规则与 Pi（@earendil-works/pi-ai）的 getSupportedThinkingLevels 对齐，严禁引入 IO 或计时器。
 */
import type {
  ModelSelectionModelView,
  ModelSelectionProviderView,
  ModelSelectionView,
  ModelSelectionViewInput,
  ProviderApiType,
  ProviderConfigObject,
  RegistryModelConfigObject,
} from "@zcode/provider";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type {
  WorkspaceConfigOption,
  WorkspaceConfigSelectValue,
  WorkspaceConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import type { PiModelInfo, PiThinkingLevel } from "#src/pi-runtime/domain/piRpcTypes.js";

export type PiThinkingLevelMap = Readonly<Record<string, string | null | undefined>>;

export interface PiThinkingCapability {
  reasoning?: boolean | undefined;
  thinkingLevelMap?: PiThinkingLevelMap | undefined;
}

export interface PiModelCatalogSnapshot {
  readonly revision: number;
  readonly models: readonly PiModelInfo[];
  readonly defaultModel?: PiModelInfo | undefined;
  readonly defaultThinkingLevel?: string | undefined;
  readonly available: boolean;
}

/** Pi 的全部思考档位，按从弱到强顺序排列（off 在最前）。 */
export const PI_THINKING_LEVEL_ORDER: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "google-vertex": "Google Vertex",
  "amazon-bedrock": "Amazon Bedrock",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  xai: "xAI",
  groq: "Groq",
  mistral: "Mistral",
  ollama: "Ollama",
};

export function formatPiProviderDisplayName(providerId: string): string {
  const known = PROVIDER_DISPLAY_NAMES[providerId.toLowerCase()];
  if (known) return known;
  const trimmed = providerId.trim();
  if (!trimmed) return "Pi";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * 计算单个 Pi 模型支持的思考档位（严格与 Pi 上游一致）：
 * - reasoning !== true：仅 ["off"]；
 * - off..high 默认支持，除非 thinkingLevelMap[level] === null；
 * - xhigh / max 仅在 thinkingLevelMap 显式给出非 null 映射时才算支持。
 */
export function getSupportedThinkingLevels(
  model: PiThinkingCapability | null | undefined,
): PiThinkingLevel[] {
  if (model?.reasoning !== true) return ["off"];
  const map = model.thinkingLevelMap;
  const levels = PI_THINKING_LEVEL_ORDER.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
  return levels.length > 0 ? levels : ["off"];
}

export function clampPiThinkingLevel(
  requested: string | undefined,
  supported: readonly string[],
): string {
  if (supported.length === 0) return "off";
  const trimmed = requested?.trim();
  if (trimmed && supported.includes(trimmed)) return trimmed;
  if (trimmed) {
    const lower = trimmed.toLowerCase();
    const ci = supported.find((level) => level.toLowerCase() === lower);
    if (ci) return ci;
    const requestedIdx = PI_THINKING_LEVEL_ORDER.indexOf(lower as PiThinkingLevel);
    if (requestedIdx >= 0) {
      for (let idx = requestedIdx + 1; idx < PI_THINKING_LEVEL_ORDER.length; idx += 1) {
        const candidate = PI_THINKING_LEVEL_ORDER[idx];
        if (candidate && supported.includes(candidate)) return candidate;
      }
      for (let idx = requestedIdx - 1; idx >= 0; idx -= 1) {
        const candidate = PI_THINKING_LEVEL_ORDER[idx];
        if (candidate && supported.includes(candidate)) return candidate;
      }
    }
  }
  if (supported.includes("medium")) return "medium";
  if (supported.includes("high")) return "high";
  return supported[0] ?? "off";
}

export function pickDefaultThinkingLevel(
  model: PiThinkingCapability | null | undefined,
  preferred?: string,
): string {
  return clampPiThinkingLevel(preferred, getSupportedThinkingLevels(model));
}

export function piModelToRegistryModelConfig(model: PiModelInfo): RegistryModelConfigObject {
  const levels = getSupportedThinkingLevels(model);
  const contextWindow =
    typeof model.contextWindow === "number" &&
    Number.isFinite(model.contextWindow) &&
    model.contextWindow > 0
      ? Math.floor(model.contextWindow)
      : 128_000;
  const maxOutputTokens =
    typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0
      ? Math.floor(model.maxTokens)
      : 16_384;
  const supportsImage = Array.isArray(model.input) ? model.input.includes("image") : false;
  return {
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    },
    optionSpecs: {
      reasoningLevel: {
        values: levels,
        map: "{}",
      },
      maxOutputTokens: {
        max: maxOutputTokens,
        map: "{}",
      },
    },
  };
}

/**
 * 将 Pi 模型的上游 api 协议名归一化为 ZCode Registry 识别的 ProviderApiType。
 * UI 的 `buildRegistryModelSelectGroups` 依赖 `provider.config.api?.type` 非空才纳入模型选择器。
 */
export function resolvePiProviderApiType(
  providerId: string,
  models: readonly PiModelInfo[],
): ProviderApiType {
  for (const model of models) {
    const raw = model.api?.trim().toLowerCase();
    if (!raw) continue;
    if (raw === "anthropic-messages" || raw.includes("anthropic")) {
      return "anthropic-messages";
    }
    if (raw === "openai-responses") {
      return "openai-responses";
    }
    if (raw === "openai-completions" || raw === "openai-chat-completions") {
      return "openai-chat-completions";
    }
  }
  return providerId.trim().toLowerCase() === "anthropic"
    ? "anthropic-messages"
    : "openai-chat-completions";
}

/**
 * 将 Pi 模型目录映射为 ZCode ModelSelectionProviderView 列表。
 * 凭据只进不出：access 只声明 `{ type: "api-key" }`，绝不携带任何明文 apiKey。
 */
export function piModelsToModelSelectionProviders(
  models: readonly PiModelInfo[],
): readonly ModelSelectionProviderView[] {
  const grouped = new Map<string, PiModelInfo[]>();
  for (const model of models) {
    const providerId = model.provider.trim();
    const modelId = model.id.trim();
    if (!providerId || !modelId) continue;
    const bucket = grouped.get(providerId) ?? [];
    if (!bucket.some((existing) => existing.id === modelId)) {
      bucket.push(model);
    }
    grouped.set(providerId, bucket);
  }

  const providers: ModelSelectionProviderView[] = [];
  for (const [providerId, group] of grouped) {
    const config: ProviderConfigObject = {
      group: "standard-personal",
      visibility: "visible",
      access: { type: "api-key" },
      api: { type: resolvePiProviderApiType(providerId, group) },
    };
    const modelViews: ModelSelectionModelView[] = group.map((model) =>
      Object.freeze({
        modelId: model.id,
        config: piModelToRegistryModelConfig(model),
      }),
    );
    providers.push(
      Object.freeze({
        providerId,
        providerName: formatPiProviderDisplayName(providerId),
        config,
        models: Object.freeze(modelViews),
      }),
    );
  }
  return Object.freeze(providers);
}

function findSelectionInProviders(
  providers: readonly ModelSelectionProviderView[],
  selection: ModelSelection,
): { provider?: ModelSelectionProviderView; model?: ModelSelectionModelView } {
  const provider = providers.find((item) => item.providerId === selection.providerId);
  if (!provider) return {};
  const model = provider.models.find((item) => item.modelId === selection.modelId);
  return { provider, model };
}

function resolveMergedEffectiveSelection(
  providers: readonly ModelSelectionProviderView[],
  selection: ModelSelection | null,
): Pick<ModelSelectionView, "effectiveSelection" | "selectionIssue"> {
  if (!selection) {
    return { effectiveSelection: null, selectionIssue: "selection-missing" };
  }
  const { provider, model } = findSelectionInProviders(providers, selection);
  if (!provider) {
    return { effectiveSelection: null, selectionIssue: "provider-not-found" };
  }
  if (!model) {
    return { effectiveSelection: null, selectionIssue: "model-not-found" };
  }
  const allowedLevels = model.config.optionSpecs.reasoningLevel.values;
  const requestedLevel = selection.options?.reasoningLevel;
  if (!requestedLevel) {
    return {
      effectiveSelection: Object.freeze({
        providerId: selection.providerId,
        modelId: selection.modelId,
      }),
      selectionIssue: "reasoning-level-missing",
    };
  }
  if (!allowedLevels.includes(requestedLevel)) {
    return {
      effectiveSelection: Object.freeze({
        providerId: selection.providerId,
        modelId: selection.modelId,
      }),
      selectionIssue: "reasoning-level-not-supported",
    };
  }
  return {
    effectiveSelection: Object.freeze({
      providerId: selection.providerId,
      modelId: selection.modelId,
      options: Object.freeze({ reasoningLevel: requestedLevel }),
    }),
  };
}

/**
 * 把 Pi 模型目录增量合入 ZCode 原有 ModelSelectionView：
 * 100% 保留用户已配置的个人/第三方 Provider 与模型配置，仅补齐缺失的 Pi 模型与默认首选。
 */
export function mergePiModelsIntoSelectionView(
  baseView: ModelSelectionView,
  catalog: PiModelCatalogSnapshot,
  input?: ModelSelectionViewInput,
): ModelSelectionView {
  const piProviders = piModelsToModelSelectionProviders(catalog.models);
  if (piProviders.length === 0) return baseView;

  const mergedProviders: ModelSelectionProviderView[] = baseView.providers.map((existing) => {
    const piMatch = piProviders.find((candidate) => candidate.providerId === existing.providerId);
    if (!piMatch) return existing;
    const existingIds = new Set(existing.models.map((item) => item.modelId));
    const missingModels = piMatch.models.filter((item) => !existingIds.has(item.modelId));
    if (missingModels.length === 0) return existing;
    return Object.freeze({
      ...existing,
      models: Object.freeze([...existing.models, ...missingModels]),
    });
  });

  const existingProviderIds = new Set(baseView.providers.map((item) => item.providerId));
  for (const piProvider of piProviders) {
    if (!existingProviderIds.has(piProvider.providerId)) {
      mergedProviders.push(piProvider);
    }
  }
  const frozenProviders = Object.freeze(mergedProviders);

  let preferredSelection = baseView.preferredSelection;
  if (preferredSelection) {
    const found = findSelectionInProviders(frozenProviders, preferredSelection);
    if (!found.model) preferredSelection = undefined;
  }
  if (!preferredSelection && catalog.defaultModel) {
    const candidate: ModelSelection = {
      providerId: catalog.defaultModel.provider,
      modelId: catalog.defaultModel.id,
      options: {
        reasoningLevel: pickDefaultThinkingLevel(
          catalog.defaultModel,
          catalog.defaultThinkingLevel,
        ),
      },
    };
    if (findSelectionInProviders(frozenProviders, candidate).model) {
      preferredSelection = Object.freeze(candidate);
    }
  }
  if (!preferredSelection) {
    for (const provider of frozenProviders) {
      const firstModel = provider.models[0];
      if (!firstModel) continue;
      const defaultLevel = clampPiThinkingLevel(
        catalog.defaultThinkingLevel,
        firstModel.config.optionSpecs.reasoningLevel.values,
      );
      preferredSelection = Object.freeze({
        providerId: provider.providerId,
        modelId: firstModel.modelId,
        options: Object.freeze({ reasoningLevel: defaultLevel }),
      });
      break;
    }
  }

  const effectivePatch = input
    ? resolveMergedEffectiveSelection(frozenProviders, input.selection)
    : {
        ...(baseView.effectiveSelection !== undefined
          ? { effectiveSelection: baseView.effectiveSelection }
          : {}),
        ...(baseView.selectionIssue !== undefined
          ? { selectionIssue: baseView.selectionIssue }
          : {}),
      };

  return Object.freeze({
    revision: Math.max(0, baseView.revision) + catalog.revision,
    providers: frozenProviders,
    ...(preferredSelection ? { preferredSelection } : {}),
    ...effectivePatch,
  });
}

export function buildWorkspaceConfigStateFromPiModels(
  models: readonly PiModelInfo[],
  activeModel?: PiModelInfo,
  activeThinkingLevel?: string,
): WorkspaceConfigState {
  const effectiveModel = activeModel ?? models[0];
  const modelOptions: WorkspaceConfigSelectValue[] = models.map((model) => {
    const levels = getSupportedThinkingLevels(model);
    return {
      value: `${model.provider}/${model.id}`,
      name: model.name || model.id,
      origin: "native",
      modelProviderId: model.provider,
      modelProviderName: formatPiProviderDisplayName(model.provider),
      modelThoughtLevels: levels,
      modelDefaultThoughtLevel: pickDefaultThinkingLevel(model),
    };
  });

  const activeLevels = getSupportedThinkingLevels(effectiveModel);
  const currentThought = pickDefaultThinkingLevel(effectiveModel, activeThinkingLevel);
  const thoughtOptions: WorkspaceConfigSelectValue[] = activeLevels.map((level) => ({
    value: level,
    name: level,
    origin: "native",
  }));

  const configOptions: WorkspaceConfigOption[] = [];
  if (modelOptions.length > 0 && effectiveModel) {
    configOptions.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: `${effectiveModel.provider}/${effectiveModel.id}`,
      options: modelOptions,
    });
  }
  configOptions.push({
    id: "thought_level",
    name: "Thinking Level",
    category: "thought_level",
    type: "select",
    currentValue: currentThought,
    options: thoughtOptions,
  });

  return {
    configOptions,
    slashCommands: [],
  };
}
