/**
 * Pi 智能重命名设置卡片（放置在「模型与思考」默认模型区域）：
 * 支持指定独立模型、思考强度、自定义提示词以及新会话首轮自动重命名开关。
 */
import { useMemo } from "react";
import type { PiThinkingLevel } from "@zcode/shared/pi-config";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useServices } from "@/hooks/useServices.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { PiSegmented } from "./PiPrimitives.js";
import {
  DEFAULT_PI_SMART_RENAME_PROMPT,
  SMART_RENAME_THINKING_LEVELS,
  resetPiSmartRenamePrompt,
  updatePiSmartRenamePreferences,
  usePiSmartRenamePreferences,
} from "@/pi-conversation/index.js";

const FOLLOW_DEFAULT_MODEL = "__follow_default__";

export function PiSmartRenameSettingsCard() {
  const services = useServices();
  const modelSelectionRead = useModelSelectionServiceView(services.modelSelectionService);
  const prefs = usePiSmartRenamePreferences();

  const view = modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const providers = useMemo(() => view?.providers ?? [], [view]);

  const selectedModelValue =
    prefs.providerId && prefs.modelId
      ? encodeCustomModelValue(prefs.providerId, prefs.modelId)
      : FOLLOW_DEFAULT_MODEL;

  const configuredIsUnavailable = useMemo(() => {
    if (!prefs.providerId || !prefs.modelId || !view) return false;
    const provider = providers.find((p) => p.providerId === prefs.providerId);
    return !provider?.models.some((m) => m.modelId === prefs.modelId);
  }, [prefs.modelId, prefs.providerId, providers, view]);

  const isCustomPrompt = prefs.prompt.trim() !== DEFAULT_PI_SMART_RENAME_PROMPT.trim();

  return (
    <SettingsGroupCard>
      <SettingsRow
        searchId="settings.pi.smartRename.model"
        label="智能重命名模型"
        description="右键菜单触发「智能重命名」时使用的模型，建议选择响应快、成本低的轻量模型。"
        controlLayout="wide"
        control={
          <Select
            value={selectedModelValue}
            onValueChange={(value) => {
              if (value === FOLLOW_DEFAULT_MODEL) {
                updatePiSmartRenamePreferences({ providerId: null, modelId: null });
                return;
              }
              const decoded = decodeCustomModelValue(value);
              if (!decoded?.modelName) return;
              updatePiSmartRenamePreferences({
                providerId: decoded.providerId,
                modelId: decoded.modelName,
              });
            }}
            disabled={modelSelectionRead.state.status === "loading"}
          >
            <SelectTrigger
              size="lg"
              className="w-60 min-w-0 justify-between"
              aria-label="智能重命名模型"
              data-testid="pi-smart-rename-model"
            >
              <SelectValue placeholder="跟随当前默认模型" />
            </SelectTrigger>
            <SelectContent className="max-h-80" position="popper" align="end" sideOffset={4}>
              <SelectItem value={FOLLOW_DEFAULT_MODEL}>跟随当前默认模型</SelectItem>
              {configuredIsUnavailable && prefs.providerId && prefs.modelId ? (
                <SelectItem value={selectedModelValue} disabled>
                  {prefs.providerId} / {prefs.modelId}（当前不可用）
                </SelectItem>
              ) : null}
              {providers.map((provider) => {
                if (provider.models.length === 0) return null;
                const groupLabel = provider.providerName?.trim() || provider.providerId;
                return (
                  <SelectGroup key={provider.providerId}>
                    <SelectLabel>{groupLabel}</SelectLabel>
                    {provider.models.map((model) => (
                      <SelectItem
                        key={`${provider.providerId}:${model.modelId}`}
                        value={encodeCustomModelValue(provider.providerId, model.modelId)}
                      >
                        {groupLabel} · {model.modelId}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                );
              })}
            </SelectContent>
          </Select>
        }
      />

      <SettingsRow
        searchId="settings.pi.smartRename.thinking"
        label="智能重命名思考强度"
        description="默认关闭（off）以最快速度返回标题；复杂长对话可按需调低或调高。"
        controlLayout="wide"
        control={
          <PiSegmented<PiThinkingLevel>
            value={prefs.thinkingLevel}
            onChange={(thinkingLevel) => updatePiSmartRenamePreferences({ thinkingLevel })}
            options={SMART_RENAME_THINKING_LEVELS.map((level) => ({
              value: level,
              label: level,
            }))}
          />
        }
      />

      <SettingsRow
        searchId="settings.pi.smartRename.auto"
        label="新会话首轮完成后自动智能重命名"
        description="开启后，新会话完成首次回复且未手动改名时，自动在后台根据对话内容生成标题。"
        control={
          <Switch
            checked={prefs.autoRenameOnFirstTurn}
            onCheckedChange={(autoRenameOnFirstTurn) =>
              updatePiSmartRenamePreferences({ autoRenameOnFirstTurn })
            }
            aria-label="新会话首轮完成后自动智能重命名"
            data-testid="pi-smart-rename-auto"
          />
        }
      />

      <SettingsRow
        searchId="settings.pi.smartRename.prompt"
        label="智能重命名提示词"
        description="支持使用 {{context}} 指定对话上下文插入位置；未写占位符时会自动附带在末尾。"
        controlLayout="wide"
        control={
          <div className="w-full max-w-md space-y-2">
            <Textarea
              rows={4}
              value={prefs.prompt}
              onChange={(event) => updatePiSmartRenamePreferences({ prompt: event.target.value })}
              placeholder={DEFAULT_PI_SMART_RENAME_PROMPT}
              className="text-xs leading-relaxed"
              data-testid="pi-smart-rename-prompt"
            />
            <div className="flex items-center justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!isCustomPrompt}
                onClick={resetPiSmartRenamePrompt}
              >
                <RotateCcw className="mr-1.5 size-3.5" />
                恢复默认提示词
              </Button>
            </div>
          </div>
        }
      />
    </SettingsGroupCard>
  );
}
