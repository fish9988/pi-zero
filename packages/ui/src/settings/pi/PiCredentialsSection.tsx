import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PI_BUILTIN_PROVIDERS,
  type PiAuthAndProvidersSnapshot,
  type PiProviderAuthStatus,
} from "@zcode/shared/pi-config";
import { Check, Copy, KeyRound, Plus, RefreshCw, Search, Terminal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import {
  PiCard,
  PiRow,
  PiSectionHeader,
  PiServiceUnavailable,
  PiStatusPill,
} from "./PiPrimitives.js";
import { usePiChangeSubscription, usePiConfigService, usePiText } from "./usePiConfig.js";

function mergeBuiltinProviders(live: readonly PiProviderAuthStatus[]): PiProviderAuthStatus[] {
  const byId = new Map<string, PiProviderAuthStatus>();
  for (const item of live) byId.set(item.id, item);
  const out: PiProviderAuthStatus[] = PI_BUILTIN_PROVIDERS.map((meta) => {
    const hit = byId.get(meta.id);
    if (!hit) {
      return {
        ...meta,
        activeEnvVar: null,
        authType: null,
        configured: false,
        maskedHint: null,
        accountHint: null,
        modelCount: 0,
      };
    }
    byId.delete(meta.id);
    return hit;
  });
  for (const extra of byId.values()) out.push(extra);
  return out;
}

export function PiCredentialsSection() {
  const service = usePiConfigService();
  const { tr } = usePiText();
  const [snapshot, setSnapshot] = useState<PiAuthAndProvidersSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [keyModal, setKeyModal] = useState<PiProviderAuthStatus | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [envName, setEnvName] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [savingEnv, setSavingEnv] = useState(false);
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);
  const [copiedLogin, setCopiedLogin] = useState(false);

  const reload = useCallback(async () => {
    if (!service) return;
    setLoading(true);
    try {
      const next = await service.listAuthAndProviders();
      setSnapshot(next);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void reload();
  }, [reload]);

  usePiChangeSubscription(service, ["auth", "models"], () => {
    void reload();
  });

  const providers = useMemo(() => mergeBuiltinProviders(snapshot?.auth ?? []), [snapshot?.auth]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return providers;
    return providers.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        item.id.toLowerCase().includes(needle) ||
        item.envVars.some((env) => env.toLowerCase().includes(needle)),
    );
  }, [providers, query]);

  const configured = useMemo(() => filtered.filter((item) => item.configured), [filtered]);
  const unconfigured = useMemo(() => filtered.filter((item) => !item.configured), [filtered]);

  const loginCommandDisplay = snapshot?.loginCommand.displayCommand ?? "pi /login";

  const handleSaveApiKey = async () => {
    if (!service || !keyModal || !apiKeyDraft.trim()) return;
    setSavingKey(true);
    try {
      const next = await service.mutateAuthOrProvider({
        op: "saveApiKey",
        providerId: keyModal.id,
        apiKey: apiKeyDraft.trim(),
      });
      setSnapshot(next);
      setApiKeyDraft("");
      setKeyModal(null);
      toast(tr(`已写入 ${keyModal.name} API Key`, `Saved ${keyModal.name} API Key`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(false);
    }
  };

  const handleRemoveCredential = async (provider: PiProviderAuthStatus) => {
    if (!service) return;
    try {
      const next = await service.mutateAuthOrProvider({
        op: "removeCredential",
        providerId: provider.id,
      });
      setSnapshot(next);
      toast(tr(`已移除 ${provider.name} 凭据`, `Removed ${provider.name} credential`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveEnv = async () => {
    if (!service || !envName.trim() || !envValue.trim()) return;
    setSavingEnv(true);
    try {
      const next = await service.mutateAuthOrProvider({
        op: "saveEnv",
        name: envName.trim(),
        value: envValue.trim(),
      });
      setSnapshot(next);
      setEnvName("");
      setEnvValue("");
      toast(tr("环境变量已写入 ~/.pi/agent/.env", "Saved to ~/.pi/agent/.env"));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEnv(false);
    }
  };

  const handleRemoveEnv = async (name: string) => {
    if (!service) return;
    try {
      const next = await service.mutateAuthOrProvider({ op: "removeEnv", name });
      setSnapshot(next);
      toast(tr(`已移除 ${name}`, `Removed ${name}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyLoginCommand = async () => {
    try {
      await navigator.clipboard.writeText(loginCommandDisplay);
      setCopiedLogin(true);
      toast(tr("已复制终端登录命令", "Copied login command"));
      setTimeout(() => setCopiedLogin(false), 1800);
    } catch {
      toast(tr("复制失败", "Copy failed"));
    }
  };

  if (!service) return <PiServiceUnavailable />;

  const renderProviderRow = (provider: PiProviderAuthStatus) => {
    const statusLabel =
      provider.authType === "oauth"
        ? tr("OAuth 已登录", "OAuth signed in")
        : provider.authType === "api_key"
          ? provider.maskedHint || tr("API Key 已保存", "API Key saved")
          : provider.activeEnvVar
            ? `ENV ${provider.activeEnvVar}`
            : null;

    return (
      <PiRow
        key={provider.id}
        testId={`pi-provider-row-${provider.id}`}
        label={
          <div className="flex items-center gap-2">
            <span>{provider.name}</span>
            <span className="font-mono text-ui-xs text-foreground-subtlest">{provider.id}</span>
          </div>
        }
        hint={
          provider.accountHint ||
          (provider.envVars.length > 0 ? provider.envVars.join(" · ") : undefined)
        }
        control={
          <div className="flex items-center gap-2">
            {statusLabel ? (
              <PiStatusPill tone="success" testId={`pi-provider-status-${provider.id}`}>
                {statusLabel}
              </PiStatusPill>
            ) : null}
            {provider.acceptsApiKey ? (
              <Button
                type="button"
                variant={provider.configured ? "ghost" : "outline"}
                size="sm"
                data-testid={`pi-provider-set-key-${provider.id}`}
                onClick={() => {
                  setApiKeyDraft("");
                  setKeyModal(provider);
                }}
              >
                <KeyRound className="size-3.5" />
                {provider.authType === "api_key"
                  ? tr("更新 Key", "Update Key")
                  : tr("配置 Key", "Set Key")}
              </Button>
            ) : null}
            {provider.supportsOAuth ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`pi-provider-oauth-${provider.id}`}
                onClick={() => setLoginDialogOpen(true)}
              >
                <Terminal className="size-3.5" />
                OAuth
              </Button>
            ) : null}
            {provider.authType !== null ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={tr(`移除 ${provider.name} 凭据`, `Remove ${provider.name} credential`)}
                data-testid={`pi-provider-remove-${provider.id}`}
                onClick={() => void handleRemoveCredential(provider)}
              >
                <Trash2 className="size-3.5 text-destructive" />
              </Button>
            ) : null}
          </div>
        }
      />
    );
  };

  return (
    <div className="space-y-6" data-testid="pi-credentials-section">
      {/* OAuth 终端登录快捷入口 */}
      <PiCard className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-ui-base font-medium text-foreground">
              {tr("终端 OAuth 登录流", "Terminal OAuth Login Flow")}
            </div>
            <div className="mt-0.5 text-ui-sm text-foreground-subtle">
              {tr(
                "凭据以只写方式保存在 ~/.pi/agent/auth.json 与 .env，永不回传明文密钥。",
                "Credentials are write-only in ~/.pi/agent/auth.json & .env; plaintext keys are never returned.",
              )}
            </div>
          </div>
          <Button
            type="button"
            variant="default"
            size="sm"
            data-testid="pi-terminal-login-btn"
            onClick={() => setLoginDialogOpen(true)}
          >
            <Terminal className="size-3.5" />
            {tr("在终端运行 pi /login", "Run pi /login in Terminal")}
          </Button>
        </div>
      </PiCard>

      {/* 内置 Provider 凭据列表 */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("内置 Provider 凭据", "Built-in Provider Credentials")}
          count={`${configured.length}/${providers.length}`}
          actions={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={loading}
              aria-label={tr("刷新凭据状态", "Refresh credentials")}
              onClick={() => void reload()}
            >
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          }
        />

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtlest" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={tr("搜索 Provider 或环境变量…", "Search providers or ENV…")}
            className="pl-9"
            data-testid="pi-credentials-search"
          />
        </div>

        <PiCard testId="pi-credentials-list">
          {configured.length > 0 ? (
            <>
              <div className="bg-surface px-4 py-1.5 text-ui-xs font-medium text-foreground-subtle">
                {tr("已配置", "Configured")} · {configured.length}
              </div>
              {configured.map(renderProviderRow)}
            </>
          ) : null}
          {unconfigured.length > 0 ? (
            <>
              <div className="border-t border-border bg-surface px-4 py-1.5 text-ui-xs font-medium text-foreground-subtle first:border-t-0">
                {tr("可用 Provider", "Available")}
              </div>
              {unconfigured.map(renderProviderRow)}
            </>
          ) : null}
        </PiCard>
      </div>

      {/* .env 环境变量（只写） */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("环境变量 (~/.pi/agent/.env)", "Environment Variables (~/.pi/agent/.env)")}
          count={snapshot?.envVars.length ?? 0}
        />
        <PiCard className="p-4 space-y-3" testId="pi-env-vars-card">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={envName}
              onChange={(e) => setEnvName(e.currentTarget.value)}
              placeholder="OPENAI_API_KEY"
              className="w-52 font-mono"
              data-testid="pi-env-name-input"
            />
            <Input
              type="password"
              value={envValue}
              onChange={(e) => setEnvValue(e.currentTarget.value)}
              placeholder={tr("输入密钥值（只写，不回显）", "Secret value (write-only)")}
              className="min-w-48 flex-1 font-mono"
              data-testid="pi-env-value-input"
            />
            <Button
              type="button"
              size="sm"
              disabled={savingEnv || !envName.trim() || !envValue.trim()}
              onClick={() => void handleSaveEnv()}
              data-testid="pi-env-save-btn"
            >
              <Plus className="size-3.5" />
              {tr("保存", "Save")}
            </Button>
          </div>
          {(snapshot?.envVars ?? []).length > 0 ? (
            <div className="divide-y divide-border rounded-lg border border-border">
              {(snapshot?.envVars ?? []).map((item) => (
                <div
                  key={item.name}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                  data-testid={`pi-env-row-${item.name}`}
                >
                  <span className="font-mono text-ui-sm text-foreground">{item.name}</span>
                  <div className="flex items-center gap-2">
                    <PiStatusPill tone={item.configured ? "success" : "neutral"}>
                      {item.source === "env-file"
                        ? ".env"
                        : item.source === "system"
                          ? tr("系统环境", "System")
                          : tr("未设置", "Missing")}
                    </PiStatusPill>
                    {item.source === "env-file" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${item.name}`}
                        onClick={() => void handleRemoveEnv(item.name)}
                      >
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </PiCard>
      </div>

      {/* 只写 API Key 弹窗 */}
      <Dialog open={keyModal !== null} onOpenChange={(open) => !open && setKeyModal(null)}>
        <DialogContent data-testid="pi-apikey-dialog">
          <DialogHeader>
            <DialogTitle>
              {keyModal ? tr(`配置 ${keyModal.name} API Key`, `${keyModal.name} API Key`) : ""}
            </DialogTitle>
            <DialogDescription>
              {tr(
                "仅写入 ~/.pi/agent/auth.json，保存后不会再以明文展示。",
                "Write-only to ~/.pi/agent/auth.json. Plaintext is never shown again.",
              )}
            </DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.currentTarget.value)}
            placeholder="sk-..."
            className="font-mono"
            data-testid="pi-apikey-input"
            onKeyDown={(e) => {
              if (e.key === "Enter" && apiKeyDraft.trim()) {
                void handleSaveApiKey();
              }
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setKeyModal(null)}>
              {tr("取消", "Cancel")}
            </Button>
            <Button
              type="button"
              disabled={savingKey || !apiKeyDraft.trim()}
              onClick={() => void handleSaveApiKey()}
              data-testid="pi-apikey-save-btn"
            >
              {tr("保存凭据", "Save credential")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* pi /login 终端指令引导弹窗 */}
      <Dialog open={loginDialogOpen} onOpenChange={setLoginDialogOpen}>
        <DialogContent data-testid="pi-terminal-login-dialog">
          <DialogHeader>
            <DialogTitle>{tr("在终端运行 pi /login", "Run pi /login in Terminal")}</DialogTitle>
            <DialogDescription>
              {tr(
                "在内置终端或系统终端运行以下命令完成 OAuth 授权，授权后点击刷新即可自动识别。",
                "Run the command below in your terminal to complete Pi OAuth login, then refresh.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2.5">
            <code className="truncate font-mono text-ui-sm text-foreground">
              {loginCommandDisplay}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleCopyLoginCommand()}
              data-testid="pi-copy-login-cmd-btn"
            >
              {copiedLogin ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copiedLogin ? tr("已复制", "Copied") : tr("复制命令", "Copy")}
            </Button>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void reload();
                setLoginDialogOpen(false);
              }}
            >
              {tr("完成并刷新状态", "Done & Refresh")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
