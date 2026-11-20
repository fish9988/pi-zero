/**
 * Pi `<agentDir>/models.json` 纯解析、编辑与 ZCode `ProviderSettingsProviderView` 双向同步映射（domain 层，0 IO）。
 * 严禁任何读取函数暴露明文 `apiKey`。
 */
import type {
  ModelConfigObject,
  ProviderApiType,
  ProviderConfigObject,
  ProviderSettingsModelView,
  ProviderSettingsProviderView,
} from "@zcode/provider";
import {
  buildTierEntryForFormat,
  compileThinkingProfileToOptionSpec,
  isOffThinkingLevel,
  parseOptionSpecToThinkingProfile,
  resolveDefaultThinkingFormat,
} from "@zcode/shared/model-config";
import {
  PI_THINKING_LEVELS,
  type PiCustomKeyState,
  type PiCustomModelEntry,
  type PiCustomProviderSaveInput,
  type PiCustomProviderSummary,
  type PiCustomThinkingLevelMap,
  type PiThinkingLevel,
} from "@zcode/shared/pi-config";
import {
  hasControlChars,
  isPlainRecord,
  isValidEnvVarName,
  stripBom,
  stripJsonComments,
} from "./piConfigHelpers.js";

const PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const ENV_LIKE_RE = /^[A-Z][A-Z0-9_]*$/;
const DOLLAR_ENV_RE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;
const KNOWN_PI_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "bedrock-converse-stream",
  "azure-openai-responses",
]);
const THINKING_LEVEL_SET = new Set<string>(PI_THINKING_LEVELS);

export type EnvVarSource = "system" | "env-file" | "missing";

function nonEmptyStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizeEnvName(raw: string): string {
  const m = DOLLAR_ENV_RE.exec(raw.trim());
  return m ? (m[1] ?? m[2])! : raw.trim();
}

export function normalizePiBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || hasControlChars(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return trimmed.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function mapZCodeApiTypeToPiApi(apiType: string | null | undefined): string {
  switch (apiType) {
    case "anthropic":
    case "anthropic-messages":
      return "anthropic-messages";
    case "openai-responses":
      return "openai-responses";
    case "gemini":
    case "google":
    case "google-generative-ai":
      return "google-generative-ai";
    case "openai-chat-completions":
    case "openai-completions":
    case "openai-compatible":
    case "openai":
    default:
      return "openai-completions";
  }
}

function parseRootJson(text: string | null): Record<string, unknown> | null {
  if (text === null || text.trim() === "") return {};
  const cleaned = stripJsonComments(stripBom(text)).trim();
  if (!cleaned) return {};
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return isPlainRecord(parsed) ? { ...parsed } : null;
  } catch {
    return null;
  }
}

function resolveKeyState(
  entry: Record<string, unknown>,
  sourceOf: (name: string) => EnvVarSource,
): PiCustomKeyState {
  const raw = entry["apiKey"];
  if (typeof raw !== "string" || raw.trim() === "") return { kind: "none" };
  const key = raw.trim();
  if (key.startsWith("!")) return { kind: "command", configured: true };
  const dollar = DOLLAR_ENV_RE.exec(key);
  if (dollar) {
    const name = (dollar[1] ?? dollar[2])!;
    return { kind: "env", name, source: sourceOf(name) };
  }
  if (!isValidEnvVarName(key)) return { kind: "literal", configured: true };
  const source = sourceOf(key);
  return ENV_LIKE_RE.test(key) || source !== "missing"
    ? { kind: "env", name: key, source }
    : { kind: "literal", configured: true };
}

function parseThinkingLevelMap(raw: unknown): PiCustomThinkingLevelMap | null {
  if (!isPlainRecord(raw)) return null;
  const out: Record<string, string | null> = {};
  for (const level of PI_THINKING_LEVELS) {
    const val = raw[level];
    if (val === null) out[level] = null;
    else if (typeof val === "string" && val.trim() !== "") out[level] = val.trim();
    else if (val !== undefined) return null;
  }
  if (Object.keys(out).length !== Object.keys(raw).length || Object.keys(out).length === 0) {
    return null;
  }
  return out as PiCustomThinkingLevelMap;
}

