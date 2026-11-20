/**
 * Pi 会话共享动作中心（智能重命名执行器、手动改名落盘同步、3 选项删除弹窗状态总线）。
 * 侧栏普通列表、侧栏分组视图与对话顶部 `...` 菜单共用同一套逻辑，零状态重复。
 */
import { useSyncExternalStore } from "react";
import type { PiDeleteSessionMode } from "@zcode/shared/pi-config";
import { toast } from "@/components/ui/toast.js";
import {
  removeTaskFromTaskQueryCaches,
  updateTaskQueryCacheTaskMetaPreservingMembership,
} from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { PiSessionActionServices } from "./contract.js";
import { getPiSmartRenamePreferences } from "./piSmartRenamePreferences.js";

export interface PiDeleteSessionRequest {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string | undefined;
  readonly taskId: string;
  readonly title: string;
  readonly onDeleted?: (() => void) | undefined;
}

const pendingSmartRenameIds = new Set<string>();
const pendingListeners = new Set<() => void>();

let activeDeleteRequest: PiDeleteSessionRequest | null = null;
const deleteListeners = new Set<() => void>();

function notifyPendingListeners(): void {
  for (const listener of pendingListeners) listener();
}

function notifyDeleteListeners(): void {
  for (const listener of deleteListeners) listener();
}

export function isPiSmartRenamePending(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId && pendingSmartRenameIds.has(sessionId));
}

export function usePiSmartRenamePending(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(
    (listener) => {
      pendingListeners.add(listener);
      return () => {
        pendingListeners.delete(listener);
      };
    },
    () => isPiSmartRenamePending(sessionId),
    () => false,
  );
}

export function requestDeletePiSession(request: PiDeleteSessionRequest): void {
  activeDeleteRequest = request;
  notifyDeleteListeners();
}

export function closeDeletePiSessionDialog(): void {
  if (activeDeleteRequest === null) return;
  activeDeleteRequest = null;
  notifyDeleteListeners();
}

export function useActiveDeletePiSessionRequest(): PiDeleteSessionRequest | null {
  return useSyncExternalStore(
    (listener) => {
      deleteListeners.add(listener);
      return () => {
        deleteListeners.delete(listener);
      };
    },
    () => activeDeleteRequest,
    () => null,
  );
}

/** 手动重命名任务时同步将标题持久化到 Pi `.jsonl` 的 `session_info`，避免离线会话重启丢失标题。 */
export function persistManualPiSessionTitle(
  services: Pick<PiSessionActionServices, "piConfigService">,
  params: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly title: string;
  },
): void {
  const trimmed = params.title.trim();
  if (!trimmed || !services.piConfigService) return;
  void services.piConfigService
    .runSessionAction({
      op: "persistTitle",
      workspacePath: params.workspacePath,
      sessionId: params.sessionId,
      title: trimmed,
    })
    .catch(() => {});
}

/** 触发 LLM 智能重命名：按设置中的模型/思考强度/提示词生成标题，并同时落盘 Pi `.jsonl` 与 ZCode 任务索引。 */
export async function runSmartRenamePiSession(params: {
  readonly services: PiSessionActionServices;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string | undefined;
  readonly sessionId: string;
  readonly currentTitle?: string | undefined;
  readonly silent?: boolean | undefined;
  readonly onRenamed?: ((title: string) => void) | undefined;
}): Promise<string | null> {
  const { services, workspacePath, workspaceIdentity, sessionId, silent } = params;
  if (!services.piConfigService) {
    if (!silent) toast("当前环境不支持 Pi 智能重命名", { variant: "warning" });
    return null;
  }
  if (pendingSmartRenameIds.has(sessionId)) return null;

  pendingSmartRenameIds.add(sessionId);
  notifyPendingListeners();
  if (!silent) {
    toast("正在根据会话上下文智能重命名…");
  }

  try {
    const prefs = getPiSmartRenamePreferences();
    let provider = prefs.providerId ?? undefined;
    let model = prefs.modelId ?? undefined;

    if (!provider || !model) {
      try {
        const appSettings = await services.settingService.get();
        if (appSettings.defaultModelSelection) {
          provider = appSettings.defaultModelSelection.providerId;
          model = appSettings.defaultModelSelection.modelId;
        }
      } catch {
        // 回落到 Pi 默认模型
      }
    }

    const res = await services.piConfigService.runSessionAction({
      op: "smartRename",
      workspacePath,
      sessionId,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      thinkingLevel: prefs.thinkingLevel,
      prompt: prefs.prompt,
      currentTitle: params.currentTitle,
    });
    if (res.op !== "smartRename") {
      throw new Error("智能重命名返回结构异常");
    }
    const nextTitle = res.result.title.trim();
    if (!nextTitle) throw new Error("未能生成有效标题");

    try {
      const renamedTask = await services.zcodeTaskService.renameTask({
        taskId: sessionId,
        workspacePath,
        title: nextTitle,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      useZCodeSessionStore
        .getState()
        .upsertOptimisticTaskListItem(workspacePath, renamedTask, workspaceIdentity);
      updateTaskQueryCacheTaskMetaPreservingMembership(renamedTask);
    } catch {
      // 纯磁盘 Pi 会话尚未写入 SQLite 时，Pi .jsonl 与 Hub 已更新
    }

    params.onRenamed?.(nextTitle);
    if (!silent) {
      toast(`已智能重命名为「${nextTitle}」`, { variant: "success" });
    }
    return nextTitle;
  } catch (error) {
    if (!silent) {
      const msg = error instanceof Error ? error.message : String(error);
      toast(`智能重命名失败：${msg}`, { variant: "warning" });
    }
    return null;
  } finally {
    pendingSmartRenameIds.delete(sessionId);
    notifyPendingListeners();
  }
}

/** 执行真删 Pi 会话（回收站或永久删除）并同步清理侧栏索引与当前打开态。 */
export async function executeDeletePiSession(params: {
  readonly services: Pick<PiSessionActionServices, "piConfigService" | "zcodeTaskService">;
  readonly request: PiDeleteSessionRequest;
  readonly mode: PiDeleteSessionMode;
}): Promise<void> {
  const { services, request, mode } = params;
  const { workspacePath, workspaceIdentity, taskId } = request;

  if (services.piConfigService) {
    await services.piConfigService.runSessionAction({
      op: "deleteSession",
      workspacePath,
      sessionId: taskId,
      mode,
    });
  }

  try {
    await services.zcodeTaskService.deleteTask({
      taskId,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
  } catch {
    // 若该会话仅存在于 Pi 磁盘 .jsonl 而不在 ZCode SQLite，则忽略 SQLite 删除异常
  }

  const sessionStore = useZCodeSessionStore.getState();
  sessionStore.removeOptimisticTaskListItem(workspacePath, taskId, workspaceIdentity);
  removeTaskFromTaskQueryCaches({
    taskId,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });

  const currentActive = sessionStore.getWorkspaceState(
    workspacePath,
    workspaceIdentity,
  ).activeTaskId;
  if (currentActive === taskId) {
    sessionStore.setActiveTaskId(workspacePath, null, workspaceIdentity);
  }

  request.onDeleted?.();
}
