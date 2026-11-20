import { useState } from "react";
import {
  PI_BUILTIN_EXTENSIONS,
  type PiBuiltinExtensionId,
  type PiConfigScope,
  type PiPackageItem,
  type PiPromptTemplate,
} from "@zcode/shared/pi-config";
import { Blocks, FolderPlus, Package, Plus, RefreshCw, Trash2, WandSparkles } from "lucide-react";
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
import { useSelectDirectory } from "@/hooks/usePlatform.js";
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
import { usePiResourcesSnapshot, usePiSettingsSnapshot, usePiText } from "./usePiConfig.js";
import {
  updatePiSubagentPreferences,
  usePiSubagentPreferences,
  type PiSubagentDisplayDensity,
} from "./piSubagentPreferences.js";

const BUILTIN_EXT_LABELS: Record<PiBuiltinExtensionId, { zh: string; en: string }> = {
  "builtin:mcp": { zh: "MCP 客户端与工具桥接", en: "MCP client & tool bridge" },
  "builtin:codemode": { zh: "CodeMode JS 工具编排沙箱", en: "CodeMode JS sandbox orchestration" },
  "builtin:tool-search": { zh: "延迟工具按需检索", en: "On-demand deferred tool lookup" },
  "builtin:llama.cpp": { zh: "本地 llama.cpp 推理", en: "Local llama.cpp inference" },
};