function parseCustomModels(raw: unknown): PiCustomModelEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PiCustomModelEntry[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    const id = nonEmptyStr(item["id"]);
    if (!id) continue;
    const input = item["input"];
    out.push({
      id,
      name: nonEmptyStr(item["name"]),
      reasoning: typeof item["reasoning"] === "boolean" ? item["reasoning"] : null,
      images: Array.isArray(input) ? input.includes("image") : null,
      contextWindow:
        typeof item["contextWindow"] === "number" && item["contextWindow"] > 0
          ? Math.trunc(item["contextWindow"])
          : null,
      maxTokens:
        typeof item["maxTokens"] === "number" && item["maxTokens"] > 0
          ? Math.trunc(item["maxTokens"])
          : null,
      thinkingLevelMap: parseThinkingLevelMap(item["thinkingLevelMap"]),
    });
  }
  return out;
}

/** 解析 `models.json` 中的自定义 Provider 摘要（严格不含明文密钥）。 */
export function parsePiCustomProviders(
  text: string | null,
  sourceOf: (name: string) => EnvVarSource,
): PiCustomProviderSummary[] {
  const root = parseRootJson(text);
  if (!root || !isPlainRecord(root["providers"])) return [];
  const out: PiCustomProviderSummary[] = [];
  for (const [id, raw] of Object.entries(root["providers"])) {
    if (!isPlainRecord(raw)) continue;
    out.push({
      id,
      baseUrl: nonEmptyStr(raw["baseUrl"]),
      api: nonEmptyStr(raw["api"]),
      key: resolveKeyState(raw, sourceOf),
      models: parseCustomModels(raw["models"]),
    });
  }
  return out;
}

function serializeModelsJson(root: Record<string, unknown>, original: string | null): string {
  const eol = original?.includes("\r\n") ? "\r\n" : "\n";
  const text = `${JSON.stringify(root, null, 2)}\n`;
  return eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;
}

function applyModelEntryToObject(
  base: Record<string, unknown>,
  entry: PiCustomModelEntry,
): Record<string, unknown> {
  const node: Record<string, unknown> = { ...base, id: entry.id };
  if (entry.name && entry.name.trim()) node["name"] = entry.name.trim();
  if (typeof entry.reasoning === "boolean") node["reasoning"] = entry.reasoning;
  if (typeof entry.images === "boolean") {
    node["input"] = entry.images ? ["text", "image"] : ["text"];
  }
  if (typeof entry.contextWindow === "number" && entry.contextWindow > 0) {
    node["contextWindow"] = Math.trunc(entry.contextWindow);
  }
  if (typeof entry.maxTokens === "number" && entry.maxTokens > 0) {
    node["maxTokens"] = Math.trunc(entry.maxTokens);
  }
  if (entry.thinkingLevelMap && Object.keys(entry.thinkingLevelMap).length > 0) {
    const cleanMap: Record<string, string | null> = {};
    for (const [lvl, mapped] of Object.entries(entry.thinkingLevelMap)) {
      if (!THINKING_LEVEL_SET.has(lvl)) continue;
      if (mapped === null || (typeof mapped === "string" && mapped.trim() !== "")) {
        cleanMap[lvl] = mapped === null ? null : mapped.trim();
      }
    }
    if (Object.keys(cleanMap).length > 0) node["thinkingLevelMap"] = cleanMap;
    else delete node["thinkingLevelMap"];
  } else if (entry.thinkingLevelMap === null) {
    delete node["thinkingLevelMap"];
  }
  return node;
}

