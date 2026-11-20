import { memo, useCallback, useMemo } from "react";
import { ChevronDownIcon, EyeIcon, WrenchIcon } from "lucide-react";
import type { ZCodeConfigOption } from "@zcode/shared";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODE_SELECT_ITEM,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useToolbarShortcutBindings } from "@/v4/composer/toolbarShortcuts.js";
import type { V4ComposerToolbarProps } from "@/v4/composer/V4ComposerToolbar.js";

function noop(): void {}

type PiModeId = "build" | "plan";

/** Pi Zero 真实运行模式切换：标准模式（完整工具）与只读模式（--tools read,grep,find,ls）。 */
function V4ComposerModeSwitchImpl({
  draftConfig,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSwitchMode,
}: Pick<
  V4ComposerToolbarProps,
  | "workspacePath"
  | "workspaceIdentity"
  | "provider"
  | "draftConfig"
  | "disabled"
  | "activeConfigPicker"
  | "onConfigPickerOpenChange"
  | "onSwitchMode"
>) {
  const { intl, locale } = useZCodeIntl();
  const isZh = locale.toLowerCase().startsWith("zh");
  const tr = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);
  const modeShortcutLabel = useShortcutCommandLabel("cycleSessionMode");

  const activeMode: PiModeId =
    draftConfig?.planEnabled === true || draftConfig?.mode === "plan" ? "plan" : "build";

  const handleSelectMode = useCallback(
    (next: string) => {
      if (next === "plan") {
        onSwitchMode("plan");
      } else {
        onSwitchMode("plan-off");
        onSwitchMode("build");
      }
    },
    [onSwitchMode],
  );

  const modeEntries = useMemo(
    () => [
      {
        id: "build" as const,
        label: tr("标准模式", "Standard"),
        description: tr(
          "启用完整 Pi 工具（读/写/编辑文件与执行命令）。",
          "Full Pi tools (read, write, edit files and run commands).",
        ),
        Icon: WrenchIcon,
      },
      {
        id: "plan" as const,
        label: tr("只读模式", "Read-only"),
        description: tr(
          "仅启用只读工具（read / grep / find / ls），适合代码审查与出方案。",
          "Read-only tools (read / grep / find / ls) for exploration and planning.",
        ),
        Icon: EyeIcon,
      },
    ],
    [tr],
  );

  const currentEntry = modeEntries.find((entry) => entry.id === activeMode) ?? modeEntries[0]!;

  const modeOption = useMemo<ZCodeConfigOption>(
    () => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: activeMode,
      options: modeEntries.map((entry) => ({ value: entry.id, name: entry.label })),
    }),
    [activeMode, modeEntries],
  );

  const cycle = useCallback(() => {
    handleSelectMode(activeMode === "build" ? "plan" : "build");
  }, [activeMode, handleSelectMode]);

  useToolbarShortcutBindings({
    hasAnyOption: true,
    toolbarDisabled: disabled,
    modelMenuDisabled: true,
    modeOption,
    onCycleSessionMode: cycle,
    onOpenModelMenu: noop,
    onCycleThoughtLevel: noop,
  });

  const TriggerIcon = currentEntry.Icon;

  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu
        open={activeConfigPicker === "mode"}
        onOpenChange={(open) => onConfigPickerOpenChange("mode", open)}
      >
        <ControlHintTooltip
          title={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
          shortcut={modeShortcutLabel}
          open={activeConfigPicker === "mode" ? false : undefined}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid={TID_CHAT_MODE_SELECT_TRIGGER}
              data-composer-collapse-priority="1"
              aria-label={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
              className={cn(
                "group/mode h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
                activeMode === "plan" ? "text-primary" : "text-foreground-subtle",
              )}
            >
              <TriggerIcon className="size-4" />
              <span className="inline group-data-[composer-compact=true]/mode:hidden">
                <RollingToolbarLabel label={currentEntry.label} />
              </span>
              <ChevronDownIcon className="size-3.5 group-data-[composer-compact=true]/mode:hidden" />
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent
          side="top"
          sideOffset={4}
          className="w-68"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!useConfirmDialogStore.getState().pendingRequest && !isCoarseTouchDevice())
              document
                .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
                ?.focus();
          }}
        >
          <DropdownMenuRadioGroup value={activeMode} onValueChange={handleSelectMode}>
            {modeEntries.map((entry) => {
              const ModeIcon = entry.Icon;
              return (
                <DropdownMenuRadioItem
                  key={entry.id}
                  value={entry.id}
                  data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, entry.id)}
                  className="min-h-13 items-start gap-3 py-2"
                >
                  <ModeIcon className="mt-0.5 size-4 shrink-0" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>{entry.label}</span>
                    <span className="text-ui-sm text-foreground-subtle">{entry.description}</span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
export const V4ComposerModeSwitch = memo(V4ComposerModeSwitchImpl);
