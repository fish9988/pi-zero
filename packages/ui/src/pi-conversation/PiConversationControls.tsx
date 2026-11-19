import { Download, GitBranch, MessageSquareQuote } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PiConversationOverlayProps } from "./contract.js";
import { PiBranchTreeDialog } from "./PiBranchTreeDialog.js";
import { PiBtwPopover } from "./PiBtwPopover.js";

export function PiConversationFloatingActions({
  hasSession,
  onOpenBtw,
  onOpenTree,
  onExportHtml,
}: {
  hasSession: boolean;
  onOpenBtw: () => void;
  onOpenTree: () => void;
  onExportHtml: () => void;
}) {
  const { locale } = useZCodeIntl();
  const isZh = locale.toLowerCase().startsWith("zh");
  const tr = (zh: string, en: string) => (isZh ? zh : en);

  return (
    <div
      data-testid="pi-conversation-toolbar"
      className="pointer-events-auto flex items-center gap-1 rounded-lg border border-border bg-popover/90 p-0.5 shadow-sm backdrop-blur-xs"
    >
      <ControlHintTooltip title={tr("/btw 侧边问答", "/btw Side Q&A")} side="bottom">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onOpenBtw}
          aria-label={tr("侧边问答", "Side Q&A")}
          data-testid="pi-btw-btn"
        >
          <MessageSquareQuote className="size-3.5" />
        </Button>
      </ControlHintTooltip>
      {hasSession ? (
        <>
          <ControlHintTooltip
            title={tr("会话分支树 / 分叉 / 回退", "Branch tree / Fork / Rewind")}
            side="bottom"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onOpenTree}
              aria-label={tr("会话分支树", "Session branch tree")}
              data-testid="pi-session-tree-btn"
            >
              <GitBranch className="size-3.5" />
            </Button>
          </ControlHintTooltip>
          <ControlHintTooltip
            title={tr("离线导出 HTML (/export)", "Export HTML (/export)")}
            side="bottom"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onExportHtml}
              aria-label={tr("导出 HTML", "Export HTML")}
              data-testid="pi-export-btn"
            >
              <Download className="size-3.5" />
            </Button>
          </ControlHintTooltip>
        </>
      ) : null}
    </div>
  );
}

export function PiConversationOverlays({
  workspacePath,
  sessionId,
  btwOpen,
  btwInitialQuestion,
  onBtwOpenChange,
  treeOpen,
  onTreeOpenChange,
  onForked,
  onRewound,
}: Omit<PiConversationOverlayProps, "onExportHtml">) {
  return (
    <>
      <PiBtwPopover
        open={btwOpen}
        workspacePath={workspacePath}
        sessionId={sessionId}
        initialQuestion={btwInitialQuestion}
        onClose={() => onBtwOpenChange(false)}
      />
      <PiBranchTreeDialog
        open={treeOpen}
        workspacePath={workspacePath}
        sessionId={sessionId}
        onClose={() => onTreeOpenChange(false)}
        onForked={onForked}
        onRewound={onRewound}
      />
    </>
  );
}