/** 新增或更新 `models.json` 中的单个自定义 Provider（完整保留 `$schema` 与其余未知字段）。 */
export function applyPiCustomProviderToText(
  originalText: string | null,
  input: PiCustomProviderSaveInput,
): string {
  const id = input.id.trim();
  if (!PROVIDER_ID_RE.test(id)) throw new Error(`Invalid provider ID: "${input.id}"`);
  const baseUrl = normalizePiBaseUrl(input.baseUrl);
  if (!baseUrl) throw new Error(`Invalid base URL: "${input.baseUrl}"`);
  const api = input.api.trim();
  if (!KNOWN_PI_APIS.has(api)) throw new Error(`Unsupported Pi provider API: "${input.api}"`);

  const root = parseRootJson(originalText);
  if (!root) throw new Error("models.json is not a valid JSON object");
  const rawProviders = root["providers"];
  const providers: Record<string, unknown> = isPlainRecord(rawProviders) ? { ...rawProviders } : {};
  const existing = isPlainRecord(providers[id]) ? { ...providers[id] } : {};

  existing["baseUrl"] = baseUrl;
  existing["api"] = api;

  if (input.key.kind === "literal") {
    const val = input.key.value.trim();
    if (!val || hasControlChars(val)) throw new Error("Invalid API key");
    existing["apiKey"] = val;
  } else if (input.key.kind === "env") {
    const envName = normalizeEnvName(input.key.name);
    if (!isValidEnvVarName(envName)) throw new Error(`Invalid env var name: "${input.key.name}"`);
    existing["apiKey"] = `$${envName}`;
  } else if (input.key.kind === "none") {
    delete existing["apiKey"];
  }

  const prevModelsById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(existing["models"])) {
    for (const item of existing["models"]) {
      if (isPlainRecord(item) && typeof item["id"] === "string") {
        prevModelsById.set(item["id"], item);
      }
    }
  }

  const nextModels: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();
  for (const model of input.models) {
    const mid = model.id.trim();
    if (!mid || hasControlChars(mid) || seenIds.has(mid)) continue;
    seenIds.add(mid);
    nextModels.push(
      applyModelEntryToObject(prevModelsById.get(mid) ?? { id: mid }, { ...model, id: mid }),
    );
  }
  if (nextModels.length > 0) existing["models"] = nextModels;
  else delete existing["models"];

  providers[id] = existing;
  root["providers"] = providers;
  return serializeModelsJson(root, originalText);
}

/** 从 `models.json` 文本中移除单个自定义 Provider（保留其余所有字段）。 */
export function removePiCustomProviderFromText(
  originalText: string | null,
  providerId: string,
): { changed: boolean; text: string } {
  const id = providerId.trim();
  const root = parseRootJson(originalText);
  if (!root || !isPlainRecord(root["providers"]) || !(id in root["providers"])) {
    return { changed: false, text: originalText ?? "" };
  }
  const providers: Record<string, unknown> = { ...root["providers"] };
  delete providers[id];
  root["providers"] = providers;
  return { changed: true, text: serializeModelsJson(root, originalText) };
}

const DEFAULT_PI_CONTEXT_WINDOW = 128_000;
const DEFAULT_PI_MAX_OUTPUT_TOKENS = 16_384;

function buildThinkingLevelMapFromZCodeLevels(
  levels: readonly string[] | null | undefined,
  celMap?: string | null | undefined,
): PiCustomThinkingLevelMap | null {
  if (!levels || levels.length === 0) return null;
  const wireByLevel = new Map<string, string>();
  if (typeof celMap === "string" && celMap.trim() !== "") {
    const profile = parseOptionSpecToThinkingProfile(levels, celMap);
    if (profile.format !== "custom-cel" && profile.format !== "noop") {
      for (const tier of profile.tiers) {
        if (tier.action === "value" && tier.wireValue?.trim()) {
          wireByLevel.set(tier.id.trim().toLowerCase(), tier.wireValue.trim());
        }
      }
    }
  }
  const normalized = new Map<string, string>();
  for (const raw of levels) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    normalized.set(lower, wireByLevel.get(lower) ?? trimmed);
  }
  const hasRecognized = PI_THINKING_LEVELS.some((level) => normalized.has(level));
  if (!hasRecognized) return null;
  const map: Record<string, string | null> = {};
  for (const level of PI_THINKING_LEVELS) {
    const matched = normalized.get(level);
    map[level] = matched !== undefined ? matched : null;
  }
  return map as PiCustomThinkingLevelMap;
}

export function mapPiApiToZCodeApiType(api: string | null | undefined): ProviderApiType {
  switch (api) {
    case "anthropic-messages":
      return "anthropic-messages";
    case "openai-responses":
    case "azure-openai-responses":
      return "openai-responses";
    default:
      return "openai-chat-completions";
  }
}

export function resolvePiKeyWriteInputFromUiValue(
  rawValue: string | null | undefined,
): PiCustomProviderSaveInput["key"] {
  const trimmed = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!trimmed) return { kind: "keep" };
  const dollar = DOLLAR_ENV_RE.exec(trimmed);
  if (dollar) {
    const name = (dollar[1] ?? dollar[2])!;
    return { kind: "env", name };
  }
  return { kind: "literal", value: trimmed };
}

