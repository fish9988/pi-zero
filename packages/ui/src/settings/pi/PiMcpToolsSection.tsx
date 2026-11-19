import { useMemo, useState } from "react";
import {
  PI_BUILTIN_TOOLS,
  PI_MCP_EXPOSURES,
  type PiBuiltinToolId,
  type PiConfigScope,
  type PiMcpExposure,
  type PiMcpServerItem,
  type PiMcpServerSaveInput,
} from "@zcode/shared/pi-config";
import { Cable, Pencil, Plus, RefreshCw, Trash2, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import type { PiWorkspaceScopedSectionProps } from "./contract.js";
import {
  PiCard,
  PiRow,
  PiScopeSwitch,
  PiSectionHeader,
  PiSegmented,
  PiServiceUnavailable,
  PiStatusPill,
} from "./PiPrimitives.js";
import {
  readBooleanSetting,
  readNumberSetting,
  readStringArraySetting,
  readStringSetting,
  usePiResourcesSnapshot,
  usePiSettingsSnapshot,
  usePiText,
} from "./usePiConfig.js";

const TOOL_LABELS: Record<PiBuiltinToolId, { zh: string; en: string }> = {
  read: { zh: "读取文件与图片", en: "Read files & images" },
  bash: { zh: "执行 Bash 命令", en: "Execute Bash commands" },
  powershell: { zh: "原生 PowerShell 执行", en: "Run PowerShell commands" },
  edit: { zh: "精确差异替换编辑", en: "Exact diff file edits" },
  write: { zh: "创建或覆盖写入文件", en: "Create or overwrite files" },
  grep: { zh: "正则全文搜索", en: "Regex content search" },
  find: { zh: "按文件名匹配查找", en: "Find files by glob" },
  ls: { zh: "列出目录内容", en: "List directory entries" },
  codemode: { zh: "JS 沙箱工具编排", en: "JS sandbox orchestration" },
  tool_search: { zh: "延迟工具按需检索", en: "Deferred tool lookup" },
};

interface McpFormState {
  mode: "add" | "edit";
  previousName?: string;
  scope: PiConfigScope;
  name: string;
  transport: "stdio" | "http";
  exposure: PiMcpExposure;
  enabled: boolean;
  command: string;
  argsText: string;
  cwd: string;
  envText: string;
  url: string;
  headersText: string;
  description: string;
}

function createEmptyMcpForm(scope: PiConfigScope): McpFormState {
  return {
    mode: "add",
    scope,
    name: "",
    transport: "stdio",
    exposure: "codemode",
    enabled: true,
    command: "",
    argsText: "",
    cwd: "",
    envText: "",
    url: "",
    headersText: "",
    description: "",
  };
}

function parseKvLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("=") > 0 ? trimmed.indexOf("=") : trimmed.indexOf(":");
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const val = trimmed.slice(sep + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

export function PiMcpToolsSection({ workspacePath }: PiWorkspaceScopedSectionProps) {
  const { tr } = usePiText();
  const { service, resources, loading, reload } = usePiResourcesSnapshot(workspacePath);
  const { getItem, setSetting, resetSetting } = usePiSettingsSnapshot(workspacePath);
  const [scope, setScope] = useState<PiConfigScope>("global");
  const [mcpForm, setMcpForm] = useState<McpFormState | null>(null);
  const [savingMcp, setSavingMcp] = useState(false);

  const defaultToolsItem = getItem("defaultTools");
  const activeTools = useMemo(() => {
    if (!defaultToolsItem?.hasValue) {
      return new Set<PiBuiltinToolId>(["read", "bash", "edit", "write"]);
    }
    const configured = readStringArraySetting(defaultToolsItem, []);
    return new Set<PiBuiltinToolId>(
      configured.filter((id): id is PiBuiltinToolId =>
        (PI_BUILTIN_TOOLS as readonly string[]).includes(id),
      ),
    );
  }, [defaultToolsItem]);

  if (!service) return <PiServiceUnavailable />;

  const hasWorkspace = Boolean(workspacePath?.trim());
  const visibleServers = (resources?.mcpServers ?? []).filter((srv) =>
    scope === "global" ? srv.scope === "global" : true,
  );
  const codeMode = readStringSetting(getItem("codemode.mode"), "on") as "on" | "only";
  const inlineBudget = readNumberSetting(getItem("codemode.inlineBudget"), 3000);
  const autoResize = readBooleanSetting(getItem("images.autoResize"), true);

  const handleToggleTool = (toolId: PiBuiltinToolId, enabled: boolean) => {
    const next = new Set(activeTools);
    if (enabled) next.add(toolId);
    else next.delete(toolId);
    const ordered = PI_BUILTIN_TOOLS.filter((id) => next.has(id));
    void setSetting("defaultTools", ordered);
  };

  const handleSaveMcp = async () => {
    if (!mcpForm || !mcpForm.name.trim()) return;
    setSavingMcp(true);
    try {
      const env = parseKvLines(mcpForm.envText);
      const headers = parseKvLines(mcpForm.headersText);
      const input: PiMcpServerSaveInput = {
        scope: mcpForm.scope,
        ...(mcpForm.scope === "project" && workspacePath ? { workspacePath } : {}),
        ...(mcpForm.mode === "edit" && mcpForm.previousName
          ? { previousName: mcpForm.previousName }
          : {}),
        name: mcpForm.name.trim(),
        transport: mcpForm.transport,
        exposure: mcpForm.exposure,
        enabled: mcpForm.enabled,
        ...(mcpForm.description.trim() ? { description: mcpForm.description.trim() } : {}),
        ...(mcpForm.transport === "stdio"
          ? {
              command: mcpForm.command.trim(),
              args: mcpForm.argsText
                .split(/\r?\n|\s+/)
                .map((s) => s.trim())
                .filter(Boolean),
              ...(mcpForm.cwd.trim() ? { cwd: mcpForm.cwd.trim() } : {}),
              ...(Object.keys(env).length > 0 ? { env } : {}),
            }
          : {
              url: mcpForm.url.trim(),
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
            }),
      };
      await service.mutateResource({ op: "saveMcpServer", input });
      setMcpForm(null);
      await reload();
      toast(tr(`已保存 MCP 服务器 ${input.name}`, `Saved MCP server ${input.name}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingMcp(false);
    }
  };

  const handleDeleteMcp = async (server: PiMcpServerItem) => {
    try {
      await service.mutateResource({
        op: "deleteMcpServer",
        scope: server.scope,
        name: server.name,
        ...(server.scope === "project" && workspacePath ? { workspacePath } : {}),
      });
      await reload();
      toast(tr(`已移除 ${server.name}`, `Removed ${server.name}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleMcpEnabled = async (server: PiMcpServerItem, enabled: boolean) => {
    try {
      await service.mutateResource({
        op: "setMcpServerEnabled",
        scope: server.scope,
        name: server.name,
        enabled,
        ...(server.scope === "project" && workspacePath ? { workspacePath } : {}),
      });
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const openEditMcp = (server: PiMcpServerItem) => {
    setMcpForm({
      mode: "edit",
      previousName: server.name,
      scope: server.scope,
      name: server.name,
      transport: server.transport,
      exposure: server.exposure,
      enabled: server.enabled,
      command: server.command ?? "",
      argsText: (server.args ?? []).join(" "),
      cwd: server.cwd ?? "",
      envText: "",
      url: server.url ?? "",
      headersText: "",
      description: server.description ?? "",
    });
  };

  return (
    <div className="space-y-6" data-testid="pi-mcp-tools-section">
      {/* 1. MCP 服务器 (mcp.json) */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("MCP 服务器 (mcp.json)", "MCP Servers (mcp.json)")}
          count={visibleServers.length}
          actions={
            <>
              <PiScopeSwitch
                scope={scope}
                onScopeChange={setScope}
                hasWorkspace={hasWorkspace}
                testId="pi-mcp-scope"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMcpForm(createEmptyMcpForm(scope))}
                data-testid="pi-mcp-add-btn"
              >
                <Plus className="size-3.5" />
                {tr("添加服务器", "Add server")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={loading}
                aria-label={tr("刷新 MCP", "Refresh MCP")}
                onClick={() => void reload()}
              >
                <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
              </Button>
            </>
          }
        />

        <PiCard testId="pi-mcp-list">
          {visibleServers.length === 0 ? (
            <div className="px-4 py-3 text-ui-sm text-foreground-subtle">
              {tr("当前范围尚未配置 MCP 服务器。", "No MCP servers configured in this scope.")}
            </div>
          ) : (
            visibleServers.map((server) => (
              <PiRow
                key={`${server.scope}:${server.name}`}
                testId={`pi-mcp-row-${server.name}`}
                label={
                  <span className="flex items-center gap-2">
                    <Cable className="size-3.5 text-foreground-subtle" />
                    <span className="font-mono">{server.name}</span>
                    <PiStatusPill tone="neutral">{server.transport}</PiStatusPill>
                    <PiStatusPill tone="neutral">{server.exposure}</PiStatusPill>
                  </span>
                }
                hint={
                  server.transport === "stdio"
                    ? `${server.command ?? ""} ${(server.args ?? []).join(" ")}`.trim()
                    : server.url
                }
                control={
                  <div className="flex items-center gap-1.5">
                    <Switch
                      checked={server.enabled}
                      onCheckedChange={(checked) => void handleToggleMcpEnabled(server, checked)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${server.name}`}
                      onClick={() => openEditMcp(server)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${server.name}`}
                      onClick={() => void handleDeleteMcp(server)}
                    >
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                }
              />
            ))
          )}
        </PiCard>
      </div>

      {/* 2. Pi 内置工具开关 */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("Pi 内置工具矩阵", "Pi Built-in Tools")}
          count={`${activeTools.size}/${PI_BUILTIN_TOOLS.length}`}
          actions={
            defaultToolsItem?.hasValue ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void resetSetting("defaultTools")}
              >
                {tr("恢复默认", "Reset")}
              </Button>
            ) : null
          }
        />
        <div className="grid gap-2 sm:grid-cols-2" data-testid="pi-tools-grid">
          {PI_BUILTIN_TOOLS.map((toolId) => {
            const enabled = activeTools.has(toolId);
            const meta = TOOL_LABELS[toolId];
            return (
              <div
                key={toolId}
                data-testid={`pi-tool-card-${toolId}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 font-mono text-ui-sm font-medium text-foreground">
                    <Wrench className="size-3.5 text-foreground-subtle" />
                    {toolId}
                  </div>
                  <div className="truncate text-ui-xs text-foreground-subtle">
                    {tr(meta.zh, meta.en)}
                  </div>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) => handleToggleTool(toolId, checked)}
                  data-testid={`pi-tool-switch-${toolId}`}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* 3. CodeMode 与图像输入 */}
      <div className="space-y-3">
        <PiSectionHeader title={tr("CodeMode 沙箱与图像", "CodeMode Sandbox & Images")} />
        <PiCard>
          <PiRow
            label={tr("CodeMode 编排模式", "CodeMode orchestration")}
            control={
              <PiSegmented
                value={codeMode}
                options={[
                  { value: "on", label: tr("常规混合 (on)", "Hybrid (on)") },
                  { value: "only", label: tr("仅 CodeMode (only)", "CodeMode only") },
                ]}
                onChange={(next) => void setSetting("codemode.mode", next)}
                testId="pi-codemode-mode"
              />
            }
          />
          <PiRow
            label={tr("内联输出预算 (inlineBudget)", "Inline output budget")}
            control={
              <Input
                type="number"
                defaultValue={inlineBudget}
                key={`budget-${inlineBudget}`}
                className="w-28 text-right font-mono tabular-nums"
                onBlur={(e) => {
                  const n = Number(e.currentTarget.value);
                  if (Number.isFinite(n) && n >= 256 && n !== inlineBudget) {
                    void setSetting("codemode.inlineBudget", Math.round(n));
                  }
                }}
                data-testid="pi-codemode-budget"
              />
            }
          />
          <PiRow
            label={tr("大图自动缩放至 2000×2000", "Auto-resize images to 2000×2000")}
            control={
              <Switch
                checked={autoResize}
                onCheckedChange={(checked) => void setSetting("images.autoResize", checked)}
                data-testid="pi-images-auto-resize"
              />
            }
          />
        </PiCard>
      </div>

      {/* MCP 新增/编辑弹窗 */}
      <Dialog open={mcpForm !== null} onOpenChange={(open) => !open && setMcpForm(null)}>
        <DialogContent data-testid="pi-mcp-dialog">
          <DialogHeader>
            <DialogTitle>
              {mcpForm?.mode === "edit"
                ? tr("编辑 MCP 服务器", "Edit MCP Server")
                : tr("添加 MCP 服务器", "Add MCP Server")}
            </DialogTitle>
          </DialogHeader>
          {mcpForm ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <PiSegmented
                  value={mcpForm.transport}
                  options={[
                    { value: "stdio", label: "stdio" },
                    { value: "http", label: "HTTP" },
                  ]}
                  onChange={(transport) => setMcpForm({ ...mcpForm, transport })}
                />
                <PiSegmented
                  value={mcpForm.exposure}
                  options={PI_MCP_EXPOSURES.map((exp) => ({ value: exp, label: exp }))}
                  onChange={(exposure) => setMcpForm({ ...mcpForm, exposure })}
                />
              </div>
              <Input
                value={mcpForm.name}
                onChange={(e) => setMcpForm({ ...mcpForm, name: e.currentTarget.value })}
                placeholder={tr("服务器名称 (如 filesystem)", "Server name")}
                className="font-mono"
                data-testid="pi-mcp-name-input"
              />
              {mcpForm.transport === "stdio" ? (
                <>
                  <Input
                    value={mcpForm.command}
                    onChange={(e) => setMcpForm({ ...mcpForm, command: e.currentTarget.value })}
                    placeholder={tr("启动命令 (如 npx)", "Command (e.g. npx)")}
                    className="font-mono"
                    data-testid="pi-mcp-command-input"
                  />
                  <Input
                    value={mcpForm.argsText}
                    onChange={(e) => setMcpForm({ ...mcpForm, argsText: e.currentTarget.value })}
                    placeholder={tr("参数 (空格或换行分隔)", "Args (space or newline separated)")}
                    className="font-mono"
                  />
                  <Textarea
                    rows={3}
                    value={mcpForm.envText}
                    onChange={(e) => setMcpForm({ ...mcpForm, envText: e.currentTarget.value })}
                    placeholder={tr(
                      "环境变量 KEY=VALUE（每行一条，只写不回显）",
                      "ENV KEY=VALUE (one per line, write-only)",
                    )}
                    className="font-mono text-ui-xs"
                  />
                </>
              ) : (
                <>
                  <Input
                    value={mcpForm.url}
                    onChange={(e) => setMcpForm({ ...mcpForm, url: e.currentTarget.value })}
                    placeholder="https://mcp.example.com/sse"
                    className="font-mono"
                    data-testid="pi-mcp-url-input"
                  />
                  <Textarea
                    rows={3}
                    value={mcpForm.headersText}
                    onChange={(e) => setMcpForm({ ...mcpForm, headersText: e.currentTarget.value })}
                    placeholder={tr(
                      "请求头 Header: Value（每行一条，只写不回显）",
                      "Headers Header: Value (one per line, write-only)",
                    )}
                    className="font-mono text-ui-xs"
                  />
                </>
              )}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setMcpForm(null)}>
              {tr("取消", "Cancel")}
            </Button>
            <Button
              type="button"
              disabled={
                savingMcp ||
                !mcpForm?.name.trim() ||
                (mcpForm.transport === "stdio" ? !mcpForm.command.trim() : !mcpForm.url.trim())
              }
              onClick={() => void handleSaveMcp()}
              data-testid="pi-mcp-save-btn"
            >
              {tr("保存", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
