/**
 * Pi 凭据（`<agentDir>/auth.json` + `.env`）与自定义模型配置（`<agentDir>/models.json`）存储，
 * 以及 ZCode `IProviderSettingsService` 到 `models.json` 的双向同步装饰器。
 *
 * 严格安全铁律：
 * - 凭据只进不出：绝不向调用方或日志返回明文 API Key、OAuth Token 或 `.env` 变量值；
 * - 所有含密钥文件统一以 `0o600` 权限原子写入并写前留 `.bak`。
 */
import path from "node:path";
import {
  PI_BUILTIN_PROVIDERS,
  type PiAuthAndProvidersSnapshot,
  type PiCustomProviderSaveInput,
  type PiEnvVarStatus,
  type PiProviderAuthStatus,
} from "@zcode/shared/pi-config";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { PiModelInfo } from "#src/pi-runtime/contract.js";
import {
  hasControlChars,
  isPlainRecord,
  isValidEnvVarName,
  parseConfiguredEnvKeys,
  removeDotEnvText,
  upsertDotEnvText,
} from "../domain/piConfigHelpers.js";
import {
  applyPiCustomProviderToText,
  parsePiCustomProviders,
  removePiCustomProviderFromText,
  type EnvVarSource,
} from "../domain/piModelsJsonCodec.js";
import {
  atomicWritePiFile,
  enqueuePiFileWrite,
  readPiJsonObject,
  readPiTextIfExists,
} from "./piAtomicFile.js";

const logger = createServiceLogger("pi-auth-models");
const PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

interface ParsedAuthEntry {
  readonly authType: "oauth" | "api_key";
  readonly accountHint: string | null;
  readonly maskedHint: string | null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 脱敏提示：仅输出长度/前缀类别标签，绝不输出任何明文字符或真实前缀。 */
function parseAuthCredentialSafe(raw: unknown): ParsedAuthEntry | null {
  if (!isPlainRecord(raw)) return null;
  if (raw["type"] === "oauth") {
    const hasToken = nonEmpty(raw["access"]) !== null || nonEmpty(raw["refresh"]) !== null;
    if (!hasToken) return null;
    const hint = nonEmpty(raw["email"]) ?? nonEmpty(raw["accountId"]) ?? nonEmpty(raw["projectId"]);
    return { authType: "oauth", accountHint: hint, maskedHint: "OAuth" };
  }
  if (raw["type"] === "api_key") {
    const key = nonEmpty(raw["key"]);
    const hasEnv = isPlainRecord(raw["env"]) && Object.keys(raw["env"]).length > 0;
    if (!key && !hasEnv) return null;
    const isCmd = key !== null && key.startsWith("!");
    return {
      authType: "api_key",
      accountHint: isCmd ? "command" : null,
      maskedHint: isCmd ? "Command (!)" : "••••••••",
    };
  }
  return null;
}

function resolveEnvSource(
  envKeysInFile: ReadonlySet<string>,
  processEnv: NodeJS.ProcessEnv,
): (name: string) => EnvVarSource {
  return (name: string) => {
    const sysVal = processEnv[name];
    if (typeof sysVal === "string" && sysVal.trim() !== "") return "system";
    if (envKeysInFile.has(name)) return "env-file";
    return "missing";
  };
}

export async function readPiAuthAndProvidersSnapshot(input: {
  agentDir: string;
  env?: NodeJS.ProcessEnv | undefined;
  availableModels?: readonly PiModelInfo[] | undefined;
  loginCommand: {
    readonly command: string;
    readonly args: readonly string[];
    readonly displayCommand: string;
  };
}): Promise<PiAuthAndProvidersSnapshot> {
  const processEnv = input.env ?? process.env;
  const authPath = path.join(input.agentDir, "auth.json");
  const envPath = path.join(input.agentDir, ".env");
  const modelsPath = path.join(input.agentDir, "models.json");

  const [{ data: authObj }, envText, modelsText] = await Promise.all([
    readPiJsonObject(authPath, false),
    readPiTextIfExists(envPath),
    readPiTextIfExists(modelsPath),
  ]);

  const fileEnvKeys = parseConfiguredEnvKeys(envText);
  const sourceOf = resolveEnvSource(fileEnvKeys, processEnv);

  const modelCounts = new Map<string, number>();
  for (const model of input.availableModels ?? []) {
    if (model.provider) {
      modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
    }
  }

  const seenIds = new Set<string>();
  const auth: PiProviderAuthStatus[] = [];
  const envVarMap = new Map<string, PiEnvVarStatus>();

  const trackEnvVar = (name: string) => {
    if (envVarMap.has(name)) return;
    const source = sourceOf(name);
    envVarMap.set(name, { name, source, configured: source !== "missing" });
  };

  for (const meta of PI_BUILTIN_PROVIDERS) {
    seenIds.add(meta.id);
    for (const v of meta.envVars) trackEnvVar(v);
    const cred = parseAuthCredentialSafe(authObj[meta.id]);
    const activeEnvVar = meta.envVars.find((v) => sourceOf(v) !== "missing") ?? null;
    auth.push({
      id: meta.id,
      name: meta.name,
      supportsOAuth: meta.supportsOAuth,
      acceptsApiKey: meta.acceptsApiKey,
      envVars: [...meta.envVars],
      activeEnvVar,
      authType: cred?.authType ?? null,
      configured: cred !== null || activeEnvVar !== null,
      maskedHint: cred?.maskedHint ?? (activeEnvVar ? `$${activeEnvVar}` : null),
      accountHint: cred?.accountHint ?? null,
      modelCount: modelCounts.get(meta.id) ?? 0,
    });
  }

  for (const [providerId, rawCred] of Object.entries(authObj)) {
    if (seenIds.has(providerId)) continue;
    const cred = parseAuthCredentialSafe(rawCred);
    if (!cred) continue;
    auth.push({
      id: providerId,
      name: providerId,
      supportsOAuth: cred.authType === "oauth",
      acceptsApiKey: true,
      envVars: [],
      activeEnvVar: null,
      authType: cred.authType,
      configured: true,
      maskedHint: cred.maskedHint,
      accountHint: cred.accountHint,
      modelCount: modelCounts.get(providerId) ?? 0,
    });
  }

  for (const keyName of fileEnvKeys) trackEnvVar(keyName);
  const customProviders = parsePiCustomProviders(modelsText, sourceOf);

  return {
    auth,
    envVars: [...envVarMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    customProviders,
    loginCommand: input.loginCommand,
  };
}

export async function savePiProviderApiKey(
  agentDir: string,
  providerId: string,
  apiKey: string,
): Promise<void> {
  const id = providerId.trim();
  if (!PROVIDER_ID_RE.test(id)) throw new Error(`Invalid provider ID: "${providerId}"`);
  const trimmedKey = apiKey.trim();
  if (!trimmedKey || trimmedKey.length > 4096 || hasControlChars(trimmedKey)) {
    throw new Error(`Invalid API key for provider "${id}"`);
  }
  const filePath = path.join(agentDir, "auth.json");
  await enqueuePiFileWrite(filePath, async () => {
    const { data } = await readPiJsonObject(filePath, true);
    const existing = data[id];
    const preservedEnv =
      isPlainRecord(existing) && isPlainRecord(existing["env"]) ? existing["env"] : undefined;
    data[id] = {
      type: "api_key",
      key: trimmedKey,
      ...(preservedEnv ? { env: preservedEnv } : {}),
    };
    await atomicWritePiFile(filePath, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
      backup: true,
      tag: "pi-auth",
    });
    logger.info(undefined, `Saved Pi API key credential for provider=${id}`);
  });
}

export async function removePiProviderCredential(
  agentDir: string,
  providerId: string,
): Promise<boolean> {
  const id = providerId.trim();
  if (!id) throw new Error("providerId must not be empty");
  const filePath = path.join(agentDir, "auth.json");
  return enqueuePiFileWrite(filePath, async () => {
    const { exists, data } = await readPiJsonObject(filePath, true);
    if (!exists || !(id in data)) return false;
    delete data[id];
    await atomicWritePiFile(filePath, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
      backup: true,
      tag: "pi-auth",
    });
    logger.info(undefined, `Removed Pi credential for provider=${id}`);
    return true;
  });
}

