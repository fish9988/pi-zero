/**
 * Pi 智能重命名偏好配置（持久化到 localStorage，跨组件实时同步）：
 * - providerId / modelId：指定用于总结会话标题的模型（null = 跟随默认模型）；
 * - thinkingLevel：思考强度（默认 off，兼顾速度与成本）；
 * - prompt：自定义重命名提示词模板（支持 {{context}} 占位符）；
 * - autoRenameOnFirstTurn：新会话首轮对话完成后自动触发一次智能重命名（默认关闭）。
 */
import { useSyncExternalStore } from "react";
import type { PiThinkingLevel } from "@zcode/shared/pi-config";

export const DEFAULT_PI_SMART_RENAME_PROMPT = [
  "请根据以下对话上下文，为该会话生成一个简洁准确的标题。",
  "要求：",
  "1. 使用与用户主要语言一致的表达（中文 4-18 字，英文 3-7 词）；",
  "2. 精准概括核心任务、主题或问题，避免“你好”“帮我看看”等空泛词；",
  "3. 仅输出标题纯文本，不要包含引号、书名号、序号、Markdown 符号或任何解释。",
].join("\n");

export const SMART_RENAME_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface PiSmartRenamePreferences {
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly thinkingLevel: PiThinkingLevel;
  readonly prompt: string;
  readonly autoRenameOnFirstTurn: boolean;
}

const STORAGE_KEY = "pi-zero.smart-rename.preferences.v1";

const DEFAULT_PREFERENCES: PiSmartRenamePreferences = {
  providerId: null,
  modelId: null,
  thinkingLevel: "off",
  prompt: DEFAULT_PI_SMART_RENAME_PROMPT,
  autoRenameOnFirstTurn: false,
};

function isThinkingLevel(value: unknown): value is PiThinkingLevel {
  return (
    typeof value === "string" && SMART_RENAME_THINKING_LEVELS.includes(value as PiThinkingLevel)
  );
}

function readStoredPreferences(): PiSmartRenamePreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<PiSmartRenamePreferences>;
    return {
      providerId:
        typeof parsed.providerId === "string" && parsed.providerId.trim()
          ? parsed.providerId.trim()
          : null,
      modelId:
        typeof parsed.modelId === "string" && parsed.modelId.trim() ? parsed.modelId.trim() : null,
      thinkingLevel: isThinkingLevel(parsed.thinkingLevel)
        ? parsed.thinkingLevel
        : DEFAULT_PREFERENCES.thinkingLevel,
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : DEFAULT_PREFERENCES.prompt,
      autoRenameOnFirstTurn:
        typeof parsed.autoRenameOnFirstTurn === "boolean"
          ? parsed.autoRenameOnFirstTurn
          : DEFAULT_PREFERENCES.autoRenameOnFirstTurn,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

let currentPreferences: PiSmartRenamePreferences = readStoredPreferences();
const listeners = new Set<() => void>();

export function getPiSmartRenamePreferences(): PiSmartRenamePreferences {
  return currentPreferences;
}

export function updatePiSmartRenamePreferences(patch: Partial<PiSmartRenamePreferences>): void {
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

export function resetPiSmartRenamePrompt(): void {
  updatePiSmartRenamePreferences({ prompt: DEFAULT_PI_SMART_RENAME_PROMPT });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePiSmartRenamePreferences(): PiSmartRenamePreferences {
  return useSyncExternalStore(subscribe, getPiSmartRenamePreferences, () => DEFAULT_PREFERENCES);
}
