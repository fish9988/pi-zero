/**
 * Pi 扩展非阻塞 UI 状态注册表（`setStatus` / `setWidget` / `notify`），按 sessionId 隔离。
 * 自动清洗终端 ANSI 转义序列，供桌面端在输入框右上角实时展示 Supermemory 召回、插件开关等状态。
 */
import type {
  PiExtensionNotificationEntry,
  PiExtensionStatusEntry,
  PiExtensionWidgetEntry,
  PiSessionExtensionUiSnapshot,
} from "@zcode/shared/pi-config";
import type { PiExtensionUiRequestEvent } from "#src/pi-runtime/domain/piRpcTypes.js";

// 匹配 ANSI CSI / OSC / 单字节 ESC 序列（构造为 RegExp 避免字面量控制字符 lint 报错）。
const ANSI_ESCAPE_RE = new RegExp(
  "\\u001B(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)|[@-Z\\\\-_])",
  "gu",
);

export function stripAnsiSequences(raw: string): string {
  return raw.replace(ANSI_ESCAPE_RE, "").trim();
}

interface MutableSessionExtensionUi {
  readonly statuses: Map<string, PiExtensionStatusEntry>;
  readonly widgets: Map<string, PiExtensionWidgetEntry>;
  lastNotification?: PiExtensionNotificationEntry | undefined;
}

const sessionUiMap = new Map<string, MutableSessionExtensionUi>();
const listeners = new Set<(sessionId: string) => void>();

function notifyListeners(sessionId: string): void {
  for (const listener of listeners) {
    try {
      listener(sessionId);
    } catch {
      // 单个监听者异常不影响其他监听者
    }
  }
}

function getOrCreateBucket(sessionId: string): MutableSessionExtensionUi {
  let bucket = sessionUiMap.get(sessionId);
  if (!bucket) {
    bucket = { statuses: new Map(), widgets: new Map() };
    sessionUiMap.set(sessionId, bucket);
  }
  return bucket;
}

/** 处理 Pi `extension_ui_request` 中的非阻塞状态推送（setStatus / setWidget / notify）。 */
export function applyPiExtensionUiEvent(
  sessionId: string,
  event: PiExtensionUiRequestEvent,
  nowMs = Date.now(),
): boolean {
  if (event.method === "setStatus") {
    const key = event.statusKey?.trim();
    if (!key) return false;
    const cleaned =
      typeof event.statusText === "string" ? stripAnsiSequences(event.statusText) : "";
    const bucket = getOrCreateBucket(sessionId);
    if (!cleaned) {
      if (!bucket.statuses.has(key)) return false;
      bucket.statuses.delete(key);
    } else {
      const prev = bucket.statuses.get(key);
      if (prev && prev.text === cleaned) return false;
      bucket.statuses.set(key, { key, text: cleaned, updatedAt: nowMs });
    }
    notifyListeners(sessionId);
    return true;
  }

  if (event.method === "setWidget") {
    const key = event.widgetKey?.trim();
    if (!key) return false;
    const rawLines = Array.isArray(event.widgetLines) ? event.widgetLines : [];
    const cleanedLines = rawLines
      .map((line) => (typeof line === "string" ? stripAnsiSequences(line) : ""))
      .filter((line) => line.length > 0);
    const bucket = getOrCreateBucket(sessionId);
    if (cleanedLines.length === 0) {
      if (!bucket.widgets.has(key)) return false;
      bucket.widgets.delete(key);
    } else {
      bucket.widgets.set(key, {
        key,
        lines: cleanedLines,
        placement: event.widgetPlacement,
        updatedAt: nowMs,
      });
    }
    notifyListeners(sessionId);
    return true;
  }

  if (event.method === "notify") {
    const message = typeof event.message === "string" ? stripAnsiSequences(event.message) : "";
    if (!message) return false;
    const bucket = getOrCreateBucket(sessionId);
    bucket.lastNotification = {
      id: event.id || `notify_${nowMs}`,
      message,
      notifyType: event.notifyType ?? "info",
      at: nowMs,
    };
    notifyListeners(sessionId);
    return true;
  }

  return false;
}

export function clearPiSessionExtensionUiState(sessionId: string): void {
  if (!sessionUiMap.has(sessionId)) return;
  sessionUiMap.delete(sessionId);
  notifyListeners(sessionId);
}

export function getPiSessionExtensionUiSnapshot(sessionId: string): PiSessionExtensionUiSnapshot {
  const bucket = sessionUiMap.get(sessionId);
  if (!bucket) {
    return { sessionId, statuses: [], widgets: [] };
  }
  return {
    sessionId,
    statuses: Array.from(bucket.statuses.values()),
    widgets: Array.from(bucket.widgets.values()),
    ...(bucket.lastNotification ? { lastNotification: bucket.lastNotification } : {}),
  };
}

export function subscribePiExtensionUiState(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
