/**
 * Pi `<agentDir>/models.json` 纯解析、编辑与 ZCode `ProviderSettingsProviderView` 双向同步映射（domain 层，0 IO）。
 * 严禁任何读取函数暴露明文 `apiKey`。
 */
import type { ProviderSettingsProviderView } from "@zcode/provider";
import {
  PI_THINKING_LEVELS,
  type PiCustomKeyState,
  type PiCustomModelEntry,
  type PiCustomProviderSaveInput,
  type PiCustomProviderSummary,
  type PiCustomThinkingLevelMap,
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

function buildThinkingLevelMapFromZCodeLevels(
  levels: readonly string[] | null | undefined,
): PiCustomThinkingLevelMap | null {
  if (!levels || levels.length === 0) return null;
  const normalized = new Map<string, string>();
  for (const raw of levels) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    normalized.set(trimmed.toLowerCase(), trimmed);
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
  const models: PiCustomModelEntry[] = enabledModels.map((model) => {
    const cfg = model.effectiveConfig;
    const reasoningValues = cfg.optionSpecs?.reasoningLevel?.values;
    const hasReasoning = Array.isArray(reasoningValues) && reasoningValues.some((v) => v !== "off");
    const thinkingLevelMap = buildThinkingLevelMapFromZCodeLevels(reasoningValues);
    return {
      id: model.modelId,
      name: model.modelId,
      reasoning: hasReasoning,
      images: cfg.properties?.inputFormat?.supportsImage === true,
      contextWindow: cfg.properties?.contextWindow ?? null,
      maxTokens: cfg.optionSpecs?.maxOutputTokens?.max ?? null,
      thinkingLevelMap,
    };
  });
  return {
    id: provider.providerId,
    baseUrl,
    api: mapZCodeApiTypeToPiApi(provider.effectiveConfig.api?.type),
    key: apiKeyWrite,
    models,
  };
}
