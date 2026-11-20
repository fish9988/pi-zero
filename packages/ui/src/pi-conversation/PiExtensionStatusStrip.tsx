/**
 * Pi 扩展状态与小组件贴合条（贴于输入框右上角外沿）：
 * - 承接 Pi RPC `extension_ui_request` 的 `setStatus` / `setWidget` / `notify`；
 * - 展示 Supermemory 召回计数、扩展开关状态等 TUI 独立信息；
 * - 无状态时渲染 null（0 占位高度），超出 3 条或包含多行 widget 时收敛至轻量 Popover。
 */
import { memo, useCallback, useEffect, useState } from "react";
import type { PiSessionExtensionUiSnapshot } from "@zcode/shared/pi-config";
import { Layers, Sparkles } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const MAX_INLINE_STATUS_PILLS = 3;

export const PiExtensionStatusStrip = memo(function PiExtensionStatusStrip({
  sessionId,
}: {
  sessionId: string | null | undefined;
}) {
  const service = useOptionalServices()?.piConfigService ?? null;
  const { locale } = useZCodeIntl();
  const isZh = locale.toLowerCase().startsWith("zh");
  const tr = (zh: string, en: string) => (isZh ? zh : en);
  const [state, setState] = useState<PiSessionExtensionUiSnapshot | null>(null);

  const fetchState = useCallback(async () => {
    if (!service || !sessionId) {
      setState(null);
      return;
    }
    try {
      const res = await service.runSessionAction({ op: "getExtensionUiState", sessionId });
      if (res.op === "getExtensionUiState") {
        setState(res.state);
      }
    } catch {
      // ignore transient RPC errors
    }
  }, [service, sessionId]);

  useEffect(() => {
    void fetchState();
    if (!service || !sessionId) return;
    const sub = service.onDidChange((event) => {
      if (event.area === "extensionUi" && (!event.sessionId || event.sessionId === sessionId)) {
        void fetchState();
      }
    });
    return () => {
      sub.dispose();
    };
  }, [fetchState, service, sessionId]);

  if (!state || (state.statuses.length === 0 && state.widgets.length === 0)) {
    return null;
  }

  const inlineStatuses = state.statuses.slice(0, MAX_INLINE_STATUS_PILLS);
  const overflowStatuses = state.statuses.slice(MAX_INLINE_STATUS_PILLS);
  const hasPopoverDetails = overflowStatuses.length > 0 || state.widgets.length > 0;
  const widgetLineCount = state.widgets.reduce((sum, w) => sum + w.lines.length, 0);

  return (
    <div
      data-testid="pi-extension-status-strip"
      className="mb-1 flex w-full min-w-0 flex-wrap items-center justify-end gap-1.5 px-1"
    >
      {inlineStatuses.map((entry) => (
        <ControlHintTooltip key={entry.key} title={`${entry.key}: ${entry.text}`} side="top">
          <span
            data-testid={`pi-ext-status-${entry.key}`}
            className="inline-flex max-w-[14rem] items-center gap-1 rounded-full border border-border/75 bg-popover/85 px-2 py-0.5 text-[11px] leading-4 text-foreground-subtle shadow-2xs backdrop-blur-xs"
          >
            <Sparkles className="size-2.5 shrink-0 text-primary/80" aria-hidden="true" />
            <span className="truncate">{entry.text}</span>
          </span>
        </ControlHintTooltip>
      ))}
      {hasPopoverDetails ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="pi-ext-status-more"
              className="inline-flex items-center gap-1 rounded-full border border-border/75 bg-popover/85 px-2 py-0.5 text-[11px] leading-4 text-foreground-subtle shadow-2xs transition-colors hover:border-border-hover hover:text-foreground"
            >
              <Layers className="size-2.5 shrink-0" aria-hidden="true" />
              <span>
                {overflowStatuses.length > 0
                  ? `+${overflowStatuses.length}`
                  : tr(`${state.widgets.length} 面板`, `${state.widgets.length} widgets`)}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" className="w-80 space-y-2.5 p-3 text-ui-sm">
            <div className="flex items-center justify-between text-xs font-medium text-foreground-subtle">
              <span>{tr("Pi 扩展状态", "Pi Extension Status")}</span>
              {widgetLineCount > 0 ? (
                <span className="text-[11px] text-foreground-subtlest">
                  {tr(`${state.widgets.length} 个组件`, `${state.widgets.length} widgets`)}
                </span>
              ) : null}
            </div>
            {state.statuses.length > 0 ? (
              <div className="space-y-1">
                {state.statuses.map((entry) => (
                  <div
                    key={entry.key}
                    className="flex items-start justify-between gap-2 rounded-md bg-secondary/45 px-2 py-1 text-xs"
                  >
                    <span className="shrink-0 font-mono text-[11px] text-foreground-subtlest">
                      {entry.key}
                    </span>
                    <span className="min-w-0 break-words text-right text-foreground">
                      {entry.text}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {state.widgets.length > 0 ? (
              <div className="space-y-2 border-t border-border/60 pt-2">
                {state.widgets.map((widget) => (
                  <div key={widget.key} className="space-y-1">
                    <div className="font-mono text-[11px] font-medium text-foreground-subtlest">
                      {widget.key}
                    </div>
                    <div className="max-h-36 overflow-auto rounded-md bg-secondary/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground">
                      {widget.lines.map((line, idx) => (
                        <div key={idx} className="whitespace-pre-wrap break-words">
                          {line}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
});
