/**
 * Pi Subagent 展示与互动效果偏好（持久化到 localStorage，跨组件实时同步）：
 * - autoOpenSidePane：调用 subagent 时自动在右侧工作台打开独立子代理窗口；
 * - displayDensity：子代理卡片/轨迹信息密度（compact / standard / detailed）；
 * - autoCollapseOnComplete：子代理全部完成后自动收起展开明细；
 * - showMetrics：显示子代理所用模型、轮次与 Token 消耗。
 */
import { useSyncExternalStore } from "react";

export type PiSubagentDisplayDensity = "compact" | "standard" | "detailed";

export interface PiSubagentPreferences {
  readonly autoOpenSidePane: boolean;
  readonly displayDensity: PiSubagentDisplayDensity;
  readonly autoCollapseOnComplete: boolean;
  readonly showMetrics: boolean;
}

const STORAGE_KEY = "pi-zero.subagent.preferences.v1";

const DEFAULT_PREFERENCES: PiSubagentPreferences = {
  autoOpenSidePane: true,
  displayDensity: "standard",
  autoCollapseOnComplete: true,
  showMetrics: true,
};

function readStoredPreferences(): PiSubagentPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<PiSubagentPreferences>;
    const density =
      parsed.displayDensity === "compact" ||
      parsed.displayDensity === "standard" ||
      parsed.displayDensity === "detailed"
        ? parsed.displayDensity
        : DEFAULT_PREFERENCES.displayDensity;
    return {
      autoOpenSidePane:
        typeof parsed.autoOpenSidePane === "boolean"
          ? parsed.autoOpenSidePane
          : DEFAULT_PREFERENCES.autoOpenSidePane,
      displayDensity: density,
      autoCollapseOnComplete:
        typeof parsed.autoCollapseOnComplete === "boolean"
          ? parsed.autoCollapseOnComplete
          : DEFAULT_PREFERENCES.autoCollapseOnComplete,
      showMetrics:
        typeof parsed.showMetrics === "boolean"
          ? parsed.showMetrics
          : DEFAULT_PREFERENCES.showMetrics,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

let currentPreferences: PiSubagentPreferences = readStoredPreferences();
const listeners = new Set<() => void>();

export function getPiSubagentPreferences(): PiSubagentPreferences {
  return currentPreferences;
}

export function updatePiSubagentPreferences(patch: Partial<PiSubagentPreferences>): void {
  currentPreferences = { ...currentPreferences, ...patch };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentPreferences));
    } catch {
      // ignore storage quota errors
    }
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePiSubagentPreferences(): PiSubagentPreferences {
  return useSyncExternalStore(subscribe, getPiSubagentPreferences, () => DEFAULT_PREFERENCES);
}
