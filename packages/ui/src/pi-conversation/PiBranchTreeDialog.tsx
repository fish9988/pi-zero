import { useCallback, useEffect, useState } from "react";
import type { PiSessionTreeNode, PiSessionTreeSnapshot } from "@zcode/shared/pi-config";
import { GitBranch, GitFork, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PiBranchTreeDialogProps } from "./contract.js";

function formatTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function PiBranchTreeDialog({
  open,
  workspacePath,
  sessionId,
  onClose,
  onForked,
  onRewound,
}: PiBranchTreeDialogProps) {
  const services = useOptionalServices();
  const piService = services?.piConfigService;
  const { locale } = useZCodeIntl();
  const isZh = locale.toLowerCase().startsWith("zh");
  const tr = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);

  const [tree, setTree] = useState<PiSessionTreeSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRewindId, setConfirmRewindId] = useState<string | null>(null);

  const loadTree = useCallback(async () => {
    if (!piService || !sessionId) return;
    setLoading(true);
    try {
      const res = await piService.runSessionAction({
        op: "getTree",
        workspacePath,
        sessionId,
      });
      if (res.op === "getTree") {
        setTree(res.tree);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [piService, sessionId, workspacePath]);

  useEffect(() => {
    if (open) {
      setConfirmRewindId(null);
      void loadTree();
    }
  }, [loadTree, open]);

  const handleFork = async (node: PiSessionTreeNode) => {
    if (!piService || !sessionId) return;
    setBusyId(`fork:${node.id}`);
    try {
      const res = await piService.runSessionAction({
        op: "fork",
        workspacePath,
        sessionId,
        entryId: node.id,
      });
      if (res.op === "fork") {
        toast(tr(`已分叉新会话：${res.result.title}`, `Forked session: ${res.result.title}`));
        onForked?.(res.result.sessionId);
        onClose();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleRewind = async (node: PiSessionTreeNode) => {
    if (!piService || !sessionId) return;
    if (confirmRewindId !== node.id) {
      setConfirmRewindId(node.id);
      return;
    }
    setBusyId(`rewind:${node.id}`);
    try {
      const res = await piService.runSessionAction({
        op: "rewindTo",
        workspacePath,
        sessionId,
        entryId: node.id,
      });
      if (res.op === "rewindTo") {
        toast(
          tr(
            `已安全回退（截断 ${res.result.droppedLines} 条记录）`,
            `Rewound cleanly (dropped ${res.result.droppedLines} entries)`,
          ),
        );
        setConfirmRewindId(null);
        onRewound?.();
        onClose();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="pi-branch-tree-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="size-4" />
            {tr("Pi 会话分支树", "Pi Session Branch Tree")}
          </DialogTitle>
          <DialogDescription>
            {tr(
              "从任意历史节点分叉出独立会话，或安全停止进程后就地回退到指定节点。",
              "Fork a new session from any node, or safely stop Pi and rewind in place.",
            )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-ui-sm text-foreground-subtle">
            <LoaderCircle className="size-4 animate-spin" />
            {tr("正在读取会话分支树…", "Loading session tree…")}
          </div>
        ) : !tree || tree.nodes.length === 0 ? (
          <div className="py-8 text-center text-ui-sm text-foreground-subtle">
            {tr("当前会话尚无分支节点记录。", "No session tree entries yet.")}
          </div>
        ) : (
          <div
            data-testid="pi-branch-tree-list"
            className="max-h-[55vh] divide-y divide-border overflow-y-auto rounded-xl border border-border bg-card"
          >
            {tree.nodes.map((node) => {
              const isConfirming = confirmRewindId === node.id;
              return (
                <div
                  key={node.id}
                  data-testid={`pi-tree-node-${node.id}`}
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-md px-1.5 py-0.5 font-mono text-ui-xs ${
                          node.isActiveBranch
                            ? "bg-success-surface text-success-surface-foreground"
                            : "bg-surface text-foreground-subtle"
                        }`}
                      >
                        {node.role ?? node.type}
                      </span>
                      {node.isLeaf ? (
                        <span className="rounded-md bg-selected px-1.5 py-0.5 text-ui-xs font-medium text-foreground">
                          HEAD
                        </span>
                      ) : null}
                      <span className="font-mono text-ui-xs text-foreground-subtlest">
                        {formatTimestamp(node.timestamp)}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-ui-sm text-foreground">
                      {node.preview || node.label || node.id}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busyId !== null}
                      onClick={() => void handleFork(node)}
                      data-testid={`pi-tree-fork-${node.id}`}
                    >
                      <GitFork className="size-3.5" />
                      {tr("分叉", "Fork")}
                    </Button>
                    {node.canRewind ? (
                      <Button
                        type="button"
                        variant={isConfirming ? "destructive" : "ghost"}
                        size="sm"
                        disabled={busyId !== null}
                        onClick={() => void handleRewind(node)}
                        data-testid={`pi-tree-rewind-${node.id}`}
                      >
                        <RotateCcw className="size-3.5" />
                        {isConfirming ? tr("确认回退", "Confirm") : tr("回退", "Rewind")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
