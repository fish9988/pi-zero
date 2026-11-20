/**
 * Pi 会话模型与思考档位解析及 RPC 同步辅助（含空闲重启重试一次 /model not found/i 逻辑）。
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ModelSelection, SessionLifecycleSnapshot } from "@zcode/shared";
import type {
  ConversationSnapshot,
  ConversationTopicWireCandidate,
  SessionConfigState,
  SessionSummary,
  WireConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { PiModelInfo } from "#src/pi-runtime/contract.js";
import type { HydratedPiSessionResult } from "#src/pi-runtime/domain/piJsonlHydrator.js";
import type { VirtualSubagentSessionPayload } from "#src/pi-runtime/domain/piSubagentProjector.js";
import {
  getSupportedThinkingLevels,
  pickDefaultThinkingLevel,
} from "#src/pi-runtime/domain/piModelCapability.js";
import { createInitialSessionConfig } from "#src/pi-runtime/domain/piSnapshotFactory.js";
import { discoverPi } from "#src/pi-runtime/adapters/piDiscover.js";
import type { PiAttachmentStore } from "#src/pi-runtime/adapters/piAttachmentStore.js";
import type { PiModelCatalog } from "#src/pi-runtime/adapters/piModelCatalog.js";
import { PiRpcClient } from "#src/pi-runtime/adapters/piRpcClient.js";
import { preparePiSessionFileForSpawn } from "#src/pi-runtime/adapters/piSessionIndexScanner.js";

const MODEL_NOT_FOUND_RE = /model not found/i;

export interface PiSessionControllerCallbacks {
  emitConversationFrame(frame: ConversationTopicWireCandidate): void;
  onSessionPublishedOrUpdated(summary: SessionSummary): void;
  onSessionLifecycleChanged(snapshot: SessionLifecycleSnapshot): void;
  onSessionDeleted(sessionId: string): void;
  onVirtualSubagentSessionsUpdated?(payloads: readonly VirtualSubagentSessionPayload[]): void;
}

export type PiExecutionMode = "build" | "plan";

/** 将 ZCode 历史权限模式收敛为 Pi 原生真实支持的两种工具模式：标准（完整工具）与只读（探索/规划）。 */
export function normalizePiExecutionMode(mode: string | undefined): PiExecutionMode {
  return mode === "plan" ? "plan" : "build";
}

export const PI_READ_ONLY_TOOLS_ARG = "read,grep,find,ls";

export interface PiSessionControllerOptions {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string | undefined;
  readonly cwd: string;
  readonly parentSessionId?: string | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly thoughtLevel?: string | undefined;
  readonly mode?: string | undefined;
  readonly catalog: PiModelCatalog;
  readonly attachments?: PiAttachmentStore | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly managedRuntimeDir?: string | undefined;
  readonly hydratedFromDisk?:
    | { readonly filePath: string; readonly hydrated: HydratedPiSessionResult }
    | undefined;
  readonly readOnlyArchive?:
    | { readonly snapshot: ConversationSnapshot; readonly rows: readonly WireConversationRow[] }
    | undefined;
  readonly callbacks: PiSessionControllerCallbacks;
}

export interface ResolvedModelTarget {
  readonly provider: string;
  readonly model: string;
  readonly thought: string;
  readonly thoughtLevels: readonly string[];
  readonly contextWindow?: number | undefined;
}

export async function resolvePiModelTarget(input: {
  catalog: PiModelCatalog;
  provider: string;
  model: string;
  requestedThought: string | undefined;
  fallbackThoughtLevels: readonly string[];
  fallbackThought: string;
}): Promise<ResolvedModelTarget> {
  let models = input.catalog.getSnapshot().models;
  if (models.length === 0) {
    models = (await input.catalog.ensureLoaded()).models;
  }
  const matched = models.find(
    (candidate) => candidate.provider === input.provider && candidate.id === input.model,
  );
  const thoughtLevels = matched
    ? getSupportedThinkingLevels(matched)
    : input.requestedThought
      ? [input.requestedThought]
      : [...input.fallbackThoughtLevels];
  const thought = matched
    ? pickDefaultThinkingLevel(matched, input.requestedThought)
    : input.requestedThought || input.fallbackThought;

  return {
    provider: input.provider,
    model: input.model,
    thought,
    thoughtLevels,
    contextWindow: matched?.contextWindow,
  };
}

