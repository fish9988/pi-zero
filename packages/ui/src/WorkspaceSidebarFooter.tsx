import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { Locale, UserInfo } from "@zcode/shared";
import { memo, useCallback, useEffect, useState, type ReactNode } from "react";
import { DesktopCommandIds, LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES } from "@zcode/shared";
import { TID_TASK_SETTINGS_BUTTON } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  BarChart3,
  Globe,
  Maximize,
  Palette,
  Settings,
  SlidersHorizontal,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsUsageIntent } from "@/lib/settingsNavigation.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import type { Theme } from "@/useTheme.js";
import type { WorkspaceSidebarFooterUsageSummaryContent } from "@/WorkspaceSidebarFooterUsageSummary.js";

const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;

export const WorkspaceSidebarFooter = memo(function WorkspaceSidebarFooterComponent({
  theme,
  localeMenuValue,
  onLocaleChange,
  onThemeChange,
  onSettingsButtonClick,
  onUsageClick,
  settingsButtonMode = "settings",
  isDesktop = false,
  className,
}: {
  theme: Theme;
  localeMenuValue: Locale | "system";
  onLocaleChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onSettingsButtonClick?: () => void;
  onUsageClick?: () => void;
  onUpgradeClick?: Parameters<
    typeof WorkspaceSidebarFooterUsageSummaryContent
  >[0]["onUpgradeClick"];
  onLogin?: () => void;
  onLogout?: () => void;
  settingsButtonMode?: "settings" | "back";
  user?: UserInfo | null;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId?: string | null;
  isDesktop?: boolean;
  banner?: ReactNode;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const zoomInShortcutLabel = useShortcutCommandLabel("zoomIn");
  const zoomOutShortcutLabel = useShortcutCommandLabel("zoomOut");
  const resetZoomShortcutLabel = useShortcutCommandLabel("resetZoom");
  const workbenchLabel = "Pi Zero";
  const settingsButtonLabel =
    settingsButtonMode === "back"
      ? intl.formatMessage({ id: "workspace.backToWorkspace" })
      : intl.formatMessage({ id: "settings.title" });
  const usageButtonClick = onUsageClick ?? onSettingsButtonClick;
  const [menuOpen, setMenuOpen] = useState(false);
  const [desktopZoomLevel, setDesktopZoomLevel] = useState(0);
  const runDesktopZoomCommand = useCallback(
    (command: (typeof DesktopCommandIds)["ZoomIn" | "ZoomOut" | "ResetZoom"]) => {
      void platform.executeDesktopCommand(command);
    },
    [platform],
  );

  useEffect(() => {
    if (!isDesktop) {
      setDesktopZoomLevel(0);
      return;
    }

    let isCancelled = false;
    void platform.getDesktopZoomLevel?.().then((state) => {
      if (!isCancelled && Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    const dispose = platform.onDesktopZoomLevelChanged?.((state) => {
      if (Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    return () => {
      isCancelled = true;
      dispose?.();
    };
  }, [isDesktop, platform]);

  const canResetDesktopZoom = desktopZoomLevel !== 0;
  const canZoomIn = desktopZoomLevel < DESKTOP_ZOOM_MAX_LEVEL;
  const canZoomOut = desktopZoomLevel > DESKTOP_ZOOM_MIN_LEVEL;

  return (
    <footer className={cn("flex shrink-0 flex-col gap-2 px-4 pt-2 pb-4", className)}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="min-w-0 flex-1 justify-start gap-2 overflow-hidden px-2 text-foreground-subtle hover:text-foreground"
              data-testid="sidebar-workbench-menu-trigger"
              aria-label={workbenchLabel}
            >
              <SlidersHorizontal className="size-4 shrink-0" />
              <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                {workbenchLabel}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-max min-w-48 max-w-[calc(100vw-2rem)]">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Globe className="size-4" />
                {intl.formatMessage({ id: "settings.locale" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={localeMenuValue} onValueChange={onLocaleChange}>
                  <DropdownMenuRadioItem value="system">
                    {intl.formatMessage({ id: "sidebar.settings.systemDefault" })}
                  </DropdownMenuRadioItem>
                  {SUPPORTED_LOCALES.map((itemLocale) => (
                    <DropdownMenuRadioItem key={itemLocale} value={itemLocale} lang={itemLocale}>
                      {LOCALE_NATIVE_NAMES[itemLocale]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Palette className="size-4" />
                {intl.formatMessage({ id: "settings.themeMode" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={theme} onValueChange={onThemeChange}>
                  <DropdownMenuRadioItem value="system">
                    {intl.formatMessage({ id: "sidebar.settings.systemDefault" })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zai-dark">
                    {intl.formatMessage({ id: "sidebar.settings.theme.zai-dark" })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zai-light">
                    {intl.formatMessage({ id: "sidebar.settings.theme.zai-light" })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {isDesktop ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ZoomIn className="size-4" />
                  {intl.formatMessage({ id: "sidebar.settings.interfaceZoom" })}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-50">
                  <DropdownMenuItem
                    disabled={!canZoomIn}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomIn)}
                  >
                    <ZoomIn className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.zoomIn" })}
                    <DropdownMenuShortcut>{zoomInShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canZoomOut}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomOut)}
                  >
                    <ZoomOut className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.zoomOut" })}
                    <DropdownMenuShortcut>{zoomOutShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canResetDesktopZoom}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ResetZoom)}
                  >
                    <Maximize className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.actualSize" })}
                    <DropdownMenuShortcut>{resetZoomShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {usageButtonClick ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    setPendingSettingsUsageIntent();
                    usageButtonClick();
                  }}
                >
                  <BarChart3 className="size-4" />
                  {intl.formatMessage({ id: "sidebar.usage.plan.openStats" })}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex shrink-0 items-center gap-1.5">
          <ControlHintTooltip title={settingsButtonLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              data-testid={TID_TASK_SETTINGS_BUTTON}
              aria-label={settingsButtonLabel}
              disabled={!onSettingsButtonClick}
              onClick={onSettingsButtonClick}
            >
              <Settings className="size-4" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
    </footer>
  );
});