function resolveReasoningLevelsFromPiModel(model: PiCustomModelEntry): PiThinkingLevel[] {
  if (model.thinkingLevelMap && Object.keys(model.thinkingLevelMap).length > 0) {
    const enabled = PI_THINKING_LEVELS.filter((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      return mapped !== null && mapped !== undefined && mapped.trim() !== "";
    });
    if (enabled.length > 0) return enabled;
  }
  if (model.reasoning === true) {
    return ["low", "medium", "high"];
  }
  return ["off"];
}

function resolveReasoningSpecFromPiModel(
  model: PiCustomModelEntry,
  apiType: ProviderApiType,
): { readonly values: readonly string[]; readonly map: string } {
  const levels = resolveReasoningLevelsFromPiModel(model);
  const hasReasoning = levels.some((level) => !isOffThinkingLevel(level));
  if (!hasReasoning) {
    return { values: ["off"], map: "{}" };
  }
  const format = resolveDefaultThinkingFormat(apiType);
  const tiers = levels.map((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    const wireOverride =
      typeof mapped === "string" && mapped.trim() !== "" ? mapped.trim() : undefined;
    return buildTierEntryForFormat(level, format, wireOverride);
  });
  return compileThinkingProfileToOptionSpec({ format, tiers });
}

/** 将 Pi `models.json` 单条模型投影为 ZCode 设置页可读写的 `ProviderSettingsModelView`。 */
export function projectPiCustomModelToSettingsView(
  model: PiCustomModelEntry,
  apiType: ProviderApiType = "openai-chat-completions",
): ProviderSettingsModelView {
  const contextWindow =
    typeof model.contextWindow === "number" &&
    Number.isFinite(model.contextWindow) &&
    model.contextWindow > 0
      ? Math.trunc(model.contextWindow)
      : DEFAULT_PI_CONTEXT_WINDOW;
  const maxOutputTokens =
    typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0
      ? Math.trunc(model.maxTokens)
      : DEFAULT_PI_MAX_OUTPUT_TOKENS;
  const reasoningSpec = resolveReasoningSpecFromPiModel(model, apiType);
  const config: ModelConfigObject = {
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: model.images === true,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: {
        supportsText: true,
      },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: {
        values: [...reasoningSpec.values],
        map: reasoningSpec.map,
      },
      maxOutputTokens: {
        max: maxOutputTokens,
        map: "{}",
      },
    },
  };
  return {
    kind: "candidate",
    modelId: model.id,
    builtin: false,
    effectiveBuiltinConfig: {},
    personalExactConfig: config,
    useRecommendedConfig: false,
    effectiveConfig: config,
    enabled: true,
    executable: true,
    selectable: true,
    issues: [],
  };
}

/**
 * 将 Pi `models.json` 自定义 Provider 投影为 ZCode `ProviderSettingsProviderView`。
 * 严禁暴露明文密钥：环境变量引用返回 `$ENV_NAME`，字面量密钥返回空串并在保存时按 keep 保留原密钥。
 */
export function projectPiCustomProviderToSettingsView(
  custom: PiCustomProviderSummary,
): ProviderSettingsProviderView {
  const apiType = mapPiApiToZCodeApiType(custom.api);
  const apiKeyDisplay = custom.key.kind === "env" ? `$${custom.key.name}` : "";
  const hasKey =
    custom.key.kind === "literal" ||
    custom.key.kind === "command" ||
    (custom.key.kind === "env" && custom.key.source !== "missing");
  const config: ProviderConfigObject = {
    group: "standard-personal",
    api: {
      type: apiType,
      ...(custom.baseUrl ? { baseUrl: custom.baseUrl } : {}),
    },
    access: {
      type: "api-key",
      apiKey: apiKeyDisplay,
    },
  };
  return {
    providerId: custom.id,
    providerName: custom.id,
    enabled: true,
    executable: Boolean(custom.baseUrl) && (hasKey || custom.models.length > 0),
    personalConfig: config,
    effectiveConfig: config,
    issues: [],
    models: custom.models.map((model) => projectPiCustomModelToSettingsView(model, apiType)),
  };
}