export function PiExtensionsSection({ workspacePath }: PiWorkspaceScopedSectionProps) {
  const { tr } = usePiText();
  const selectDirectory = useSelectDirectory();
  const { service, resources, loading, reload } = usePiResourcesSnapshot(workspacePath);
  const { setSetting } = usePiSettingsSnapshot(workspacePath);
  const subagentPrefs = usePiSubagentPreferences();

  const [scope, setScope] = useState<PiConfigScope>("global");
  const [pkgInput, setPkgInput] = useState("");
  const [pkgBusy, setPkgBusy] = useState<string | null>(null);
  const [pkgOutput, setPkgOutput] = useState("");
  const [extPathInput, setExtPathInput] = useState("");
  const [promptModal, setPromptModal] = useState<{
    name: string;
    content: string;
    isEdit: boolean;
  } | null>(null);

  if (!service) return <PiServiceUnavailable />;

  const hasWorkspace = Boolean(workspacePath?.trim());
  const scopedWorkspace = scope === "project" && workspacePath ? workspacePath : undefined;

  const visiblePackages = (resources?.packages ?? []).filter((pkg) =>
    scope === "global" ? pkg.scope === "global" : true,
  );
  const visibleSkills = (resources?.skills ?? []).filter((skill) =>
    scope === "global" ? skill.scope === "global" : true,
  );
  const visiblePrompts = (resources?.prompts ?? []).filter((p) =>
    scope === "global" ? p.scope === "global" : true,
  );

  const runPkgAction = async (action: "install" | "remove" | "update", source?: string | null) => {
    setPkgBusy(source ? `${action}:${source}` : action);
    try {
      const res = await service.mutateResource({
        op: "runPackageAction",
        action,
        source: source ?? null,
        scope,
        ...(scopedWorkspace ? { workspacePath: scopedWorkspace } : {}),
      });
      if (res.op === "package") {
        setPkgOutput(res.result.output.trim());
        if (action === "install" && res.result.ok) setPkgInput("");
        toast(
          res.result.ok
            ? tr("Pi 包操作已完成", "Pi package action completed")
            : tr("Pi 包操作失败", "Pi package action failed"),
        );
      }
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setPkgBusy(null);
    }
  };

  const toggleBuiltin = async (id: PiBuiltinExtensionId, enabled: boolean) => {
    try {
      await service.mutateResource({
        op: "setBuiltinExtension",
        id,
        enabled,
        scope,
        ...(scopedWorkspace ? { workspacePath: scopedWorkspace } : {}),
      });
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const addCustomExtension = async () => {
    const trimmed = extPathInput.trim();
    const current = resources?.customExtensions ?? [];
    if (!trimmed || current.includes(trimmed)) return;
    try {
      await service.mutateResource({
        op: "setCustomExtensions",
        paths: [...current, trimmed],
        scope,
        ...(scopedWorkspace ? { workspacePath: scopedWorkspace } : {}),
      });
      setExtPathInput("");
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const runSafe = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const removeCustomExtension = (target: string) =>
    runSafe(async () => {
      const current = resources?.customExtensions ?? [];
      await service.mutateResource({
        op: "setCustomExtensions",
        paths: current.filter((p) => p !== target),
        scope,
        ...(scopedWorkspace ? { workspacePath: scopedWorkspace } : {}),
      });
      await reload();
    });

  const handleImportSkill = async () => {
    const selectedDir = await selectDirectory();
    if (!selectedDir) return;
    await runSafe(async () => {
      await service.mutateResource({
        op: "importSkillFolder",
        sourceDir: selectedDir,
        scope,
        ...(scopedWorkspace ? { workspacePath: scopedWorkspace } : {}),
      });
      await reload();
      toast(tr("Skill 文件夹已导入", "Skill folder imported"));
    });
  };

  const handleSavePrompt = async () => {
    if (!promptModal || !promptModal.name.trim()) return;
    await runSafe(async () => {
      await service.mutateResource({
        op: "savePromptTemplate",
        name: promptModal.name.trim(),
        content: promptModal.content,
        scope,
        ...(scopedWorkspace ? { workspacePath: scopedWorkspace } : {}),
      });
      setPromptModal(null);
      await reload();
      toast(tr("Prompt 模板已保存", "Prompt template saved"));
    });
  };

  const handleDeletePrompt = (prompt: PiPromptTemplate) =>
    runSafe(async () => {
      await service.mutateResource({
        op: "deletePromptTemplate",
        fileName: prompt.fileName,
        scope: prompt.scope,
        ...(prompt.scope === "project" && workspacePath ? { workspacePath } : {}),
      });
      await reload();
      toast(tr(`已删除 ${prompt.name}`, `Deleted ${prompt.name}`));
    });

  return (
    <div className="space-y-6" data-testid="pi-extensions-section">
      {/* 顶栏作用域切换 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PiScopeSwitch
          scope={scope}
          onScopeChange={setScope}
          hasWorkspace={hasWorkspace}
          testId="pi-extensions-scope"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void reload()}
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          {tr("刷新", "Refresh")}
        </Button>
      </div>

      {/* 0. Pi Subagent 独立窗口与交互效果设置 */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("Pi Subagent 显示与互动效果", "Pi Subagent Display & Interaction")}
        />
        <PiCard className="px-4 py-1" testId="pi-subagent-effects-card">
          <PiRow
            label={tr("调用时自动打开右侧子代理窗口", "Auto-open subagent side pane")}
            hint={tr(
              "当 Pi 派发 Subagent（单任务/并行/链式）时，自动在右侧工作台打开独立观测窗口，实时查看子代理思考与工具调用。",
              "Automatically open the right-side subagent pane whenever Pi dispatches a subagent.",
            )}
            control={
              <Switch
                checked={subagentPrefs.autoOpenSidePane}
                onCheckedChange={(checked) =>
                  updatePiSubagentPreferences({ autoOpenSidePane: checked })
                }
                data-testid="pi-subagent-auto-open"
              />
            }
          />
          <PiRow
            label={tr("子代理轨迹信息密度", "Subagent trace density")}
            hint={tr(
              "控制子代理摘要卡片与独立窗口中工具细节的展示粒度。",
              "Control detail density for subagent cards and trace views.",
            )}
            control={
              <PiSegmented<PiSubagentDisplayDensity>
                value={subagentPrefs.displayDensity}
                onChange={(displayDensity) => updatePiSubagentPreferences({ displayDensity })}
                options={[
                  { value: "compact", label: tr("紧凑", "Compact") },
                  { value: "standard", label: tr("标准", "Standard") },
                  { value: "detailed", label: tr("详细", "Detailed") },
                ]}
                testId="pi-subagent-density"
              />
            }
          />
          <PiRow
            label={tr("完成后自动收起展开明细", "Auto-collapse when completed")}
            hint={tr(
              "子代理全部执行成功后自动折叠明细（出错时保持展开提醒）。",
              "Automatically collapse details once all subagents finish successfully.",
            )}
            control={
              <Switch
                checked={subagentPrefs.autoCollapseOnComplete}
                onCheckedChange={(checked) =>
                  updatePiSubagentPreferences({ autoCollapseOnComplete: checked })
                }
                data-testid="pi-subagent-auto-collapse"
              />
            }
          />
          <PiRow
            label={tr("显示模型与 Token 消耗", "Show model & token metrics")}
            hint={tr(
              "在子代理摘要与标题中透出所用模型与统计指标。",
              "Display subagent model and token/turn metrics in summaries.",
            )}
            control={
              <Switch
                checked={subagentPrefs.showMetrics}
                onCheckedChange={(checked) => updatePiSubagentPreferences({ showMetrics: checked })}
                data-testid="pi-subagent-show-metrics"
              />
            }
          />
        </PiCard>
      </div>

      {/* 1. Pi 包管理 (pi install / update / remove) */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("Pi 扩展包管理", "Pi Package Manager")}
          count={visiblePackages.length}
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pkgBusy !== null}
              onClick={() => void runPkgAction("update")}
              data-testid="pi-pkg-update-all"
            >
              <RefreshCw className={`size-3.5 ${pkgBusy === "update" ? "animate-spin" : ""}`} />
              {tr("全部更新", "Update all")}
            </Button>
          }
        />
        <PiCard className="p-4 space-y-3" testId="pi-packages-card">
          <div className="flex items-center gap-2">
            <Input
              value={pkgInput}
              onChange={(e) => setPkgInput(e.currentTarget.value)}
              placeholder="npm:pi-web-access · git:github.com/user/repo · ./local"
              className="flex-1 font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter" && pkgInput.trim()) {
                  void runPkgAction("install", pkgInput.trim());
                }
              }}
              data-testid="pi-pkg-input"
            />
            <Button
              type="button"
              size="sm"
              disabled={pkgBusy !== null || !pkgInput.trim()}
              onClick={() => void runPkgAction("install", pkgInput.trim())}
              data-testid="pi-pkg-install-btn"
            >
              <Package className="size-3.5" />
              {tr("安装", "Install")}
            </Button>
          </div>

          {pkgOutput ? (
            <pre
              data-testid="pi-pkg-output"
              className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-2.5 font-mono text-ui-xs text-foreground-subtle"
            >
              {pkgOutput}
            </pre>
          ) : null}

          {visiblePackages.length === 0 ? (
            <p className="text-ui-sm text-foreground-subtle">
              {tr("尚未安装外部 Pi 扩展包。", "No Pi packages installed yet.")}
            </p>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border">
              {visiblePackages.map((pkg: PiPackageItem) => (
                <div
                  key={`${pkg.scope}:${pkg.source}`}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                  data-testid={`pi-pkg-row-${pkg.source}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-ui-sm text-foreground">
                      {pkg.source}
                    </span>
                    <PiStatusPill tone="neutral">{pkg.kind}</PiStatusPill>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pkgBusy !== null}
                    onClick={() => void runPkgAction("remove", pkg.source)}
                    data-testid={`pi-pkg-remove-${pkg.source}`}
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                    {tr("卸载", "Remove")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </PiCard>
      </div>

      {/* 2. 内置扩展 (builtin:*) 与本地扩展路径 */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("内置扩展 (builtin:*)", "Built-in Extensions (builtin:*)")}
          count={PI_BUILTIN_EXTENSIONS.length}
        />
        <PiCard testId="pi-builtin-extensions-card">
          {PI_BUILTIN_EXTENSIONS.map((id) => {
            const state = resources?.builtinExtensions.find((item) => item.id === id);
            const enabled = state?.enabled ?? true;
            const meta = BUILTIN_EXT_LABELS[id];
            return (
              <PiRow
                key={id}
                label={
                  <span className="flex items-center gap-2 font-mono">
                    <Blocks className="size-3.5 text-foreground-subtle" />
                    {id}
                  </span>
                }
                hint={tr(meta.zh, meta.en)}
                control={
                  <Switch
                    checked={enabled}
                    onCheckedChange={(checked) => void toggleBuiltin(id, checked)}
                    data-testid={`pi-builtin-ext-${id}`}
                  />
                }
              />
            );
          })}
          <PiRow
            label={tr("自定义扩展路径 (extensions)", "Custom extension paths")}
            control={
              <div className="flex items-center gap-2">
                <Input
                  value={extPathInput}
                  onChange={(e) => setExtPathInput(e.currentTarget.value)}
                  placeholder="./extensions/my-ext.ts"
                  className="w-56 font-mono"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addCustomExtension();
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!extPathInput.trim()}
                  onClick={() => void addCustomExtension()}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
            }
            detail={
              (resources?.customExtensions ?? []).length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {(resources?.customExtensions ?? []).map((extPath) => (
                    <span
                      key={extPath}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 font-mono text-ui-xs"
                    >
                      {extPath}
                      <button
                        type="button"
                        onClick={() => void removeCustomExtension(extPath)}
                        className="text-foreground-subtle hover:text-destructive"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : undefined
            }
          />
        </PiCard>
      </div>

      {/* 3. Skills 管理 */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("Skills (skills/)", "Skills (skills/)")}
          count={visibleSkills.length}
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleImportSkill()}
              data-testid="pi-skill-import-btn"
            >
              <FolderPlus className="size-3.5" />
              {tr("导入 Skill 文件夹", "Import folder")}
            </Button>
          }
        />
        <PiCard testId="pi-skills-card">
          <PiRow
            label={tr("启用 /skill:name 斜杠命令", "Enable /skill:name slash commands")}
            control={
              <Switch
                checked={resources?.enableSkillCommands ?? true}
                onCheckedChange={(checked) => void setSetting("enableSkillCommands", checked)}
                data-testid="pi-enable-skill-commands"
              />
            }
          />
          {visibleSkills.length === 0 ? (
            <div className="border-t border-border px-4 py-3 text-ui-sm text-foreground-subtle">
              {tr("当前范围暂无 Skill。", "No skills found in this scope.")}
            </div>
          ) : (
            visibleSkills.map((skill) => (
              <PiRow
                key={`${skill.scope}:${skill.filePath}`}
                testId={`pi-skill-row-${skill.name}`}
                label={
                  <span className="flex items-center gap-2">
                    <WandSparkles className="size-3.5 text-foreground-subtle" />
                    <span>{skill.name}</span>
                    <PiStatusPill tone="neutral">{skill.scope}</PiStatusPill>
                  </span>
                }
                hint={skill.description || skill.folderPath}
                control={
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={skill.enabled}
                      onCheckedChange={(checked) =>
                        void runSafe(async () => {
                          await service.mutateResource({
                            op: "setSkillEnabled",
                            skillNameOrPath: skill.name,
                            enabled: checked,
                            scope: skill.scope,
                            ...(skill.scope === "project" && workspacePath
                              ? { workspacePath }
                              : {}),
                          });
                          await reload();
                        })
                      }
                    />
                    {skill.removable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${skill.name}`}
                        onClick={() =>
                          void runSafe(async () => {
                            await service.mutateResource({
                              op: "deleteSkillFolder",
                              folderPath: skill.folderPath,
                              scope: skill.scope,
                              ...(skill.scope === "project" && workspacePath
                                ? { workspacePath }
                                : {}),
                            });
                            toast(
                              tr(`已将 ${skill.name} 移入回收站`, `Moved ${skill.name} to trash`),
                            );
                            await reload();
                          })
                        }
                      >
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    ) : null}
                  </div>
                }
              />
            ))
          )}
        </PiCard>
      </div>

      {/* 4. Prompt 模板 (prompts/*.md) */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("Prompt 模板 (prompts/*.md)", "Prompt Templates (prompts/*.md)")}
          count={visiblePrompts.length}
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPromptModal({ name: "", content: "", isEdit: false })}
              data-testid="pi-prompt-add-btn"
            >
              <Plus className="size-3.5" />
              {tr("新建模板", "New template")}
            </Button>
          }
        />
        <PiCard testId="pi-prompts-card">
          {visiblePrompts.length === 0 ? (
            <div className="px-4 py-3 text-ui-sm text-foreground-subtle">
              {tr("暂无 Prompt 模板。", "No prompt templates yet.")}
            </div>
          ) : (
            visiblePrompts.map((prompt) => (
              <PiRow
                key={`${prompt.scope}:${prompt.fileName}`}
                label={<span className="font-mono">/{prompt.name}</span>}
                hint={prompt.description || prompt.fileName}
                control={
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setPromptModal({
                          name: prompt.name,
                          content: prompt.content ?? "",
                          isEdit: true,
                        })
                      }
                    >
                      {tr("编辑", "Edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${prompt.name}`}
                      onClick={() => void handleDeletePrompt(prompt)}
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

      {/* Prompt 模板编辑弹窗 */}
      <Dialog open={promptModal !== null} onOpenChange={(open) => !open && setPromptModal(null)}>
        <DialogContent data-testid="pi-prompt-dialog">
          <DialogHeader>
            <DialogTitle>
              {promptModal?.isEdit
                ? tr("编辑 Prompt 模板", "Edit Prompt Template")
                : tr("新建 Prompt 模板", "New Prompt Template")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={promptModal?.name ?? ""}
              disabled={promptModal?.isEdit}
              onChange={(e) =>
                setPromptModal((prev) => (prev ? { ...prev, name: e.currentTarget.value } : null))
              }
              placeholder="review-pr"
              className="font-mono"
              data-testid="pi-prompt-name-input"
            />
            <Textarea
              rows={8}
              value={promptModal?.content ?? ""}
              onChange={(e) =>
                setPromptModal((prev) =>
                  prev ? { ...prev, content: e.currentTarget.value } : null,
                )
              }
              placeholder={tr("输入 Markdown 提示词模板内容…", "Write Markdown prompt template…")}
              className="font-mono text-ui-sm"
              data-testid="pi-prompt-content-input"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPromptModal(null)}>
              {tr("取消", "Cancel")}
            </Button>
            <Button
              type="button"
              disabled={!promptModal?.name.trim()}
              onClick={() => void handleSavePrompt()}
              data-testid="pi-prompt-save-btn"
            >
              {tr("保存", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
