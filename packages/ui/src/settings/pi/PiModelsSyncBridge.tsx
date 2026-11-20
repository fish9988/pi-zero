import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PI_THINKING_LEVELS,
  type PiCustomModelEntry,
  type PiCustomProviderSaveInput,
  type PiCustomThinkingLevelMap,
  type PiThinkingLevel,
} from "@zcode/shared/pi-config";
import { isApiKeyAccess, type ModelConfigObject } from "@zcode/provider";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useProviderSettingsServiceView } from "@/hooks/useProviderSettingsView.js";
import { resolveProviderSettingsFormProviders } from "@/lib/providerSettingsFormProjection.js";
import { PiCard, PiRow, PiSegmented, PiStatusPill } from "./PiPrimitives.js";
import {
  usePiChangeSubscription,
  usePiConfigService,
  usePiSettingsSnapshot,
  usePiText,
} from "./usePiConfig.js";

const LEGACY_ZCODE_PROVIDER_IDS = new Set([
  "zcode",
  "zcode-start",
  "zcode-coding-plan",
  "bigmodel-coding-plan",
  "bigmodel-team-coding-plan",
  "bigmodel-start-plan",
  "zai-coding-plan",
  "zai-team-coding-plan",
  "zai-start-plan",
]);

function isLegacyZCodeProviderId(providerId: string | null | undefined): boolean {
  return Boolean(providerId && LEGACY_ZCODE_PROVIDER_IDS.has(providerId.trim().toLowerCase()));
}

function mapApiTypeToPiApi(apiType: string | null | undefined): string {
  switch (apiType) {
    case "anthropic":
    case "anthropic-messages":
      return "anthropic-messages";
    case "openai-responses":
      return "openai-responses";
    case "google":
    case "gemini":
    case "google-generative-ai":
      return "google-generative-ai";
    default:
      return "openai-completions";
  }
}

function extractThinkingLevelMap(modelConfig: ModelConfigObject): PiCustomThinkingLevelMap | null {
  const values = modelConfig.optionSpecs?.reasoningLevel?.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  let recognized = 0;
  const map: Record<string, string | null> = {};
  // piModelCapability 默认启用 off/minimal/low/medium/high，未显式写入 null 的档位会被静默重新启用。
  // 当模型声明了至少一个可识别思考档位时，把被排除的档位显式写为 null。
  for (const level of PI_THINKING_LEVELS) {
    const matched = values.find((v) => String(v).toLowerCase() === level);
    if (matched !== undefined) {
      map[level] = String(matched);
      recognized += 1;
    } else {
      map[level] = null;
    }
  }
  return recognized > 0 ? (map as PiCustomThinkingLevelMap) : null;
}

