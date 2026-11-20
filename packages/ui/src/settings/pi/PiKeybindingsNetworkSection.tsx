import { useState } from "react";
import type { PiKeybindingEntry } from "@zcode/shared/pi-config";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { ShortcutSettingsSection } from "@/settings/ShortcutSettingsSection.js";
import { WorkspaceFileSearchSection } from "@/settings/WorkspaceFileSearchSection.js";
import type { PiKeybindingsNetworkSectionProps } from "./contract.js";
import {
  PiCard,
  PiRow,
  PiSectionHeader,
  PiSegmented,
  PiServiceUnavailable,
} from "./PiPrimitives.js";
import {
  readBooleanSetting,
  readNumberSetting,
  readStringSetting,
  usePiResourcesSnapshot,
  usePiSettingsSnapshot,
  usePiText,
} from "./usePiConfig.js";

type TransportMode = "auto" | "sse" | "websocket" | "websocket-cached";

export function PiKeybindingsNetworkSection({
  isDesktop,
  workspacePath,
  workspaceIdentity,
}: PiKeybindingsNetworkSectionProps) {
  const { tr } = usePiText();
  const { service, getItem, setSetting, resetSetting } = usePiSettingsSnapshot(workspacePath);
  const { resources, reload: reloadResources } = usePiResourcesSnapshot(workspacePath);
  const [chordDrafts, setChordDrafts] = useState<Record<string, string>>({});

  if (!service) {
    return (
      <div className="space-y-6" data-testid="pi-keybindings-network-section">
        <ShortcutSettingsSection isDesktop={Boolean(isDesktop)} />
        <PiServiceUnavailable />
      </div>
    );
  }

  const transport = readStringSetting(getItem("transport"), "auto") as TransportMode;
  const httpProxy = readStringSetting(getItem("httpProxy"), "");
  const httpIdleTimeoutMs = readNumberSetting(getItem("httpIdleTimeoutMs"), 300000);
  const wsConnectTimeoutMs = readNumberSetting(getItem("websocketConnectTimeoutMs"), 15000);
  const retryEnabled = readBooleanSetting(getItem("retry.enabled"), true);
  const maxRetries = readNumberSetting(getItem("retry.maxRetries"), 3);
  const baseDelayMs = readNumberSetting(getItem("retry.baseDelayMs"), 2000);
  const maxAgentDelayMs = readNumberSetting(getItem("retry.maxAgentDelayMs"), 60000);

  const keybindings: readonly PiKeybindingEntry[] = resources?.keybindings ?? [];

  const handleSaveKeybinding = async (action: string, rawChords: string) => {
    const chords = rawChords
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await service.mutateSettings({
        op: "saveKeybinding",
        action,
        chords: chords.length > 0 ? chords : null,
      });
      await reloadResources();
      toast(tr(`已保存快捷键 ${action}`, `Saved keybinding ${action}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResetKeybinding = async (action: string) => {
    try {
      await service.mutateSettings({ op: "saveKeybinding", action, chords: null });
      setChordDrafts((prev) => {
        const next = { ...prev };
        delete next[action];
        return next;
      });
      await reloadResources();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const commitNumericSetting = (
    input: HTMLInputElement,
    key: string,
    currentValue: number,
    min: number,
    max?: number,
  ) => {
    const raw = input.value.trim();
    const n = Number(raw);
    if (!raw || !Number.isFinite(n)) {
      input.value = String(currentValue);
      return;
    }
    const rounded = Math.round(n);
    const clamped = Math.max(min, max !== undefined ? Math.min(max, rounded) : rounded);
    input.value = String(clamped);
    if (clamped !== currentValue) {
      void setSetting(key, clamped);
    }
  };

  return (
    <div className="space-y-8" data-testid="pi-keybindings-network-section">
      {/* 1. Pi 网络、代理与重试策略 */}
      <div className="space-y-3">
        <PiSectionHeader title={tr("Pi 传输协议与网络代理", "Pi Transport & Network Proxy")} />
        <PiCard testId="pi-network-card">
          <PiRow
            label={tr("流式传输协议 (transport)", "Streaming transport")}
            control={
              <PiSegmented
                value={transport}
                options={[
                  { value: "auto", label: "auto" },
                  { value: "sse", label: "sse" },
                  { value: "websocket", label: "websocket" },
                  { value: "websocket-cached", label: "ws-cached" },
                ]}
                onChange={(next) => void setSetting("transport", next)}
                testId="pi-transport-select"
              />
            }
          />
          <PiRow
            label={tr("Pi HTTP 代理地址 (httpProxy)", "Pi HTTP proxy URL")}
            control={
              <div className="flex items-center gap-2">
                <Input
                  defaultValue={httpProxy}
                  key={`proxy-${httpProxy}`}
                  placeholder="http://127.0.0.1:7890"
                  className="w-60 font-mono"
                  onBlur={(e) => {
                    const next = e.currentTarget.value.trim();
                    if (next !== httpProxy) {
                      void (next ? setSetting("httpProxy", next) : resetSetting("httpProxy"));
                    }
                  }}
                  data-testid="pi-http-proxy-input"
                />
              </div>
            }
          />
          <PiRow
            label={tr("HTTP 空闲超时 (ms)", "HTTP idle timeout (ms)")}
            control={
              <Input
                type="number"
                min={1000}
                defaultValue={httpIdleTimeoutMs}
                key={`idle-${httpIdleTimeoutMs}`}
                className="w-28 text-right font-mono tabular-nums"
                onBlur={(e) =>
                  commitNumericSetting(
                    e.currentTarget,
                    "httpIdleTimeoutMs",
                    httpIdleTimeoutMs,
                    1000,
                  )
                }
              />
            }
          />
          <PiRow
            label={tr("WebSocket 握手超时 (ms)", "WebSocket connect timeout (ms)")}
            control={
              <Input
                type="number"
                min={1000}
                defaultValue={wsConnectTimeoutMs}
                key={`ws-${wsConnectTimeoutMs}`}
                className="w-28 text-right font-mono tabular-nums"
                onBlur={(e) =>
                  commitNumericSetting(
                    e.currentTarget,
                    "websocketConnectTimeoutMs",
                    wsConnectTimeoutMs,
                    1000,
                  )
                }
              />
            }
          />
          <PiRow
            label={tr("请求失败自动重试 (retry.enabled)", "Automatic retry")}
            control={
              <Switch
                checked={retryEnabled}
                onCheckedChange={(checked) => void setSetting("retry.enabled", checked)}
                data-testid="pi-retry-enabled"
              />
            }
          />
          <PiRow
            label={tr("最大重试次数 / 初始退避 / 上限 (ms)", "Max retries / Base / Max delay (ms)")}
            control={
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={0}
                  max={20}
                  defaultValue={maxRetries}
                  key={`retries-${maxRetries}`}
                  className="w-16 text-right font-mono tabular-nums"
                  aria-label="Max retries"
                  onBlur={(e) =>
                    commitNumericSetting(e.currentTarget, "retry.maxRetries", maxRetries, 0, 20)
                  }
                />
                <Input
                  type="number"
                  min={100}
                  defaultValue={baseDelayMs}
                  key={`base-${baseDelayMs}`}
                  className="w-24 text-right font-mono tabular-nums"
                  aria-label="Base delay ms"
                  onBlur={(e) =>
                    commitNumericSetting(e.currentTarget, "retry.baseDelayMs", baseDelayMs, 100)
                  }
                />
                <Input
                  type="number"
                  min={1000}
                  defaultValue={maxAgentDelayMs}
                  key={`maxdelay-${maxAgentDelayMs}`}
                  className="w-24 text-right font-mono tabular-nums"
                  aria-label="Max delay ms"
                  onBlur={(e) =>
                    commitNumericSetting(
                      e.currentTarget,
                      "retry.maxAgentDelayMs",
                      maxAgentDelayMs,
                      1000,
                    )
                  }
                />
              </div>
            }
          />
        </PiCard>
      </div>

      {/* 2. Pi keybindings.json 快捷键覆写 */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("Pi 快捷键 (keybindings.json)", "Pi Keybindings (keybindings.json)")}
          count={keybindings.length}
        />
        <PiCard testId="pi-keybindings-card">
          {keybindings.length === 0 ? (
            <div className="px-4 py-3 text-ui-sm text-foreground-subtle">
              {tr("当前使用 Pi 默认快捷键表。", "Using default Pi keybindings.")}
            </div>
          ) : (
            keybindings.map((kb) => {
              const value = chordDrafts[kb.action] ?? kb.chords.join(", ");
              return (
                <PiRow
                  key={kb.action}
                  label={tr(kb.labelZh, kb.labelEn)}
                  hint={<span className="font-mono text-ui-xs">{kb.action}</span>}
                  control={
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={value}
                        onChange={(e) =>
                          setChordDrafts((prev) => ({
                            ...prev,
                            [kb.action]: e.currentTarget.value,
                          }))
                        }
                        onBlur={() => {
                          if (value !== kb.chords.join(", ")) {
                            void handleSaveKeybinding(kb.action, value);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            void handleSaveKeybinding(kb.action, value);
                          }
                        }}
                        className="w-44 font-mono text-ui-sm"
                        data-testid={`pi-keybinding-${kb.action}`}
                      />
                      {kb.customized ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Reset ${kb.action}`}
                          onClick={() => void handleResetKeybinding(kb.action)}
                        >
                          <RotateCcw className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  }
                />
              );
            })
          )}
        </PiCard>
      </div>

      {/* 3. ZCode 桌面快捷键 */}
      <div className="space-y-3">
        <PiSectionHeader title={tr("桌面工作台快捷键", "Desktop Workbench Shortcuts")} />
        <ShortcutSettingsSection isDesktop={Boolean(isDesktop)} />
      </div>

      {/* 4. 工作区文件搜索排除规则 */}
      <div className="space-y-3">
        <PiSectionHeader title={tr("工作区文件搜索排除规则", "Workspace File Search Excludes")} />
        <WorkspaceFileSearchSection
          workspacePath={workspacePath ?? null}
          workspaceIdentity={workspaceIdentity}
        />
      </div>
    </div>
  );
}
