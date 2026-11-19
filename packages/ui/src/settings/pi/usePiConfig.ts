import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PiConfigChangeEvent,
  PiResourcesSnapshot,
  PiSettingItem,
  PiSettingsSnapshot,
} from "@zcode/shared/pi-config";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PiConfigServicePort } from "./contract.js";

export function usePiConfigService(): PiConfigServicePort | undefined {
  const services = useOptionalServices();
  return services?.piConfigService;
}

export function usePiText() {
  const { locale } = useZCodeIntl();
  const isZh = locale.toLowerCase().startsWith("zh");
  const tr = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);
  return { isZh, tr };
}

export function usePiChangeSubscription(
  service: PiConfigServicePort | undefined,
  areas: readonly PiConfigChangeEvent["area"][],
  onEvent: () => void,
) {
  const areaKey = areas.join(",");
  // 用 ref 持有最新回调，避免内联箭头导致每次渲染都拆建 MessagePort RPC 订阅。
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!service) return;
    const allowed = new Set(areaKey.split(","));
    const disposable = service.onDidChange((event) => {
      if (allowed.has(event.area)) {
        onEventRef.current();
      }
    });
    return () => {
      disposable.dispose();
    };
  }, [areaKey, service]);
}

export function usePiSettingsSnapshot(workspacePath?: string | null) {
  const service = usePiConfigService();
  const [snapshot, setSnapshot] = useState<PiSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    setError(null);
    try {
      const next = await service.getSettingsSnapshot(workspacePath ? { workspacePath } : undefined);
      setSnapshot(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [service, workspacePath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  usePiChangeSubscription(service, ["settings", "models"], () => {
    void reload();
  });

  const setSetting = useCallback(
    async (key: string, value: unknown, scope: "global" | "project" = "global") => {
      if (!service) return;
      await service.mutateSettings({
        op: "set",
        key,
        valueJson: JSON.stringify(value),
        scope,
        ...(scope === "project" && workspacePath ? { workspacePath } : {}),
      });
      await reload();
    },
    [reload, service, workspacePath],
  );

  const resetSetting = useCallback(
    async (key: string, scope: "global" | "project" = "global") => {
      if (!service) return;
      await service.mutateSettings({
        op: "reset",
        key,
        scope,
        ...(scope === "project" && workspacePath ? { workspacePath } : {}),
      });
      await reload();
    },
    [reload, service, workspacePath],
  );

  const getItem = useCallback(
    (key: string): PiSettingItem | undefined => snapshot?.items.find((item) => item.key === key),
    [snapshot],
  );

  return {
    service,
    snapshot,
    loading,
    error,
    reload,
    setSetting,
    resetSetting,
    getItem,
  };
}

export function usePiResourcesSnapshot(workspacePath?: string | null) {
  const service = usePiConfigService();
  const [resources, setResources] = useState<PiResourcesSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    setError(null);
    try {
      const next = await service.getResourcesSnapshot(
        workspacePath ? { workspacePath } : undefined,
      );
      setResources(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [service, workspacePath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  usePiChangeSubscription(service, ["resources", "settings"], () => {
    void reload();
  });

  return { service, resources, loading, error, reload };
}

export function readBooleanSetting(item: PiSettingItem | undefined, fallback: boolean): boolean {
  if (!item || !item.hasValue) return fallback;
  return typeof item.value === "boolean" ? item.value : fallback;
}

export function readNumberSetting(item: PiSettingItem | undefined, fallback: number): number {
  if (!item || !item.hasValue) return fallback;
  return typeof item.value === "number" && Number.isFinite(item.value) ? item.value : fallback;
}

export function readStringSetting(item: PiSettingItem | undefined, fallback: string): string {
  if (!item || !item.hasValue) return fallback;
  return typeof item.value === "string" ? item.value : fallback;
}

export function readStringArraySetting(
  item: PiSettingItem | undefined,
  fallback: readonly string[],
): string[] {
  if (!item || !item.hasValue) return [...fallback];
  return Array.isArray(item.value)
    ? item.value.filter((entry): entry is string => typeof entry === "string")
    : [...fallback];
}
