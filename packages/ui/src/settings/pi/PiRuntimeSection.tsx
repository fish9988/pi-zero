import { useCallback, useEffect, useState } from "react";
import type { PiRuntimeStatus } from "@zcode/shared/pi-config";
import {
  Activity,
  CheckCircle2,
  Cpu,
  Download,
  FolderOpen,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import {
  PiCard,
  PiRow,
  PiSectionHeader,
  PiServiceUnavailable,
  PiStatusPill,
} from "./PiPrimitives.js";
import { usePiChangeSubscription, usePiConfigService, usePiText } from "./usePiConfig.js";

function sourceLabel(source: PiRuntimeStatus["source"], tr: (zh: string, en: string) => string) {
  switch (source) {
    case "managed":
      return tr("独立运行时", "Managed runtime");
    case "path":
      return tr("系统 PATH", "System PATH");
    case "test":
      return tr("测试替身", "Test stub");
    default:
      return tr("未安装", "Not found");
  }
}

export function PiRuntimeSection() {
  const service = usePiConfigService();
  const { tr } = usePiText();
  const [status, setStatus] = useState<PiRuntimeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(
    async (checkHealth = false) => {
      if (!service) return;
      setChecking(true);
      setError(null);
      try {
        const next = await service.getRuntimeStatus({ checkHealth });
        setStatus(next);
        if (checkHealth) {
          toast(
            next.healthy
              ? tr("Pi 运行时健康检查通过", "Pi runtime health check passed")
              : (next.error ?? tr("Pi 运行时不可用", "Pi runtime unavailable")),
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setChecking(false);
      }
    },
    [service, tr],
  );

  useEffect(() => {
    void loadStatus(false);
  }, [loadStatus]);

  usePiChangeSubscription(service, ["runtime"], () => {
    void loadStatus(false);
  });

  const handleInstallOrUpgrade = async () => {
    if (!service) return;
    setInstalling(true);
    setError(null);
    try {
      const result = await service.installOrUpgradeManagedRuntime();
      setStatus(result.status);
      setOutput(result.output.trim());
      if (result.ok) {
        toast(tr("独立 Pi 运行时已就绪", "Managed Pi runtime is ready"));
      } else {
        setError(result.error ?? tr("安装失败", "Install failed"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  if (!service) return <PiServiceUnavailable />;

  const ready = Boolean(status?.found && status.healthy);

  return (
    <div className="space-y-6" data-testid="pi-runtime-section">
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("Pi CLI 运行时状态", "Pi CLI Runtime Status")}
          actions={
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={checking || installing}
                onClick={() => void loadStatus(true)}
                data-testid="pi-runtime-health-check"
              >
                <Activity className="size-3.5" />
                {tr("健康检查", "Health check")}
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={checking || installing}
                onClick={() => void handleInstallOrUpgrade()}
                data-testid="pi-runtime-install-upgrade"
              >
                {installing ? (
                  <RefreshCw className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {status?.source === "managed"
                  ? tr("升级独立运行时", "Upgrade managed runtime")
                  : tr("安装独立运行时", "Install managed runtime")}
              </Button>
            </>
          }
        />

        <PiCard testId="pi-runtime-card">
          <PiRow
            label={
              <span className="flex items-center gap-2 font-mono">
                <Cpu className="size-4 text-foreground-subtle" />
                @earendil-works/pi-coding-agent
              </span>
            }
            control={
              <div className="flex items-center gap-2">
                {status ? (
                  <PiStatusPill
                    tone={ready ? "success" : "destructive"}
                    testId="pi-runtime-status-pill"
                  >
                    {ready ? (
                      <CheckCircle2 className="size-3.5" />
                    ) : (
                      <XCircle className="size-3.5" />
                    )}
                    {ready ? tr("就绪", "Ready") : tr("未就绪", "Unavailable")}
                  </PiStatusPill>
                ) : (
                  <PiStatusPill tone="neutral">{tr("探测中…", "Detecting…")}</PiStatusPill>
                )}
                {status?.version ? (
                  <span
                    data-testid="pi-runtime-version"
                    className="rounded-md bg-surface px-2 py-0.5 font-mono text-ui-xs text-foreground"
                  >
                    v{status.version}
                  </span>
                ) : null}
                {status ? (
                  <PiStatusPill tone="neutral" testId="pi-runtime-source">
                    {sourceLabel(status.source, tr)}
                  </PiStatusPill>
                ) : null}
              </div>
            }
          />
          <PiRow
            label={tr("解析路径", "Resolved path")}
            control={
              <span
                data-testid="pi-runtime-cli-path"
                className="max-w-md truncate font-mono text-ui-sm text-foreground-subtle"
                title={status?.cliPath ?? status?.command ?? ""}
              >
                {status?.cliPath ?? status?.command ?? "—"}
              </span>
            }
          />
          <PiRow
            label={
              <span className="flex items-center gap-1.5">
                <FolderOpen className="size-3.5 text-foreground-subtle" />
                {tr("Pi 配置目录", "Pi agent directory")}
              </span>
            }
            control={
              <span
                data-testid="pi-runtime-agent-dir"
                className="max-w-md truncate font-mono text-ui-sm text-foreground-subtle"
                title={status?.agentDir ?? ""}
              >
                {status?.agentDir ?? "~/.pi/agent"}
              </span>
            }
          />
          <PiRow
            label={tr("独立运行时目录", "Managed runtime directory")}
            control={
              <span
                className="max-w-md truncate font-mono text-ui-sm text-foreground-subtle"
                title={status?.managedRuntimeDir ?? ""}
              >
                {status?.managedRuntimeDir ?? "—"}
              </span>
            }
          />
        </PiCard>
      </div>

      {error || status?.error ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive-surface px-4 py-3 text-ui-sm text-destructive-surface-foreground"
        >
          {error ?? status?.error}
        </div>
      ) : null}

      {output ? (
        <PiCard className="p-3">
          <pre
            data-testid="pi-runtime-output"
            className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-xs text-foreground-subtle"
          >
            {output}
          </pre>
        </PiCard>
      ) : null}
    </div>
  );
}