export function PiModelsSyncBridge({ workspacePath }: { workspacePath?: string | null }) {
  const piService = usePiConfigService();
  const { providerSettingsService } = useServices();
  const { tr } = usePiText();
  const { snapshot, setSetting } = usePiSettingsSnapshot(workspacePath);
  const providerSettingsRead = useProviderSettingsServiceView(providerSettingsService);
  const providerView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const formProviders = useMemo(
    () => resolveProviderSettingsFormProviders({ view: providerView }),
    [providerView],
  );
  const [piCustomCount, setPiCustomCount] = useState(0);
  const [piCustomModelCount, setPiCustomModelCount] = useState(0);
  const [piCustomIds, setPiCustomIds] = useState<ReadonlySet<string>>(() => new Set());
  const [syncing, setSyncing] = useState(false);

  const loadPiCustomCount = useCallback(async () => {
    if (!piService) return;
    try {
      const auth = await piService.listAuthAndProviders();
      setPiCustomCount(auth.customProviders.length);
      setPiCustomModelCount(
        auth.customProviders.reduce((sum, item) => sum + item.models.length, 0),
      );
      setPiCustomIds(new Set(auth.customProviders.map((item) => item.id)));
    } catch {
      // ignore transient error
    }
  }, [piService]);

  useEffect(() => {
    void loadPiCustomCount();
  }, [loadPiCustomCount]);

  usePiChangeSubscription(piService, ["models", "auth"], () => {
    void loadPiCustomCount();
  });

  const unsyncedDraftProviders = useMemo(
    () =>
      formProviders.filter(
        (provider) =>
          provider.hasPersonalConfig &&
          !piCustomIds.has(provider.providerId) &&
          !isLegacyZCodeProviderId(provider.providerId) &&
          provider.config.access?.type !== "zhipu-account" &&
          Boolean(provider.config.api?.baseUrl?.trim()),
      ),
    [formProviders, piCustomIds],
  );
  const currentThinking = (snapshot?.modelDefaults.thinkingLevel ?? "medium") as PiThinkingLevel;
  const hasLegacyDefaultProvider = isLegacyZCodeProviderId(snapshot?.modelDefaults.provider);
  const handleResetLegacyDefaultModel = useCallback(async () => {
    if (!piService) return;
    try {
      await piService.mutateSettings({
        op: "setModelDefaults",
        model: null,
        thinkingLevel: currentThinking,
        ...(workspacePath ? { workspacePath } : {}),
      });
      toast(
        tr(
          "已清除失效的旧版 ZCode 默认提供商，恢复为自动选择可用 Pi 模型",
          "Cleared legacy ZCode default provider and restored auto selection",
        ),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  }, [currentThinking, piService, tr, workspacePath]);

  const syncOrReloadPiModelsJson = useCallback(async () => {
    if (!piService) return;
    setSyncing(true);
    try {
      let synced = 0;
      for (const provider of unsyncedDraftProviders) {
        const baseUrl = provider.config.api?.baseUrl?.trim() ?? "";
        if (!baseUrl) continue;
        const models: PiCustomModelEntry[] = provider.models
          .filter((m) => m.hasPersonalConfig || m.selectable)
          .map((m) => {
            const thinkingLevelMap = extractThinkingLevelMap(m.config);
            const hasReasoning =
              Boolean(m.config.optionSpecs?.reasoningLevel?.values?.length) ||
              thinkingLevelMap !== null;
            return {
              id: m.modelId,
              name: m.modelId,
              reasoning: hasReasoning,
              images: Boolean(m.config.properties?.inputFormat?.supportsImage),
              contextWindow: m.config.properties?.contextWindow ?? null,
              maxTokens: m.config.optionSpecs?.maxOutputTokens?.max ?? null,
              ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
            };
          });
        const rawKey = isApiKeyAccess(provider.config.access)
          ? (provider.config.access.apiKey?.trim() ?? "")
          : "";
        const input: PiCustomProviderSaveInput = {
          id: provider.providerId,
          baseUrl,
          api: mapApiTypeToPiApi(provider.config.api?.type),
          key: rawKey ? { kind: "literal", value: rawKey } : { kind: "keep" },
          models,
        };
        await piService.mutateAuthOrProvider({ op: "saveCustomProvider", input });
        synced += 1;
      }
      await Promise.all([
        loadPiCustomCount(),
        providerSettingsService.refresh("pi-models-json-reload").catch(() => undefined),
      ]);
      toast(
        synced > 0
          ? tr(
              `已同步 ${synced} 个自定义 Provider 并重新加载 ~/.pi/agent/models.json`,
              `Synced ${synced} providers and reloaded ~/.pi/agent/models.json`,
            )
          : tr("已重新加载 ~/.pi/agent/models.json", "Reloaded ~/.pi/agent/models.json"),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [loadPiCustomCount, piService, providerSettingsService, tr, unsyncedDraftProviders]);

  if (!piService) return null;

  const thinkingOptions = PI_THINKING_LEVELS.map((level) => ({
    value: level,
    label: level,
  }));

  const handleThinkingChange = async (next: PiThinkingLevel) => {
    try {
      // 仅更新 defaultThinkingLevel，避免通过 setModelDefaults(model: null) 误清 defaultProvider/defaultModel。
      await setSetting("defaultThinkingLevel", next);
      toast(tr(`Pi 默认思考档位已更新为 ${next}`, `Pi default thinking level set to ${next}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <PiCard testId="pi-models-sync-card">
      {hasLegacyDefaultProvider ? (
        <PiRow
          label={tr(
            "检测到已失效的旧版 ZCode 默认提供商",
            "Legacy ZCode default provider detected",
          )}
          hint={tr(
            `当前默认指向 ${snapshot?.modelDefaults.provider ?? ""}，Pi Zero 已移除旧版 ZCode 商业订阅通道，建议重置为自动选择。`,
            `Current default points to ${snapshot?.modelDefaults.provider ?? ""}, which is no longer active in Pi Zero.`,
          )}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="pi-reset-legacy-default-provider"
              onClick={() => void handleResetLegacyDefaultModel()}
            >
              {tr("重置为自动", "Reset to Auto")}
            </Button>
          }
        />
      ) : null}
      <PiRow
        label={tr("Pi 默认思考强度 (settings.json)", "Pi Default Thinking Level (settings.json)")}
        hint={
          snapshot?.modelDefaults.modelId
            ? `${snapshot.modelDefaults.provider ?? "default"} / ${snapshot.modelDefaults.modelId}`
            : tr("应用于新启动的 Pi 会话", "Applied to newly started Pi sessions")
        }
        control={
          <PiSegmented
            value={currentThinking}
            options={thinkingOptions}
            onChange={(next) => void handleThinkingChange(next)}
            testId="pi-default-thinking-level"
          />
        }
      />
      <PiRow
        label={tr(
          "Pi 自定义模型源 (~/.pi/agent/models.json)",
          "Pi Custom Models (~/.pi/agent/models.json)",
        )}
        hint={tr(
          "下方供应商列表直接读取并实时写回 ~/.pi/agent/models.json，与终端 pi 共享全部自定义 API 与模型。",
          "The provider list below directly reads and edits ~/.pi/agent/models.json shared with Pi CLI.",
        )}
        control={
          <div className="flex items-center gap-2">
            <PiStatusPill tone="success" testId="pi-models-synced-count">
              <CheckCircle2 className="size-3.5" />
              {tr(
                `${piCustomCount} 个供应商 · ${piCustomModelCount} 个模型`,
                `${piCustomCount} providers · ${piCustomModelCount} models`,
              )}
            </PiStatusPill>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={syncing}
              onClick={() => void syncOrReloadPiModelsJson()}
              data-testid="pi-models-sync-btn"
            >
              <RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />
              {unsyncedDraftProviders.length > 0
                ? tr("同步并刷新", "Sync & Reload")
                : tr("重新加载", "Reload")}
            </Button>
          </div>
        }
      />
    </PiCard>
  );
}
