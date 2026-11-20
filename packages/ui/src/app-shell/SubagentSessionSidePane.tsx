import { memo, useMemo } from "react";
import { cn } from "@/components/lib/utils.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  SubagentSessionSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { usePiSubagentPreferences } from "@/settings/pi/piSubagentPreferences.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

export const SubagentSessionSidePane = memo(function SubagentSessionSidePane({
  tab,
  focused,
  compactForRemoteControl = false,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
}: {
  tab: SubagentSessionSidePaneTab;
  focused: boolean;
  compactForRemoteControl?: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
  const { locale } = useZCodeIntl();
  const isZh = locale.toLowerCase().startsWith("zh");
  const subagentPrefs = usePiSubagentPreferences();
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  const densityLabel =
    subagentPrefs.displayDensity === "compact"
      ? isZh
        ? "紧凑"
        : "Compact"
      : subagentPrefs.displayDensity === "detailed"
        ? isZh
          ? "详细"
          : "Detailed"
        : isZh
          ? "标准"
          : "Standard";

  return (
    <div
      data-testid="subagent-session-side-pane"
      data-subagent-density={subagentPrefs.displayDensity}
      data-subagent-show-metrics={String(subagentPrefs.showMetrics)}
      data-subagent-auto-collapse={String(subagentPrefs.autoCollapseOnComplete)}
      className={cn(
        "flex h-full min-h-0 flex-col",
        subagentPrefs.displayDensity === "compact" && "text-ui-sm",
      )}
    >
      {subagentPrefs.showMetrics ? (
        <div
          data-testid="subagent-side-pane-metrics-bar"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-surface/60 px-3 py-1.5 text-ui-xs text-foreground-subtle"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono text-foreground">
              {tab.subagentType}
            </span>
            <span className="truncate">{tab.title}</span>
          </div>
          <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 font-mono text-foreground-subtlest">
            {densityLabel}
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <V4PaneConversationProvider scope={scope}>
          <SessionPane
            paneId={tab.id}
            sessionId={tab.childSessionId}
            openTrigger="subagent"
            rootSessionId={tab.rootSessionId}
            readOnly
            allowWorkspaceFileRewind
            compactForRemoteControl={compactForRemoteControl}
            focused={focused}
            telemetryVisible={focused}
            workspacePath={tab.workspacePath}
            workspaceIdentity={tab.workspaceIdentity}
            remoteSessionId={tab.remoteSessionId}
            onOpenBrowserUrl={onOpenBrowserUrl}
            onOpenCodeViewer={onOpenCodeViewer}
            onOpenFileLink={onOpenFileLink}
            onOpenSubagentSession={onOpenSubagentSession}
            onOpenBackgroundBash={onOpenBackgroundBash}
          />
        </V4PaneConversationProvider>
      </div>
    </div>
  );
});
