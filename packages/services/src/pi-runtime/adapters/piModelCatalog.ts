/**
 * Pi 模型目录短生命周期缓存查询器与 IModelSelectionService 增量包装器。
 *
 * 设计要点：
 * - 单次短命 `pi --mode rpc --no-session` 查询 `get_state` + `get_available_models` 后立即 `closeAndWait()`；
 * - 单飞（single-flight）去重，失败安全回落空目录并脱敏记录日志；
 * - `createPiAugmentedModelSelectionService` 将 Pi 模型合入现有 `ModelSelectionView`，
 *   100% 保留用户已配置的个人/第三方 Provider 与模型设置，绝不返回明文凭据。
 */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import type { ModelSelectionView, ModelSelectionViewInput } from "@zcode/provider";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { IModelSelectionService } from "#src/model-provider/providerFacadeServices.js";
import type { PiModelCatalogOptions, PiModelInfo } from "#src/pi-runtime/contract.js";
import {
  mergePiModelsIntoSelectionView,
  type PiModelCatalogSnapshot,
} from "#src/pi-runtime/domain/piModelCapability.js";
import {
  discoverPi,
  formatRedactedPiError,
  resolvePiAgentDir,
} from "#src/pi-runtime/adapters/piDiscover.js";
import { PiRpcClient } from "#src/pi-runtime/adapters/piRpcClient.js";

type ModelCostRates = NonNullable<PiModelInfo["cost"]>;

function readNonNegativeNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function hasPositiveCost(cost: PiModelInfo["cost"]): boolean {
  return Boolean(
    cost && (cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0),
  );
}

/** 从 `<agentDir>/models.json` 读取自定义模型定价表（`provider/id` -> `cost`），不读任何密钥。 */
async function readModelsJsonCostMap(
  env?: NodeJS.ProcessEnv | undefined,
): Promise<Map<string, ModelCostRates>> {
  const map = new Map<string, ModelCostRates>();
  try {
    const filePath = path.join(resolvePiAgentDir(env), "models.json");
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object") return map;
    const providers = (parsed as Record<string, unknown>)["providers"];
    if (!providers || typeof providers !== "object") return map;
    for (const [providerId, rawProvider] of Object.entries(providers as Record<string, unknown>)) {
      if (!rawProvider || typeof rawProvider !== "object") continue;
      const models = (rawProvider as Record<string, unknown>)["models"];
      if (!Array.isArray(models)) continue;
      for (const item of models) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const id = typeof rec["id"] === "string" ? rec["id"].trim() : "";
        const rawCost = rec["cost"];
        if (!id || !rawCost || typeof rawCost !== "object") continue;
        const c = rawCost as Record<string, unknown>;
        const cost: ModelCostRates = {
          input: readNonNegativeNum(c["input"]),
          output: readNonNegativeNum(c["output"]),
          cacheRead: readNonNegativeNum(c["cacheRead"]),
          cacheWrite: readNonNegativeNum(c["cacheWrite"]),
        };
        if (hasPositiveCost(cost)) {
          map.set(`${providerId}/${id}`, cost);
        }
      }
    }
  } catch {
    // models.json 不存在或非 JSON 时静默忽略
  }
  return map;
}

function enrichModelsWithCostMap(
  models: readonly PiModelInfo[],
  costMap: ReadonlyMap<string, ModelCostRates>,
): PiModelInfo[] {
  if (costMap.size === 0) return [...models];
  return models.map((model) => {
    if (hasPositiveCost(model.cost)) return model;
    const fallback = costMap.get(`${model.provider}/${model.id}`);
    return fallback ? { ...model, cost: fallback } : model;
  });
}

const logger = createServiceLogger("pi-model-catalog");
const DEFAULT_CATALOG_TTL_MS = 60_000;
const CATALOG_PROBE_TIMEOUT_MS = 15_000;

function catalogSignature(snapshot: PiModelCatalogSnapshot): string {
  return JSON.stringify({
    available: snapshot.available,
    defaultProvider: snapshot.defaultModel?.provider ?? "",
    defaultModelId: snapshot.defaultModel?.id ?? "",
    defaultThinkingLevel: snapshot.defaultThinkingLevel ?? "",
    models: snapshot.models.map((m) => `${m.provider}/${m.id}:${m.reasoning === true ? "r" : "n"}`),
  });
}

export class PiModelCatalog {
  private readonly options: PiModelCatalogOptions;
  private readonly ttlMs: number;
  private readonly changeEmitter = new Emitter<PiModelCatalogSnapshot>();
  private snapshot: PiModelCatalogSnapshot = Object.freeze({
    revision: 0,
    models: Object.freeze([]),
    available: false,
  });
  private lastLoadedAt = 0;
  private inflight: Promise<PiModelCatalogSnapshot> | null = null;
  private disposed = false;

  readonly onDidChange: Event<PiModelCatalogSnapshot> = this.changeEmitter.event;

  constructor(options: PiModelCatalogOptions = {}) {
    this.options = options;
    this.ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
  }

  getSnapshot(): PiModelCatalogSnapshot {
    return this.snapshot;
  }

