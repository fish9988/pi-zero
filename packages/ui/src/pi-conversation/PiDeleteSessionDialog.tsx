/**
 * Pi 会话删除确认弹窗（3 选项：移入回收站 / 永久删除 / 取消）。
 * 挂载在应用根部，由所有菜单入口通过 `requestDeletePiSession` 统一唤起。
 */
import { useState } from "react";
import type { PiDeleteSessionMode } from "@zcode/shared/pi-config";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import {
  closeDeletePiSessionDialog,
  executeDeletePiSession,
  useActiveDeletePiSessionRequest,
} from "./piSessionActions.js";

export function PiDeleteSessionDialog() {
  const services = useServices();
  const request = useActiveDeletePiSessionRequest();
  const [submittingMode, setSubmittingMode] = useState<PiDeleteSessionMode | null>(null);

  const busy = submittingMode !== null;

  const handleConfirm = async (mode: PiDeleteSessionMode) => {
    if (!request || busy) return;
    setSubmittingMode(mode);
    try {
      await executeDeletePiSession({ services, request, mode });
      closeDeletePiSessionDialog();
      toast(
        mode === "trash"
          ? `已将会话「${request.title}」移入系统回收站`
          : `已永久删除会话「${request.title}」`,
        { variant: "success" },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      toast(`删除会话失败：${msg}`, { variant: "warning" });
    } finally {
      setSubmittingMode(null);
    }
  };

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) closeDeletePiSessionDialog();
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="pi-delete-session-dialog">
        <DialogHeader>
          <DialogTitle>删除会话</DialogTitle>
          <DialogDescription>
            确定要删除会话「{request?.title || request?.taskId || ""}」吗？
            移入回收站后可在系统回收站中恢复；永久删除将立即移除磁盘上的 Pi `.jsonl`
            会话文件且无法找回。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex flex-wrap items-center justify-end gap-2 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={closeDeletePiSessionDialog}
            data-testid="pi-delete-session-cancel"
          >
            取消
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => void handleConfirm("trash")}
            data-testid="pi-delete-session-trash"
          >
            <Trash2 className="mr-1.5 size-3.5" />
            {submittingMode === "trash" ? "移入中…" : "移入回收站"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => void handleConfirm("permanent")}
            data-testid="pi-delete-session-permanent"
          >
            <Trash2 className="mr-1.5 size-3.5" />
            {submittingMode === "permanent" ? "删除中…" : "永久删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
