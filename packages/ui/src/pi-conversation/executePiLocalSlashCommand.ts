import type { PiSessionEcosystemAction, PiSessionEcosystemResult } from "@zcode/shared/pi-config";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { toast } from "@/components/ui/toast.js";
import {
  extractLastAssistantReplyFromRows,
  resolvePiThinkingLevelArg,
  type PiLocalSlashDispatch,
  type PiLocalSlashSettingsSection,
} from "./usePiSlashCommands.js";

export interface PiLocalSlashSessionActionPort {
  runSessionAction: (action: PiSessionEcosystemAction) => Promise<PiSessionEcosystemResult>;
}

export interface PiLocalSlashTaskServicePort {
  renameTask: (params: {
    taskId: string;
    workspacePath: string;
    title: string;
    workspaceIdentity?: string;
  }) => Promise<unknown>;
  deleteTask: (params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<unknown>;
  listTasks: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<ReadonlyArray<{ taskId: string; title?: string | null; updatedAt?: number }>>;
}

export interface ExecutePiLocalSlashParams {
  readonly dispatch: PiLocalSlashDispatch;
  readonly isZh: boolean;
  readonly sessionId: string | null;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly piConfigService?: PiLocalSlashSessionActionPort;
  readonly zcodeTaskService: PiLocalSlashTaskServicePort;
  readonly rows?: readonly ConversationRow[];
  readonly currentModel: { readonly provider: string; readonly model: string };
  readonly availableModels: ReadonlyArray<{
    readonly providerId: string;
    readonly modelId: string;
  }>;
  readonly onOpenBtw: (question?: string) => void;
  readonly onExportHtml: () => Promise<void>;
  readonly onOpenTree: () => void;
  readonly onForkOrClone: (mode: "fork" | "clone") => Promise<void>;
  readonly onOpenSettings: (section: PiLocalSlashSettingsSection) => void;
  readonly onReload: () => Promise<unknown>;
  readonly onStartNewSession: () => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onSessionDeleted: () => void;
  readonly onSelectModel: (providerId: string, modelId: string) => Promise<void>;
  readonly onSelectThought: (thought: string) => Promise<void>;
  readonly onOpenGitReview?: () => void;
  readonly confirmDelete: (payload: {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
    confirmVariant: "destructive";
  }) => Promise<boolean>;
}

function matchModelTarget(
  rawTarget: string,
  availableModels: ReadonlyArray<{ readonly providerId: string; readonly modelId: string }>,
  currentProvider: string,
): { providerId: string; modelId: string } | null {
  const target = rawTarget.trim();
  if (!target) return null;
  const lower = target.toLowerCase();

  const slashIdx = target.indexOf("/");
  if (slashIdx > 0 && slashIdx < target.length - 1) {
    const providerPart = target.slice(0, slashIdx).trim();
    const modelPart = target.slice(slashIdx + 1).trim();
    const exact = availableModels.find(
      (m) =>
        m.providerId.toLowerCase() === providerPart.toLowerCase() &&
        m.modelId.toLowerCase() === modelPart.toLowerCase(),
    );
    if (exact) return exact;
    return { providerId: providerPart, modelId: modelPart };
  }

  const exactModel =
    availableModels.find(
      (m) =>
        m.modelId.toLowerCase() === lower &&
        m.providerId.toLowerCase() === currentProvider.toLowerCase(),
    ) ?? availableModels.find((m) => m.modelId.toLowerCase() === lower);
  if (exactModel) return exactModel;

  const partial = availableModels.find((m) =>
    `${m.providerId}/${m.modelId}`.toLowerCase().includes(lower),
  );
  return partial ?? null;
}

export async function executePiLocalSlashCommand(params: ExecutePiLocalSlashParams): Promise<void> {
  const { dispatch, isZh, sessionId, workspacePath, workspaceIdentity } = params;
  const tr = (zh: string, en: string) => (isZh ? zh : en);

  switch (dispatch.kind) {
    case "btw":
      params.onOpenBtw(dispatch.question || undefined);
      return;
    case "export":
      await params.onExportHtml();
      return;
    case "tree":
      if (!sessionId) {
        toast(
          tr(
            "当前为草稿态，发送首条消息后即可查看分支树",
            "Send a message first to open the session branch tree",
          ),
        );
        return;
      }
      params.onOpenTree();
      return;
    case "fork":
      await params.onForkOrClone("fork");
      return;
    case "clone":
      await params.onForkOrClone("clone");
      return;
    case "settings":
      params.onOpenSettings(dispatch.section ?? "general");
      return;
    case "reload":
      await params.onReload();
      return;
    case "new":
      if (!sessionId) {
        toast(tr("当前已是空白会话", "Already in a new draft session"));
        return;
      }
      params.onStartNewSession();
      return;
    case "git":
      if (params.onOpenGitReview) {
        params.onOpenGitReview();
      } else {
        toast(
          tr("当前工作区不可用 Git 变更面板", "Git review pane is not available in this workspace"),
        );
      }
      return;
    case "copy": {
      const reply = extractLastAssistantReplyFromRows(params.rows);
      if (!reply) {
        toast(tr("当前会话暂无可复制的助手回复", "No assistant reply to copy yet"));
        return;
      }
      try {
        await navigator.clipboard.writeText(reply);
        toast(tr("已复制上一条助手回复", "Copied last assistant reply"));
      } catch {
        toast(tr("复制到剪贴板失败", "Failed to copy to clipboard"));
      }
      return;
    }
    case "name": {
      if (!sessionId) {
        toast(tr("当前为草稿态，发送消息后可重命名会话", "Start a session before renaming it"));
        return;
      }
      if (!dispatch.title) {
        toast(tr("用法：/name <新标题>", "Usage: /name <new title>"));
        return;
      }
      try {
        await params.zcodeTaskService.renameTask({
          taskId: sessionId,
          workspacePath,
          title: dispatch.title,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        });
        toast(tr(`已重命名为「${dispatch.title}」`, `Renamed session to "${dispatch.title}"`));
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    case "model": {
      if (!dispatch.target) {
        params.onOpenSettings("modelProvider");
        return;
      }
      const matched = matchModelTarget(
        dispatch.target,
        params.availableModels,
        params.currentModel.provider,
      );
      if (!matched) {
        toast(
          tr(
            `未找到匹配模型「${dispatch.target}」，请使用 /model provider/model`,
            `No model matching "${dispatch.target}". Try /model provider/model`,
          ),
        );
        return;
      }
      await params.onSelectModel(matched.providerId, matched.modelId);
      return;
    }
    case "thinking": {
      if (!dispatch.level) {
        toast(
          tr(
            "用法：/thinking <off|minimal|low|medium|high|xhigh>",
            "Usage: /thinking <off|minimal|low|medium|high|xhigh>",
          ),
        );
        return;
      }
      const resolved = resolvePiThinkingLevelArg(dispatch.level);
      if (!resolved) {
        toast(
          tr(
            `无效思考档位「${dispatch.level}」，可选：off / minimal / low / medium / high / xhigh`,
            `Invalid thinking level "${dispatch.level}". Choose: off, minimal, low, medium, high, xhigh`,
          ),
        );
        return;
      }
      await params.onSelectThought(resolved);
      toast(tr(`思考强度已切换为 ${resolved}`, `Thinking level set to ${resolved}`));
      return;
    }
    case "session": {
      if (!sessionId) {
        toast(tr("当前为草稿态，尚未生成会话文件", "Draft mode — no active session yet"));
        return;
      }
      const modelLabel = params.currentModel.model
        ? `${params.currentModel.provider ? `${params.currentModel.provider}/` : ""}${params.currentModel.model}`
        : tr("默认模型", "default model");
      if (!params.piConfigService) {
        toast(`${tr("会话", "Session")} ${sessionId} · ${modelLabel}`);
        return;
      }
      try {
        const res = await params.piConfigService.runSessionAction({
          op: "getTree",
          workspacePath,
          sessionId,
        });
        if (res.op === "getTree") {
          const count = res.tree.nodes.length;
          const fileHint = res.tree.sessionFile ? ` · ${res.tree.sessionFile}` : "";
          toast(
            tr(
              `会话 ${sessionId.slice(0, 8)} · ${modelLabel} · ${count} 个节点${fileHint}`,
              `Session ${sessionId.slice(0, 8)} · ${modelLabel} · ${count} entries${fileHint}`,
            ),
          );
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    case "resume": {
      try {
        const tasks = await params.zcodeTaskService.listTasks({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        });
        const sorted = [...tasks].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        const query = dispatch.query.trim().toLowerCase();
        const match = query
          ? sorted.find(
              (t) =>
                t.taskId.toLowerCase().startsWith(query) ||
                (t.title ?? "").toLowerCase().includes(query),
            )
          : sorted.find((t) => t.taskId !== sessionId);
        if (!match) {
          toast(
            query
              ? tr(
                  `未找到匹配「${dispatch.query}」的历史会话`,
                  `No session matching "${dispatch.query}"`,
                )
              : tr(
                  "当前工作区暂无可恢复的其他历史会话",
                  "No other session to resume in this workspace",
                ),
          );
          return;
        }
        params.onOpenSession(match.taskId);
        toast(
          tr(
            `已恢复会话：${match.title?.trim() || match.taskId.slice(0, 8)}`,
            `Resumed session: ${match.title?.trim() || match.taskId.slice(0, 8)}`,
          ),
        );
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    case "delete": {
      if (!sessionId) {
        toast(tr("当前无活动会话可删除", "No active session to delete"));
        return;
      }
      const confirmed = await params.confirmDelete({
        title: tr("删除当前会话？", "Delete current session?"),
        description: tr(
          "将永久删除该 Pi 会话记录，此操作不可撤销。",
          "This permanently deletes the current Pi session and cannot be undone.",
        ),
        confirmLabel: tr("删除", "Delete"),
        cancelLabel: tr("取消", "Cancel"),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      try {
        await params.zcodeTaskService.deleteTask({
          taskId: sessionId,
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        });
        toast(tr("已删除当前会话", "Session deleted"));
        params.onSessionDeleted();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
      return;
    }
  }
}
