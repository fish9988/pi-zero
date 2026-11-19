/**
 * Pi `settings.json`、`keybindings.json` 与系统提示词文档（`AGENTS.md` / `SYSTEM.md` / `APPEND_SYSTEM.md`）读写器。
 * 全程保留未知字段，原子写入并写前留 `.bak`。
 */
import { unlink } from "node:fs/promises";
import path from "node:path";
import {
  PI_SETTINGS_SCHEMA,
  PI_SETTINGS_TABS,
  PI_SYSTEM_DOC_KINDS,
  PI_THINKING_LEVELS,
  findPiSettingSchema,
  type PiConfigScope,
  type PiKeybindingEntry,
  type PiSettingItem,
  type PiSettingsSnapshot,
  type PiSettingWriteResult,
  type PiSystemDoc,
  type PiSystemDocKind,
  type PiThinkingLevel,
} from "@zcode/shared/pi-config";
import {
  deleteNestedValue,
  getNestedValue,
  hasControlChars,
  maskSettingValue,
  resolvePiKeybindingsEntries,
  setNestedValue,
  splitDotKey,
  stripBom,
  validateSettingWrite,
} from "../domain/piConfigHelpers.js";
import {
  atomicWritePiFile,
  enqueuePiFileWrite,
  isEnoent,
  readPiJsonObject,
  readPiTextIfExists,
} from "./piAtomicFile.js";

const THINKING_SET = new Set<string>(PI_THINKING_LEVELS);
const SYSTEM_DOC_SET = new Set<string>(PI_SYSTEM_DOC_KINDS);

export function resolvePiSettingsFilePath(
  agentDir: string,
  scope: PiConfigScope = "global",
  workspacePath?: string | null,
): string {
  if (scope === "project") {
    if (!workspacePath?.trim()) {
      throw new Error("workspacePath is required when scope is 'project'");
    }
    return path.join(workspacePath, ".pi", "settings.json");
  }
  return path.join(agentDir, "settings.json");
}

export function mutatePiSettingsJson<T>(
  agentDir: string,
  scope: PiConfigScope,
  workspacePath: string | null | undefined,
  mutator: (
    data: Record<string, unknown>,
    exists: boolean,
  ) => { write: boolean; result: T } | Promise<{ write: boolean; result: T }>,
): Promise<T> {
  const filePath = resolvePiSettingsFilePath(agentDir, scope, workspacePath);
  return enqueuePiFileWrite(filePath, async () => {
    const { exists, data } = await readPiJsonObject(filePath, true);
    const { write, result } = await mutator(data, exists);
    if (write) {
      await atomicWritePiFile(filePath, `${JSON.stringify(data, null, 2)}\n`, {
        backup: true,
        tag: "pi-settings",
      });
    }
    return result;
  });
}

function nonEmptyTrimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export async function readPiSettingsSnapshot(
  agentDir: string,
  piVersion: string | null,
  workspacePath?: string | null,
): Promise<PiSettingsSnapshot> {
  const globalPath = resolvePiSettingsFilePath(agentDir, "global");
  const [{ data: globalObj }, projectResult] = await Promise.all([
    readPiJsonObject(globalPath, false),
    workspacePath?.trim()
      ? readPiJsonObject(resolvePiSettingsFilePath(agentDir, "project", workspacePath), false)
      : Promise.resolve(null),
  ]);
  const projectObj = projectResult?.data ?? null;
  const projectOverrides: string[] = [];

  const items: PiSettingItem[] = PI_SETTINGS_SCHEMA.map((entry) => {
    const globalVal = getNestedValue(globalObj, entry.key);
    const projectVal =
      !entry.globalOnly && projectObj !== null ? getNestedValue(projectObj, entry.key) : undefined;
    if (projectVal !== undefined) projectOverrides.push(entry.key);
    const effective = projectVal !== undefined ? projectVal : globalVal;
    const hasValue = effective !== undefined;
    const masked = hasValue
      ? maskSettingValue(entry.key, effective)
      : { value: entry.hasDefault ? structuredClone(entry.defaultValue) : null, redacted: false };
    return {
      key: entry.key,
      tab: entry.tab,
      type: entry.type,
      labelZh: entry.labelZh,
      labelEn: entry.labelEn,
      description: entry.descZh,
      options: entry.options ? [...entry.options] : null,
      value: masked.value,
      hasValue,
      redacted: masked.redacted,
      defaultValue: entry.hasDefault ? structuredClone(entry.defaultValue) : null,
      hasDefault: entry.hasDefault,
      ...(entry.globalOnly ? { globalOnly: true } : {}),
    };
  });

  const provider =
    (projectObj ? nonEmptyTrimmed(projectObj["defaultProvider"]) : null) ??
    nonEmptyTrimmed(globalObj["defaultProvider"]);
  const modelId =
    (projectObj ? nonEmptyTrimmed(projectObj["defaultModel"]) : null) ??
    nonEmptyTrimmed(globalObj["defaultModel"]);
  const rawThinking =
    (projectObj ? nonEmptyTrimmed(projectObj["defaultThinkingLevel"]) : null) ??
    nonEmptyTrimmed(globalObj["defaultThinkingLevel"]);
  const thinkingLevel =
    rawThinking && THINKING_SET.has(rawThinking) ? (rawThinking as PiThinkingLevel) : null;

  return {
    piVersion,
    agentDir,
    tabs: [...PI_SETTINGS_TABS],
    items,
    projectOverrides,
    modelDefaults: { provider, modelId, thinkingLevel },
  };
}