export interface SyncModelToClientInput {
  readonly client: PiRpcClient;
  readonly target: ResolvedModelTarget;
  readonly activeClientModelKey: string;
  readonly activeClientThinking: string;
  readonly isRunning: boolean;
  readonly respawnIdleClient: (target: {
    provider: string;
    model: string;
    thought: string;
  }) => Promise<{
    client: PiRpcClient;
    model?: PiModelInfo | undefined;
    modelKey: string;
    thinkingLevel: string;
  }>;
}

export interface SyncModelToClientOutcome {
  readonly client: PiRpcClient;
  readonly model?: PiModelInfo | undefined;
  readonly modelKey: string;
  readonly thinkingLevel: string;
  readonly thoughtLevels: readonly string[];
  readonly contextWindow?: number | undefined;
}

/**
 * 将目标模型与思考档位同步至活跃 Pi RPC 进程：
 * - 若 `set_model` 因进程启动快照陈旧返回 `/model not found/i` 且当前空闲，
 *   保持同一 `sessionFile` 重启空闲进程后重试一次；
 * - 严格按模型能力夹紧 `thinkingLevel`（非推理模型强制 `"off"`）。
 */
export async function syncPiModelAndThoughtToClient(
  input: SyncModelToClientInput,
): Promise<SyncModelToClientOutcome> {
  let activeClient = input.client;
  let currentModelKey = input.activeClientModelKey;
  let currentThinking = input.activeClientThinking;
  let updatedModel: PiModelInfo | null = null;

  const desiredKey = `${input.target.provider}/${input.target.model}`;
  if (input.target.provider && input.target.model && desiredKey !== currentModelKey) {
    try {
      updatedModel = await activeClient.setModel(input.target.provider, input.target.model);
      currentModelKey = desiredKey;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (MODEL_NOT_FOUND_RE.test(msg) && !input.isRunning) {
        const respawned = await input.respawnIdleClient({
          provider: input.target.provider,
          model: input.target.model,
          thought: input.target.thought,
        });
        activeClient = respawned.client;
        currentModelKey = respawned.modelKey;
        currentThinking = respawned.thinkingLevel;
        if (currentModelKey === desiredKey) {
          updatedModel = respawned.model ?? null;
        } else {
          updatedModel = await activeClient.setModel(input.target.provider, input.target.model);
          currentModelKey = desiredKey;
        }
      } else {
        throw error;
      }
    }
  }

  const effectiveThoughtLevels = updatedModel
    ? getSupportedThinkingLevels(updatedModel)
    : input.target.thoughtLevels;
  const effectiveThought = updatedModel
    ? pickDefaultThinkingLevel(updatedModel, input.target.thought)
    : input.target.thought;

  if (effectiveThought && effectiveThought !== currentThinking) {
    await activeClient.setThinkingLevel(effectiveThought);
    currentThinking = effectiveThought;
  }

  return {
    client: activeClient,
    ...(updatedModel ? { model: updatedModel } : {}),
    modelKey: currentModelKey,
    thinkingLevel: currentThinking || effectiveThought,
    thoughtLevels: effectiveThoughtLevels,
    contextWindow: updatedModel?.contextWindow ?? input.target.contextWindow,
  };
}

export interface HydratedPiClientState {
  readonly sessionFile?: string | undefined;
  readonly model?: PiModelInfo | undefined;
  readonly modelKey: string;
  readonly thinkingLevel: string;
  readonly contextWindow?: number | undefined;
  readonly initialConfigPatch?: SessionConfigState | undefined;
}