  seedFromLiveSession(input: {
    models: readonly PiModelInfo[];
    defaultModel?: PiModelInfo | undefined;
    defaultThinkingLevel?: string | undefined;
  }): void {
    if (this.disposed || input.models.length === 0) return;
    this.lastLoadedAt = Date.now();
    this.updateSnapshot({
      models: input.models,
      defaultModel: input.defaultModel ?? input.models[0],
      defaultThinkingLevel: input.defaultThinkingLevel,
      available: true,
    });
  }

  async ensureLoaded(cwd?: string): Promise<PiModelCatalogSnapshot> {
    if (this.disposed) return this.snapshot;
    const now = Date.now();
    if (this.lastLoadedAt > 0 && now - this.lastLoadedAt < this.ttlMs) {
      return this.snapshot;
    }
    return this.refresh(cwd);
  }

  async refresh(cwd?: string): Promise<PiModelCatalogSnapshot> {
    if (this.disposed) return this.snapshot;
    if (this.inflight) return this.inflight;
    const probe = this.runProbe(cwd).finally(() => {
      if (this.inflight === probe) this.inflight = null;
    });
    this.inflight = probe;
    return probe;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.changeEmitter.dispose();
  }

  private async runProbe(cwd?: string): Promise<PiModelCatalogSnapshot> {
    const launch = await discoverPi({
      env: this.options.env,
      platform: this.options.platform,
      managedRuntimeDir: this.options.managedRuntimeDir,
    });
    if (this.disposed) return this.snapshot;
    this.lastLoadedAt = Date.now();
    if (!launch) {
      this.updateSnapshot({ models: [], available: false });
      return this.snapshot;
    }

    let client: PiRpcClient | null = null;
    try {
      client = await PiRpcClient.spawn({
        launch,
        cwd: cwd?.trim() || this.options.defaultCwd || tmpdir(),
        noSession: true,
        env: this.options.env,
        defaultTimeoutMs: CATALOG_PROBE_TIMEOUT_MS,
      });
      if (this.disposed) return this.snapshot;
      const [state, modelsResult, costMap] = await Promise.all([
        client.getState(),
        client.getAvailableModels(),
        readModelsJsonCostMap(this.options.env),
      ]);
      if (this.disposed) return this.snapshot;
      const rawModels = Array.isArray(modelsResult?.models) ? modelsResult.models : [];
      const models = enrichModelsWithCostMap(rawModels, costMap);
      const rawDefault = state.model ?? models[0];
      const defaultModel =
        rawDefault && !hasPositiveCost(rawDefault.cost)
          ? (models.find((m) => m.provider === rawDefault.provider && m.id === rawDefault.id) ??
            rawDefault)
          : rawDefault;
      this.updateSnapshot({
        models,
        defaultModel,
        defaultThinkingLevel: state.thinkingLevel,
        available: true,
      });
      return this.snapshot;
    } catch (error) {
      logger.warn(undefined, `Pi 模型目录探测失败: ${formatRedactedPiError(error)}`);
      return this.snapshot;
    } finally {
      if (client) {
        await client.closeAndWait(2_000).catch(() => {});
      }
    }
  }

  private updateSnapshot(next: {
    models: readonly PiModelInfo[];
    defaultModel?: PiModelInfo | undefined;
    defaultThinkingLevel?: string | undefined;
    available: boolean;
  }): void {
    const candidate: PiModelCatalogSnapshot = Object.freeze({
      revision: this.snapshot.revision + 1,
      models: Object.freeze([...next.models]),
      ...(next.defaultModel ? { defaultModel: next.defaultModel } : {}),
      ...(next.defaultThinkingLevel ? { defaultThinkingLevel: next.defaultThinkingLevel } : {}),
      available: next.available,
    });
    if (catalogSignature(candidate) === catalogSignature(this.snapshot)) {
      return;
    }
    this.snapshot = candidate;
    if (!this.disposed) {
      this.changeEmitter.fire(this.snapshot);
    }
  }
}

export function createPiAugmentedModelSelectionService(
  base: IModelSelectionService,
  catalog: PiModelCatalog,
): IModelSelectionService & { dispose(): void } {
  let disposed = false;
  const listeners = new Set<(view: ModelSelectionView) => void>();

  const getView = async (input?: ModelSelectionViewInput): Promise<ModelSelectionView> => {
    const [baseView, catalogSnapshot] = await Promise.all([
      base.getView(input),
      catalog.ensureLoaded(),
    ]);
    return mergePiModelsIntoSelectionView(baseView, catalogSnapshot, input);
  };

  const emitMerged = (baseView?: ModelSelectionView): void => {
    if (disposed || listeners.size === 0) return;
    const resolveView = baseView
      ? Promise.resolve(mergePiModelsIntoSelectionView(baseView, catalog.getSnapshot()))
      : getView();
    void resolveView.then(
      (merged) => {
        if (disposed) return;
        for (const listener of listeners) listener(merged);
      },
      (error: unknown) => {
        if (disposed) return;
        logger.warn(
          undefined,
          `Pi ModelSelectionView 合并刷新失败: ${formatRedactedPiError(error)}`,
        );
      },
    );
  };

  const disposables: IDisposable[] = [
    base.onDidChange((view) => emitMerged(view)),
    catalog.onDidChange(() => emitMerged()),
  ];

  return {
    onDidChange: (listener) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    getView,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const disposable of disposables) disposable.dispose();
      disposables.length = 0;
      listeners.clear();
    },
  };
}
