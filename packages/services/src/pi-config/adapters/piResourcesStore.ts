/**
 * Pi 资源汇总、扩展开关与包管理存储（adapters 层）：
 * - 内置/自定义扩展（`settings.json` `extensions`）；
 * - Pi 包管理（`settings.json` `packages` + 无 `shell: true` 的 `pi install/remove/update`）；
 * - 统一导出 MCP（`piMcpStore.ts`）与 Skills/Prompts（`piSkillsPromptsStore.ts`）操作与聚合快照。
 */
import { spawn } from "node:child_process";
import os from "node:os";
import {
  PI_BUILTIN_EXTENSIONS,
  type PiBuiltinExtensionId,
  type PiBuiltinExtensionState,
  type PiConfigScope,
  type PiPackageAction,
  type PiPackageActionResult,
  type PiPackageItem,
  type PiResourcesSnapshot,
} from "@zcode/shared/pi-config";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { terminateProcessTreeAndWait } from "#src/process/processTreeTerminator.js";
import type { PiLaunch } from "#src/pi-runtime/contract.js";
import {
  formatRedactedPiError,
  registerActivePiProcess,
  unregisterActivePiProcess,
  type DisposablePiProcess,
} from "#src/pi-runtime/index.js";
import {
  buildSafePiPackageArgs,
  deleteNestedValue,
  hasControlChars,
  isPlainRecord,
} from "../domain/piConfigHelpers.js";
import { readPiJsonObject } from "./piAtomicFile.js";
import { listPiMcpServers } from "./piMcpStore.js";
import {
  mutatePiSettingsJson,
  readPiKeybindingsEntries,
  resolvePiSettingsFilePath,
} from "./piSettingsStore.js";
import { listPiPromptTemplates, listPiSkills } from "./piSkillsPromptsStore.js";

export {
  deletePiMcpServer,
  listPiMcpServers,
  savePiMcpServer,
  setPiMcpServerEnabled,
} from "./piMcpStore.js";
export {
  deletePiPromptTemplate,
  deletePiSkillFolder,
  importPiSkillFolder,
  listPiPromptTemplates,
  listPiSkills,
  savePiPromptTemplate,
  setPiSkillEnabled,
} from "./piSkillsPromptsStore.js";

const logger = createServiceLogger("pi-resources");
const BUILTIN_EXT_SET = new Set<string>(PI_BUILTIN_EXTENSIONS);

function stringArray(obj: Record<string, unknown>, key: string): string[] {
  const raw = obj[key];
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((item): item is string => typeof item === "string");
}

function isBuiltinToken(entry: string): boolean {
  const t = entry.trim();
  const bare = t.startsWith("+") || t.startsWith("-") ? t.slice(1) : t;
  return bare.startsWith("builtin:");
}

function applyBuiltinTokens(
  state: Map<PiBuiltinExtensionId, boolean>,
  entries: readonly string[],
): void {
  for (const raw of entries) {
    const token = raw.trim();
    if (token.startsWith("-") && BUILTIN_EXT_SET.has(token.slice(1))) {
      state.set(token.slice(1) as PiBuiltinExtensionId, false);
    } else if (token.startsWith("+") && BUILTIN_EXT_SET.has(token.slice(1))) {
      state.set(token.slice(1) as PiBuiltinExtensionId, true);
    } else if (BUILTIN_EXT_SET.has(token)) {
      state.set(token as PiBuiltinExtensionId, true);
    }
  }
}

export async function setPiBuiltinExtensionEnabled(input: {
  agentDir: string;
  id: PiBuiltinExtensionId;
  enabled: boolean;
  scope?: PiConfigScope | undefined;
  workspacePath?: string | undefined;
}): Promise<void> {
  if (!BUILTIN_EXT_SET.has(input.id)) throw new Error(`Unknown builtin extension: "${input.id}"`);
  const scope = input.scope ?? "global";
  await mutatePiSettingsJson(input.agentDir, scope, input.workspacePath, (data) => {
    const filtered = stringArray(data, "extensions").filter((e) => {
      const t = e.trim();
      return t !== input.id && t !== `+${input.id}` && t !== `-${input.id}`;
    });
    if (!input.enabled) filtered.push(`-${input.id}`);
    else if (scope === "project") filtered.push(`+${input.id}`);
    if (filtered.length === 0) deleteNestedValue(data, "extensions");
    else data["extensions"] = filtered;
    return { write: true, result: undefined };
  });
}

export async function setPiCustomExtensions(input: {
  agentDir: string;
  paths: readonly string[];
  scope?: PiConfigScope | undefined;
  workspacePath?: string | undefined;
}): Promise<void> {
  const cleaned = [
    ...new Set(
      input.paths
        .map((p) => p.trim())
        .filter((p) => p && !isBuiltinToken(p) && !hasControlChars(p)),
    ),
  ];
  await mutatePiSettingsJson(
    input.agentDir,
    input.scope ?? "global",
    input.workspacePath,
    (data) => {
      const builtins = stringArray(data, "extensions").filter(isBuiltinToken);
      const merged = [...builtins, ...cleaned];
      if (merged.length === 0) deleteNestedValue(data, "extensions");
      else data["extensions"] = merged;
      return { write: true, result: undefined };
    },
  );
}

function classifyPackageKind(source: string): "npm" | "git" | "local" {
  const t = source.trim();
  if (t.startsWith("npm:")) return "npm";
  if (/^(?:git:|https?:\/\/|ssh:\/\/|git@)/.test(t)) return "git";
  return "local";
}