export async function setPiSettingValue(input: {
  agentDir: string;
  key: string;
  valueJson: string;
  scope?: PiConfigScope | undefined;
  workspacePath?: string | undefined;
}): Promise<PiSettingWriteResult> {
  const scope = input.scope ?? "global";
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.valueJson);
  } catch (error) {
    throw new Error(
      `Invalid JSON value for "${input.key}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (parsed === undefined) throw new Error(`Setting "${input.key}" value cannot be undefined`);
  validateSettingWrite(input.key, parsed, scope);

  await mutatePiSettingsJson(input.agentDir, scope, input.workspacePath, (data) => {
    setNestedValue(data, input.key, parsed);
    return { write: true, result: undefined };
  });

  const schema = findPiSettingSchema(input.key);
  if (scope === "global" && !schema?.globalOnly && input.workspacePath?.trim()) {
    const { data: projectObj } = await readPiJsonObject(
      resolvePiSettingsFilePath(input.agentDir, "project", input.workspacePath),
      false,
    );
    const projectVal = getNestedValue(projectObj, input.key);
    if (projectVal !== undefined) {
      const masked = maskSettingValue(input.key, projectVal);
      return {
        key: input.key,
        value: masked.value,
        hasValue: true,
        redacted: masked.redacted,
        overriddenBy: "project",
      };
    }
  }
  const masked = maskSettingValue(input.key, parsed);
  return { key: input.key, value: masked.value, hasValue: true, redacted: masked.redacted };
}

export async function resetPiSettingValue(input: {
  agentDir: string;
  key: string;
  scope?: PiConfigScope | undefined;
  workspacePath?: string | undefined;
}): Promise<PiSettingWriteResult> {
  const scope = input.scope ?? "global";
  splitDotKey(input.key);
  const schema = findPiSettingSchema(input.key);
  if (schema?.globalOnly && scope === "project") {
    throw new Error(`Setting "${input.key}" can only be reset in global settings.json`);
  }

  await mutatePiSettingsJson(input.agentDir, scope, input.workspacePath, (data, exists) => {
    if (!exists) return { write: false, result: undefined };
    const deleted = deleteNestedValue(data, input.key);
    return { write: deleted, result: undefined };
  });

  const [{ data: globalObj }, projectResult] = await Promise.all([
    readPiJsonObject(resolvePiSettingsFilePath(input.agentDir, "global"), false),
    !schema?.globalOnly && input.workspacePath?.trim()
      ? readPiJsonObject(
          resolvePiSettingsFilePath(input.agentDir, "project", input.workspacePath),
          false,
        )
      : Promise.resolve(null),
  ]);
  const projectVal = projectResult ? getNestedValue(projectResult.data, input.key) : undefined;
  const globalVal = getNestedValue(globalObj, input.key);
  if (projectVal !== undefined) {
    const masked = maskSettingValue(input.key, projectVal);
    return {
      key: input.key,
      value: masked.value,
      hasValue: true,
      redacted: masked.redacted,
      ...(scope === "global" ? { overriddenBy: "project" as const } : {}),
    };
  }
  if (globalVal !== undefined) {
    const masked = maskSettingValue(input.key, globalVal);
    return { key: input.key, value: masked.value, hasValue: true, redacted: masked.redacted };
  }
  return {
    key: input.key,
    value: schema?.hasDefault ? structuredClone(schema.defaultValue) : null,
    hasValue: false,
    redacted: false,
  };
}

export async function writePiModelDefaults(input: {
  agentDir: string;
  model: { readonly provider: string; readonly modelId: string } | null;
  thinkingLevel?: PiThinkingLevel | null | undefined;
  scope?: PiConfigScope | undefined;
  workspacePath?: string | undefined;
}): Promise<void> {
  if (
    input.thinkingLevel !== undefined &&
    input.thinkingLevel !== null &&
    !THINKING_SET.has(input.thinkingLevel)
  ) {
    throw new Error(`Invalid thinking level: "${input.thinkingLevel}"`);
  }
  await mutatePiSettingsJson(
    input.agentDir,
    input.scope ?? "global",
    input.workspacePath,
    (data) => {
      if (input.model === null) {
        deleteNestedValue(data, "defaultProvider");
        deleteNestedValue(data, "defaultModel");
      } else {
        setNestedValue(data, "defaultProvider", input.model.provider.trim());
        setNestedValue(data, "defaultModel", input.model.modelId.trim());
      }
      if (input.thinkingLevel !== undefined) {
        if (input.thinkingLevel === null) deleteNestedValue(data, "defaultThinkingLevel");
        else setNestedValue(data, "defaultThinkingLevel", input.thinkingLevel);
      }
      return { write: true, result: undefined };
    },
  );
}

// ── keybindings.json ──

export async function readPiKeybindingsEntries(
  agentDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<PiKeybindingEntry[]> {
  const { data } = await readPiJsonObject(path.join(agentDir, "keybindings.json"), false);
  return resolvePiKeybindingsEntries(data, platform);
}

export async function savePiKeybindingEntry(
  agentDir: string,
  action: string,
  chords: readonly string[] | null,
  platform: NodeJS.Platform = process.platform,
): Promise<PiKeybindingEntry[]> {
  const trimmedAction = action.trim();
  if (!trimmedAction.startsWith("app.") || hasControlChars(trimmedAction)) {
    throw new Error(`Invalid Pi keybinding action: "${action}"`);
  }
  const filePath = path.join(agentDir, "keybindings.json");
  await enqueuePiFileWrite(filePath, async () => {
    const { data } = await readPiJsonObject(filePath, true);
    if (chords === null || chords.length === 0) {
      delete data[trimmedAction];
    } else {
      const cleaned = chords
        .map((c) => c.trim())
        .filter((c) => c.length > 0 && !hasControlChars(c));
      if (cleaned.length === 0) delete data[trimmedAction];
      else data[trimmedAction] = cleaned.length === 1 ? cleaned[0] : cleaned;
    }
    await atomicWritePiFile(filePath, `${JSON.stringify(data, null, 2)}\n`, {
      backup: true,
      tag: "pi-keys",
    });
  });
  return readPiKeybindingsEntries(agentDir, platform);
}

// ── AGENTS.md / SYSTEM.md / APPEND_SYSTEM.md ──

export function resolvePiSystemDocPath(
  agentDir: string,
  scope: PiConfigScope,
  kind: PiSystemDocKind,
  workspacePath?: string | null,
): string {
  if (!SYSTEM_DOC_SET.has(kind)) throw new Error(`Invalid system doc kind: "${kind}"`);
  if (scope === "project") {
    if (!workspacePath?.trim()) throw new Error("workspacePath is required for project system doc");
    return kind === "AGENTS.md"
      ? path.join(workspacePath, "AGENTS.md")
      : path.join(workspacePath, ".pi", kind);
  }
  return path.join(agentDir, kind);
}

export async function readPiSystemDoc(
  agentDir: string,
  scope: PiConfigScope,
  kind: PiSystemDocKind,
  workspacePath?: string | null,
): Promise<PiSystemDoc> {
  const filePath = resolvePiSystemDocPath(agentDir, scope, kind, workspacePath);
  const raw = await readPiTextIfExists(filePath);
  if (raw === null) return { kind, scope, exists: false, content: "", filePath };
  return { kind, scope, exists: true, content: stripBom(raw), filePath };
}

export async function savePiSystemDoc(
  agentDir: string,
  scope: PiConfigScope,
  kind: PiSystemDocKind,
  content: string,
  workspacePath?: string | null,
): Promise<PiSystemDoc> {
  const filePath = resolvePiSystemDocPath(agentDir, scope, kind, workspacePath);
  return enqueuePiFileWrite(filePath, async () => {
    if (content.trim() === "") {
      await unlink(filePath).catch((err: unknown) => {
        if (!isEnoent(err)) throw err;
      });
      return { kind, scope, exists: false, content: "", filePath };
    }
    await atomicWritePiFile(filePath, content, { backup: true, tag: "pi-doc" });
    return { kind, scope, exists: true, content, filePath };
  });
}
