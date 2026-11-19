import { useCallback, useEffect, useState } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import type { PiLocalUsageSummary } from "@zcode/shared/pi-config";
import { BarChart3, Info, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useDesktopUpdateMenu } from "@/hooks/useDesktopUpdateMenu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PiUsageAboutSectionProps } from "./contract.js";
import {
  PiCard,
  PiRow,
  PiSectionHeader,
  PiSegmented,
  PiServiceUnavailable,
} from "./PiPrimitives.js";
import { usePiConfigService, usePiText } from "./usePiConfig.js";

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  return value < 0.01 ? `<$0.01` : `$${value.toFixed(2)}`;
}

type DayRange = "7" | "30" | "90" | "365";

export function PiUsageAboutSection({
  isDesktop,
  receivePreviewUpdates,
  autoDownloadAndInstallUpdates,
  onReceivePreviewUpdatesChange,
  onAutoDownloadAndInstallUpdatesChange,
}: PiUsageAboutSectionProps) {
  const service = usePiConfigService();
  const { tr } = usePiText();
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const updateMenu = useDesktopUpdateMenu(Boolean(isDesktop));
  const [days, setDays] = useState<DayRange>("30");
  const [usage, setUsage] = useState<PiLocalUsageSummary | null>(null);
  const [loading, setLoading] = useState(false);

  const loadUsage = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    try {
      const next = await service.getLocalUsageSummary({ days: Number(days) });
      setUsage(next);
    } catch {
      setUsage(null);
    } finally {
      setLoading(false);
    }
  }, [days, service]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  return (
    <div className="space-y-8" data-testid="pi-usage-about-section">
      {/* 1. 本地 Pi .jsonl 用量统计 */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("本地 Pi 会话用量统计 (.jsonl)", "Local Pi Session Usage (.jsonl)")}
          actions={
            <>
              <PiSegmented
                value={days}
                options={[
                  { value: "7", label: tr("7 天", "7d") },
                  { value: "30", label: tr("30 天", "30d") },
                  { value: "90", label: tr("90 天", "90d") },
                  { value: "365", label: tr("365 天", "365d") },
                ]}
                onChange={setDays}
                testId="pi-usage-range"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={loading}
                aria-label={tr("刷新统计", "Refresh usage")}
                onClick={() => void loadUsage()}
              >
                <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
              </Button>
            </>
          }
        />

        {!service ? (
          <PiServiceUnavailable />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-4" data-testid="pi-usage-kpi-grid">
              <PiCard className="p-3.5">
                <div className="text-ui-xs text-foreground-subtle">{tr("会话数", "Sessions")}</div>
                <div
                  data-testid="pi-usage-sessions"
                  className="mt-1 font-mono text-ui-xl font-semibold tabular-nums text-foreground"
                >
                  {usage?.totalSessions ?? 0}
                </div>
              </PiCard>
              <PiCard className="p-3.5">
                <div className="text-ui-xs text-foreground-subtle">{tr("请求数", "Requests")}</div>
                <div
                  data-testid="pi-usage-requests"
                  className="mt-1 font-mono text-ui-xl font-semibold tabular-nums text-foreground"
                >
                  {usage?.totalRequests ?? 0}
                </div>
              </PiCard>
              <PiCard className="p-3.5">
                <div className="text-ui-xs text-foreground-subtle">
                  {tr("总 Token", "Total Tokens")}
                </div>
                <div
                  data-testid="pi-usage-tokens"
                  className="mt-1 font-mono text-ui-xl font-semibold tabular-nums text-foreground"
                >
                  {formatCompactNumber(usage?.totalTokens ?? 0)}
                </div>
              </PiCard>
              <PiCard className="p-3.5">
                <div className="text-ui-xs text-foreground-subtle">
                  {tr("估算费用", "Estimated Cost")}
                </div>
                <div
                  data-testid="pi-usage-cost"
                  className="mt-1 font-mono text-ui-xl font-semibold tabular-nums text-foreground"
                >
                  {formatUsd(usage?.totalCostUsd ?? 0)}
                </div>
              </PiCard>
            </div>

            <PiCard testId="pi-usage-by-model">
              <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2 text-ui-xs font-medium text-foreground-subtle">
                <BarChart3 className="size-3.5" />
                {tr("按模型分布", "Usage by Model")}
              </div>
              {!usage || usage.byModel.length === 0 ? (
                <div className="px-4 py-4 text-ui-sm text-foreground-subtle">
                  {loading
                    ? tr("正在扫描本地 Pi 会话…", "Scanning local Pi sessions…")
                    : tr(
                        "所选时间范围内暂无本地会话用量记录。",
                        "No local Pi session usage in this period.",
                      )}
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {usage.byModel.map((row) => (
                    <div
                      key={`${row.provider}/${row.modelId}`}
                      className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-ui-sm font-medium text-foreground">
                          {row.modelId}
                        </div>
                        <div className="text-ui-xs text-foreground-subtle">
                          {row.provider} · {row.requests} {tr("次请求", "requests")}
                        </div>
                      </div>
                      <div className="flex items-center gap-4 font-mono text-ui-sm tabular-nums">
                        <span className="text-foreground-subtle">
                          {formatCompactNumber(row.totalTokens)} tok
                        </span>
                        <span className="font-medium text-foreground">
                          {formatUsd(row.costUsd)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </PiCard>
          </>
        )}
      </div>

      {/* 2. GitHub 自动更新与关于 */}
      <div className="space-y-3">
        <PiSectionHeader title={tr("应用更新与关于", "Updates & About")} />
        <PiCard testId="pi-about-card">
          {isDesktop ? (
            <>
              <PiRow
                label={tr("检查 GitHub 更新", "Check for GitHub updates")}
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!updateMenu.visible || updateMenu.disabled}
                    onClick={updateMenu.checkForUpdates}
                    data-testid="pi-check-updates-btn"
                  >
                    <RefreshCw className="size-3.5" />
                    {updateMenu.visible
                      ? intl.formatMessage({ id: updateMenu.labelId }, updateMenu.labelValues)
                      : tr("检查更新", "Check for updates")}
                  </Button>
                }
              />
              <PiRow
                label={intl.formatMessage({ id: "settings.autoDownloadAndInstallUpdates" })}
                control={
                  <Switch
                    checked={autoDownloadAndInstallUpdates}
                    onCheckedChange={(checked) => {
                      void onAutoDownloadAndInstallUpdatesChange(checked);
                    }}
                  />
                }
              />
              <PiRow
                label={intl.formatMessage({ id: "settings.receivePreviewUpdates" })}
                control={
                  <Switch
                    checked={receivePreviewUpdates}
                    onCheckedChange={(checked) => {
                      void onReceivePreviewUpdatesChange(checked);
                    }}
                  />
                }
              />
              <PiRow
                label={tr("关于 ZCode Pi 工作台", "About ZCode Pi Workbench")}
                hint={tr(
                  "纯本地 Electron 桌面工作台 · 基于原生 @earendil-works/pi-coding-agent",
                  "Pure local Electron desktop workbench powered by native @earendil-works/pi-coding-agent",
                )}
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void platform.executeDesktopCommand(DesktopCommandIds.ShowAbout)}
                    data-testid="pi-show-about-btn"
                  >
                    <Info className="size-3.5" />
                    {tr("版本信息", "About")}
                  </Button>
                }
              />
            </>
          ) : (
            <PiRow
              label={tr("ZCode Pi 工作台", "ZCode Pi Workbench")}
              control={
                <span className="font-mono text-ui-xs text-foreground-subtle">Pi v1.5.2+</span>
              }
            />
          )}
        </PiCard>
      </div>
    </div>
  );
}