/** 启动新 Pi 进程后拉取 `get_state` 与 `get_available_models`，回填目录与初始模型配置。 */
export async function hydratePiClientInitialState(
  client: PiRpcClient,
  catalog: PiModelCatalog,
  currentConfig: SessionConfigState,
): Promise<HydratedPiClientState> {
  const [state, modelsResult] = await Promise.all([
    client.getState(),
    client.getAvailableModels().catch(() => ({ models: [] as PiModelInfo[] })),
  ]);
  const models = Array.isArray(modelsResult.models) ? modelsResult.models : [];
  if (models.length > 0) {
    catalog.seedFromLiveSession({
      models,
      defaultModel: state.model ?? models[0],
      defaultThinkingLevel: state.thinkingLevel,
    });
  }
  const modelKey = state.model ? `${state.model.provider}/${state.model.id}` : "";
  const thinkingLevel = state.thinkingLevel || "";
  let initialConfigPatch: SessionConfigState | undefined;
  if (!currentConfig.provider && state.model) {
    const thoughtLevels = getSupportedThinkingLevels(state.model);
    const thought = pickDefaultThinkingLevel(state.model, state.thinkingLevel);
    initialConfigPatch = {
      ...currentConfig,
      provider: state.model.provider,
      model: state.model.id,
      thought,
      thoughtLevels,
      modelSelection: {
        providerId: state.model.provider,
        modelId: state.model.id,
        options: { reasoningLevel: thought },
      },
    };
  }
  return {
    sessionFile: state.sessionFile,
    model: state.model,
    modelKey,
    thinkingLevel,
    contextWindow: state.model?.contextWindow,
    initialConfigPatch,
  };
}

/** 计算单次提交携带的 `modelSelection` 是否需要更新会话配置（含非推理模型档位夹紧）。 */
export function resolveRequestedSelectionSwitch(
  catalog: PiModelCatalog,
  prev: SessionConfigState,
  selection: ModelSelection | undefined,
): ResolvedModelTarget | null {
  if (!selection) return null;
  const matched = catalog
    .getSnapshot()
    .models.find((m) => m.provider === selection.providerId && m.id === selection.modelId);
  const thoughtLevels = matched ? getSupportedThinkingLevels(matched) : prev.thoughtLevels;
  const nextThought = matched
    ? pickDefaultThinkingLevel(matched, selection.options?.reasoningLevel ?? prev.thought)
    : (selection.options?.reasoningLevel ?? prev.thought);
  if (
    prev.provider === selection.providerId &&
    prev.model === selection.modelId &&
    prev.thought === nextThought
  ) {
    return null;
  }
  return {
    provider: selection.providerId,
    model: selection.modelId,
    thought: nextThought,
    thoughtLevels,
    contextWindow: matched?.contextWindow,
  };
}