export async function savePiEnvVariable(
  agentDir: string,
  name: string,
  value: string,
): Promise<void> {
  const key = name.trim();
  if (!isValidEnvVarName(key)) throw new Error(`Invalid env var name: "${name}"`);
  const filePath = path.join(agentDir, ".env");
  await enqueuePiFileWrite(filePath, async () => {
    const existing = await readPiTextIfExists(filePath);
    const next = upsertDotEnvText(existing, key, value);
    await atomicWritePiFile(filePath, next, { mode: 0o600, backup: true, tag: "pi-env" });
    logger.info(undefined, `Saved Pi .env variable key=${key}`);
  });
}

export async function removePiEnvVariable(agentDir: string, name: string): Promise<boolean> {
  const key = name.trim();
  if (!isValidEnvVarName(key)) return false;
  const filePath = path.join(agentDir, ".env");
  return enqueuePiFileWrite(filePath, async () => {
    const existing = await readPiTextIfExists(filePath);
    const res = removeDotEnvText(existing, key);
    if (!res.changed) return false;
    await atomicWritePiFile(filePath, res.text, { mode: 0o600, backup: true, tag: "pi-env" });
    logger.info(undefined, `Removed Pi .env variable key=${key}`);
    return true;
  });
}

export async function savePiCustomProvider(
  agentDir: string,
  input: PiCustomProviderSaveInput,
): Promise<void> {
  if (input.key.kind === "env" && input.key.value && input.key.value.trim()) {
    await savePiEnvVariable(agentDir, input.key.name, input.key.value.trim());
  }
  const filePath = path.join(agentDir, "models.json");
  await enqueuePiFileWrite(filePath, async () => {
    const existing = await readPiTextIfExists(filePath);
    const next = applyPiCustomProviderToText(existing, input);
    await atomicWritePiFile(filePath, next, { mode: 0o600, backup: true, tag: "pi-models" });
    logger.info(undefined, `Saved Pi custom provider=${input.id} models=${input.models.length}`);
  });
}

export async function removePiCustomProvider(
  agentDir: string,
  providerId: string,
): Promise<boolean> {
  const filePath = path.join(agentDir, "models.json");
  return enqueuePiFileWrite(filePath, async () => {
    const existing = await readPiTextIfExists(filePath);
    const res = removePiCustomProviderFromText(existing, providerId);
    if (!res.changed) return false;
    await atomicWritePiFile(filePath, res.text, { mode: 0o600, backup: true, tag: "pi-models" });
    logger.info(undefined, `Removed Pi custom provider=${providerId}`);
    return true;
  });
}