/** 将 ZCode 模型配置对象转换为 Pi `models.json` 模型条目（保留已有未知元数据的默认值）。 */
export function convertZCodeModelConfigToPiModelEntry(
  modelId: string,
  config: ModelConfigObject | undefined,
  existing?: PiCustomModelEntry | undefined,
): PiCustomModelEntry {
  const reasoningValues = config?.optionSpecs?.reasoningLevel?.values;
  const reasoningMap = config?.optionSpecs?.reasoningLevel?.map ?? undefined;
  const hasReasoningSpec = Array.isArray(reasoningValues);
  const hasReasoning = hasReasoningSpec
    ? reasoningValues.some((v) => !isOffThinkingLevel(v))
    : (existing?.reasoning ?? false);
  const thinkingLevelMap = hasReasoningSpec
    ? hasReasoning
      ? buildThinkingLevelMapFromZCodeLevels(reasoningValues, reasoningMap)
      : null
    : (existing?.thinkingLevelMap ?? null);
  const supportsImage = config?.properties?.inputFormat?.supportsImage;
  const preservedName = existing && existing.id === modelId ? (existing.name ?? modelId) : modelId;
  return {
    id: modelId,
    name: preservedName,
    reasoning: hasReasoning,
    images: typeof supportsImage === "boolean" ? supportsImage : (existing?.images ?? false),
    contextWindow: config?.properties?.contextWindow ?? existing?.contextWindow ?? null,
    maxTokens: config?.optionSpecs?.maxOutputTokens?.max ?? existing?.maxTokens ?? null,
    thinkingLevelMap,
  };
}

/** 按指定顺序重排 `models.json` 中 `providers` 的键顺序（完整保留未列出项与其余字段）。 */
export function reorderPiCustomProvidersInText(
  originalText: string | null,
  orderedIds: readonly string[],
): { changed: boolean; text: string } {
  const root = parseRootJson(originalText);
  if (!root || !isPlainRecord(root["providers"])) {
    return { changed: false, text: originalText ?? "" };
  }
  const existing = root["providers"];
  const keys = Object.keys(existing);
  const nextProviders: Record<string, unknown> = {};
  const placed = new Set<string>();
  for (const id of orderedIds) {
    if (id in existing && !placed.has(id)) {
      nextProviders[id] = existing[id];
      placed.add(id);
    }
  }
  for (const key of keys) {
    if (!placed.has(key)) nextProviders[key] = existing[key];
  }
  const nextKeys = Object.keys(nextProviders);
  const changed = nextKeys.some((k, idx) => k !== keys[idx]);
  if (!changed) return { changed: false, text: originalText ?? "" };
  root["providers"] = nextProviders;
  return { changed: true, text: serializeModelsJson(root, originalText) };
}

export interface PiResolvedProviderConnectivityTarget {
  readonly providerId: string;
  readonly modelId: string;
  readonly baseUrl: string | null;
  readonly api: string;
  readonly apiKey: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly authHeader?: boolean | undefined;
  readonly keyProblem?: "missing-env" | "command-unsupported" | undefined;
  readonly missingEnvName?: string | undefined;
}

function resolveRawHeaderMap(
  raw: unknown,
  envLookup: (name: string) => string | undefined,
): Record<string, string> {
  if (!isPlainRecord(raw)) return {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const headerName = key.trim();
    if (!headerName || hasControlChars(headerName) || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || hasControlChars(trimmed)) continue;
    const dollar = DOLLAR_ENV_RE.exec(trimmed);
    if (dollar) {
      const envName = (dollar[1] ?? dollar[2])!;
      const resolved = envLookup(envName)?.trim();
      if (resolved && !hasControlChars(resolved)) {
        headers[headerName] = resolved;
      }
      continue;
    }
    headers[headerName] = trimmed;
  }
  return headers;
}

/**
 * 仅限主进程/Host 内部用于远程 `/models` 拉取时解析 `models.json` 中的真实密钥，
 * 绝不回传给渲染进程或写入日志。
 */
export function resolvePiCustomProviderRawApiKeyFromText(
  text: string | null,
  providerId: string,
  envLookup: (name: string) => string | undefined,
): string | null {
  const root = parseRootJson(text);
  if (!root || !isPlainRecord(root["providers"])) return null;
  const entry = root["providers"][providerId];
  if (!isPlainRecord(entry)) return null;
  const raw = entry["apiKey"];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const key = raw.trim();
  if (key.startsWith("!")) return null;
  const dollar = DOLLAR_ENV_RE.exec(key);
  if (dollar) {
    const name = (dollar[1] ?? dollar[2])!;
    const resolved = envLookup(name)?.trim();
    return resolved || null;
  }
  if (ENV_LIKE_RE.test(key)) {
    const resolved = envLookup(key)?.trim();
    if (resolved) return resolved;
  }
  return key;
}