/** 发现本机/测试 Pi 并以会话当前模型、思考档位、工具模式与 sessionFile 选项拉起 RPC 子进程。 */
export async function spawnConfiguredPiClient(input: {
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  managedRuntimeDir?: string | undefined;
  sessionFile?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  thought?: string | undefined;
  mode?: string | undefined;
  isDisposed: () => boolean;
}): Promise<{ readonly client: PiRpcClient; readonly sessionFile: string | undefined }> {
  const launch = await discoverPi({
    env: input.env,
    platform: input.platform,
    managedRuntimeDir: input.managedRuntimeDir,
  });
  if (input.isDisposed()) throw new Error("Session disposed while discovering Pi");
  if (!launch) throw new Error("Pi CLI (pi) not found on PATH");

  const effectiveCwd = input.cwd && existsSync(input.cwd) ? input.cwd : tmpdir();
  let sessionFile = input.sessionFile;
  if (!sessionFile) {
    try {
      sessionFile = await preparePiSessionFileForSpawn({
        cwd: effectiveCwd,
        sessionId: input.sessionId,
        env: input.env,
      });
    } catch {
      // 磁盘不可写时退回 Pi 默认会话路径，不阻断对话启动。
      sessionFile = undefined;
    }
  }
  if (input.isDisposed()) throw new Error("Session disposed while preparing Pi session file");

  const executionMode = normalizePiExecutionMode(input.mode);
  const extraArgs = executionMode === "plan" ? ["--tools", PI_READ_ONLY_TOOLS_ARG] : undefined;

  const client = await PiRpcClient.spawn({
    launch,
    cwd: effectiveCwd,
    env: input.env,
    ...(sessionFile ? { sessionFile } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thought ? { thinkingLevel: input.thought } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  });
  if (input.isDisposed()) {
    await client.closeAndWait(2_000).catch(() => {});
    throw new Error("Session disposed while starting Pi");
  }
  return { client, sessionFile };
}

export function resolveModelCostFromCatalog(
  catalog: PiModelCatalog,
  model: PiModelInfo | undefined,
  provider?: string,
  modelId?: string,
): PiModelInfo["cost"] {
  if (model?.cost) return model.cost;
  const p = model?.provider ?? provider;
  const id = model?.id ?? modelId;
  return p && id
    ? catalog.getSnapshot().models.find((m) => m.provider === p && m.id === id)?.cost
    : undefined;
}

/** 构造新建会话控制器的初始模型配置与上下文上限（从目录快照与可选请求选择合成）。 */
export function resolveInitialControllerConfig(input: {
  catalog: PiModelCatalog;
  modelSelection?: ModelSelection | undefined;
  thoughtLevel?: string | undefined;
  mode?: string | undefined;
}): {
  readonly config: SessionConfigState;
  readonly contextWindowMax: number | undefined;
  readonly modelCost: PiModelInfo["cost"];
} {
  const snap = input.catalog.getSnapshot();
  const effectiveSelection: ModelSelection | undefined = input.modelSelection
    ? {
        ...input.modelSelection,
        ...(input.thoughtLevel ? { options: { reasoningLevel: input.thoughtLevel } } : {}),
      }
    : undefined;
  const config = createInitialSessionConfig({
    modelSelection: effectiveSelection,
    catalogModels: snap.models,
    defaultModel: snap.defaultModel,
    defaultThinkingLevel: input.thoughtLevel ?? snap.defaultThinkingLevel,
    mode: normalizePiExecutionMode(input.mode),
  });
  const matched = snap.models.find(
    (model) => model.provider === config.provider && model.id === config.model,
  );
  return { config, contextWindowMax: matched?.contextWindow, modelCost: matched?.cost };
}

/** 取消活跃客户端上的待处理扩展交互，并优雅清空队列/中止当前回合。 */
export async function cancelClientInteractionsAndAbort(
  client: PiRpcClient | null,
  cancelledIds: readonly string[],
): Promise<void> {
  if (!client?.alive) return;
  for (const id of cancelledIds) {
    client.sendExtensionUiResponse({ id, cancelled: true });
  }
  await client.clearQueue().catch(() => {});
  await client.abort().catch(() => {});
}

/** 查询当前工作区 Pi 动态注册的斜杠命令（优先复用活跃 client，否则起临时 `--no-session` 探针并在 finally 关闭）。 */
export async function probeDynamicPiCommands(input: {
  liveClient?: PiRpcClient | null | undefined;
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  managedRuntimeDir?: string | undefined;
}) {
  if (input.liveClient?.alive) {
    const res = await input.liveClient.getCommands().catch(() => ({ commands: [] }));
    return res.commands;
  }
  const launch = await discoverPi({
    env: input.env,
    platform: input.platform,
    managedRuntimeDir: input.managedRuntimeDir,
  });
  if (!launch) return [];
  const effectiveCwd = input.cwd && existsSync(input.cwd) ? input.cwd : tmpdir();
  const client = await PiRpcClient.spawn({
    launch,
    cwd: effectiveCwd,
    env: input.env,
    noSession: true,
  });
  try {
    const res = await client.getCommands();
    return res.commands;
  } finally {
    await client.closeAndWait(1_500).catch(() => {});
  }
}