function extractPackages(obj: Record<string, unknown>, scope: PiConfigScope): PiPackageItem[] {
  const raw = obj["packages"];
  if (!Array.isArray(raw)) return [];
  const items: PiPackageItem[] = [];
  for (const entry of raw) {
    const source =
      typeof entry === "string"
        ? entry.trim()
        : isPlainRecord(entry) && typeof entry["source"] === "string"
          ? entry["source"].trim()
          : "";
    if (source) items.push({ source, scope, kind: classifyPackageKind(source) });
  }
  return items;
}

export async function listPiPackages(
  agentDir: string,
  workspacePath?: string | null,
): Promise<PiPackageItem[]> {
  const [{ data: globalObj }, projectRes] = await Promise.all([
    readPiJsonObject(resolvePiSettingsFilePath(agentDir, "global"), false),
    workspacePath?.trim()
      ? readPiJsonObject(resolvePiSettingsFilePath(agentDir, "project", workspacePath), false)
      : Promise.resolve(null),
  ]);
  return [
    ...extractPackages(globalObj, "global"),
    ...(projectRes ? extractPackages(projectRes.data, "project") : []),
  ];
}

/** 执行 `pi install / remove / update`（严格参数校验、零 `shell: true`、受管进程树回收）。 */
export async function runPiPackageAction(input: {
  launch: PiLaunch;
  agentDir: string;
  action: PiPackageAction;
  source?: string | null | undefined;
  scope: PiConfigScope;
  workspacePath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<PiPackageActionResult> {
  if (input.scope === "project" && !input.workspacePath?.trim()) {
    throw new Error("workspacePath is required for project-scoped package command");
  }
  const pkgArgs = buildSafePiPackageArgs(input.action, input.source, input.scope);
  const fullArgs = [...input.launch.prefixArgs, ...pkgArgs];
  const cwd =
    input.scope === "project" ? input.workspacePath! : input.workspacePath?.trim() || os.tmpdir();
  const env: NodeJS.ProcessEnv = {
    ...(input.env ?? process.env),
    ...input.launch.env,
    PI_CODING_AGENT_DIR: input.agentDir,
  };

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(input.launch.command, fullArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const startedAtMs = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const procHandle: DisposablePiProcess = {
      closeAndWait: async (timeoutMs = 2_000) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await terminateProcessTreeAndWait(child, {
          ownedProcessStartedAtMs: startedAtMs,
          forceAfterMs: 300,
          waitAfterForceMs: Math.max(500, timeoutMs),
          windowsCleanupDeadlineAtMs: Date.now() + Math.max(1_500, timeoutMs),
          log: logger,
        });
      },
    };
    registerActivePiProcess(procHandle);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregisterActivePiProcess(procHandle);
      fn();
    };

    const timer = setTimeout(() => {
      void procHandle.closeAndWait(2_000).catch(() => {});
      finish(() => reject(new Error(`pi ${input.action} timed out`)));
    }, 120_000);
    timer.unref?.();

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => finish(() => reject(new Error(formatRedactedPiError(err)))));
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      const merged = `${stdout}\n${stderr}`.trim();
      if (exitCode !== 0) {
        finish(() =>
          reject(
            new Error(`pi ${input.action} failed (${exitCode}): ${formatRedactedPiError(merged)}`),
          ),
        );
        return;
      }
      finish(() => resolve(formatRedactedPiError(merged)));
    });
  });

  const packages = await listPiPackages(input.agentDir, input.workspacePath);
  return { ok: true, output, packages };
}

export async function readPiResourcesSnapshot(
  agentDir: string,
  workspacePath?: string | null,
  platform: NodeJS.Platform = process.platform,
): Promise<PiResourcesSnapshot> {
  const [globalSettings, projectSettings, mcpServers, skills, prompts, keybindings] =
    await Promise.all([
      readPiJsonObject(resolvePiSettingsFilePath(agentDir, "global"), false),
      workspacePath?.trim()
        ? readPiJsonObject(resolvePiSettingsFilePath(agentDir, "project", workspacePath), false)
        : Promise.resolve(null),
      listPiMcpServers(agentDir, workspacePath),
      listPiSkills(agentDir, workspacePath),
      listPiPromptTemplates(agentDir, workspacePath),
      readPiKeybindingsEntries(agentDir, platform),
    ]);

  const packages = [
    ...extractPackages(globalSettings.data, "global"),
    ...(projectSettings ? extractPackages(projectSettings.data, "project") : []),
  ];

  const builtinState = new Map<PiBuiltinExtensionId, boolean>(
    PI_BUILTIN_EXTENSIONS.map((id) => [id, true]),
  );
  const globalExts = stringArray(globalSettings.data, "extensions");
  const projExts = projectSettings ? stringArray(projectSettings.data, "extensions") : [];
  applyBuiltinTokens(builtinState, globalExts);
  applyBuiltinTokens(builtinState, projExts);
  const builtinExtensions: PiBuiltinExtensionState[] = PI_BUILTIN_EXTENSIONS.map((id) => ({
    id,
    enabled: builtinState.get(id) ?? true,
  }));
  const customExtensions = [
    ...new Set(
      [...globalExts, ...projExts].map((e) => e.trim()).filter((e) => e && !isBuiltinToken(e)),
    ),
  ];

  const rawSkillCmds =
    projectSettings?.data["enableSkillCommands"] ?? globalSettings.data["enableSkillCommands"];
  const enableSkillCommands = typeof rawSkillCmds === "boolean" ? rawSkillCmds : true;

  return {
    packages,
    builtinExtensions,
    customExtensions,
    mcpServers,
    skills,
    prompts,
    keybindings,
    enableSkillCommands,
  };
}