/**
 * 仅限主进程/Host 内部用于模型连通性测试时解析 `models.json` 中的目标连接配置与真实凭据，
 * 绝不回传给渲染进程或写入日志。
 */
export function resolvePiProviderConnectivityTargetFromText(
  text: string | null,
  providerId: string,
  modelId: string,
  envLookup: (name: string) => string | undefined,
): PiResolvedProviderConnectivityTarget | null {
  const root = parseRootJson(text);
  if (!root || !isPlainRecord(root["providers"])) return null;
  const entry = root["providers"][providerId];
  if (!isPlainRecord(entry)) return null;

  const trimmedModelId = modelId.trim();
  const rawModels = Array.isArray(entry["models"]) ? entry["models"] : [];
  const matchedModel = rawModels.find(
    (item): item is Record<string, unknown> =>
      isPlainRecord(item) && nonEmptyStr(item["id"]) === trimmedModelId,
  );

  const rawBaseUrl = nonEmptyStr(entry["baseUrl"]);
  const baseUrl = rawBaseUrl ? normalizePiBaseUrl(rawBaseUrl) : null;
  const api =
    nonEmptyStr(matchedModel?.["api"]) ?? nonEmptyStr(entry["api"]) ?? "openai-completions";
  const headers: Record<string, string> = {
    ...resolveRawHeaderMap(entry["headers"], envLookup),
    ...resolveRawHeaderMap(matchedModel?.["headers"], envLookup),
  };
  const authHeader = typeof entry["authHeader"] === "boolean" ? entry["authHeader"] : undefined;

  let apiKey: string | null = null;
  let keyProblem: PiResolvedProviderConnectivityTarget["keyProblem"];
  let missingEnvName: string | undefined;

  const rawKey = entry["apiKey"];
  if (typeof rawKey === "string" && rawKey.trim() !== "") {
    const key = rawKey.trim();
    if (key.startsWith("!")) {
      keyProblem = "command-unsupported";
    } else {
      const dollar = DOLLAR_ENV_RE.exec(key);
      if (dollar) {
        const name = (dollar[1] ?? dollar[2])!;
        const resolved = envLookup(name)?.trim();
        if (resolved) {
          apiKey = resolved;
        } else {
          keyProblem = "missing-env";
          missingEnvName = name;
        }
      } else if (ENV_LIKE_RE.test(key)) {
        const resolved = envLookup(key)?.trim();
        if (resolved) {
          apiKey = resolved;
        } else if (key.includes("_")) {
          keyProblem = "missing-env";
          missingEnvName = key;
        } else {
          apiKey = key;
        }
      } else {
        apiKey = key;
      }
    }
  }

  return {
    providerId,
    modelId: trimmedModelId,
    baseUrl,
    api,
    apiKey,
    headers,
    ...(authHeader !== undefined ? { authHeader } : {}),
    ...(keyProblem ? { keyProblem } : {}),
    ...(missingEnvName ? { missingEnvName } : {}),
  };
}

/**
 * 将 ZCode 自定义 Provider（含 `/models` 批量导入模型与多档思考强度编辑器配置）
 * 转换为标准 Pi `models.json` 写入输入，实现双向持久化同步。
 */
export function convertZCodeProviderViewToPiSaveInput(
  provider: ProviderSettingsProviderView,
  apiKeyWrite: PiCustomProviderSaveInput["key"],
): PiCustomProviderSaveInput | null {
  const baseUrl = provider.effectiveConfig.api?.baseUrl?.trim();
  if (!baseUrl || !normalizePiBaseUrl(baseUrl)) return null;
  const enabledModels = provider.models.filter((m) => m.enabled !== false);
  const models: PiCustomModelEntry[] = enabledModels.map((model) =>
    convertZCodeModelConfigToPiModelEntry(model.modelId, model.effectiveConfig),
  );
  return {
    id: provider.providerId,
    baseUrl,
    api: mapZCodeApiTypeToPiApi(provider.effectiveConfig.api?.type),
    key: apiKeyWrite,
    models,
  };
}
