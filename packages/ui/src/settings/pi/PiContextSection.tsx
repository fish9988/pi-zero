import { useCallback, useEffect, useState } from "react";
import {
  PI_SYSTEM_DOC_KINDS,
  type PiConfigScope,
  type PiSystemDocKind,
} from "@zcode/shared/pi-config";
import { Plus, RotateCcw, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
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
} from "./PiPrimitives.js";
import {
  readBooleanSetting,
  readNumberSetting,
  readStringArraySetting,
  readStringSetting,
  usePiSettingsSnapshot,
  usePiText,
} from "./usePiConfig.js";

type QueueDeliveryMode = "one-at-a-time" | "all";

export function PiContextSection({ workspacePath }: PiWorkspaceScopedSectionProps) {
  const { tr } = usePiText();
  const { service, getItem, setSetting, resetSetting } = usePiSettingsSnapshot(workspacePath);
  const [scope, setScope] = useState<PiConfigScope>("global");
  const [docKind, setDocKind] = useState<PiSystemDocKind>("AGENTS.md");
  const [savedContent, setSavedContent] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [docExists, setDocExists] = useState(false);
  const [docPath, setDocPath] = useState("");
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [savingDoc, setSavingDoc] = useState(false);
  const [enabledModelDraft, setEnabledModelDraft] = useState("");

  const hasWorkspace = Boolean(workspacePath?.trim());

  const loadDoc = useCallback(async () => {
    if (!service) return;
    setLoadingDoc(true);
    try {
      const res = await service.mutateResource({
        op: "getSystemDoc",
        scope,
        kind: docKind,
        ...(scope === "project" && workspacePath ? { workspacePath } : {}),
      });
      if (res.op === "systemDoc") {
        setSavedContent(res.doc.content);
        setDraftContent(res.doc.content);
        setDocExists(res.doc.exists);
        setDocPath(res.doc.filePath);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDoc(false);
    }
  }, [docKind, scope, service, workspacePath]);

  useEffect(() => {
    void loadDoc();
  }, [loadDoc]);

  const handleSaveDoc = async () => {
    if (!service) return;
    setSavingDoc(true);
    try {
      const res = await service.mutateResource({
        op: "saveSystemDoc",
        scope,
        kind: docKind,
        content: draftContent,
        ...(scope === "project" && workspacePath ? { workspacePath } : {}),
      });
      if (res.op === "systemDoc") {
        setSavedContent(res.doc.content);
        setDocExists(res.doc.exists);
        setDocPath(res.doc.filePath);
      }
      toast(tr(`已保存 ${docKind}`, `Saved ${docKind}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingDoc(false);
    }
  };

  if (!service) return <PiServiceUnavailable />;

  const compactionEnabled = readBooleanSetting(getItem("compaction.enabled"), true);
  const reserveTokens = readNumberSetting(getItem("compaction.reserveTokens"), 16384);
  const keepRecentTokens = readNumberSetting(getItem("compaction.keepRecentTokens"), 20000);
  const steeringMode = readStringSetting(
    getItem("steeringMode"),
    "one-at-a-time",
  ) as QueueDeliveryMode;
  const followUpMode = readStringSetting(
    getItem("followUpMode"),
    "one-at-a-time",
  ) as QueueDeliveryMode;
  const enabledModels = readStringArraySetting(getItem("enabledModels"), []);
  const dirty = draftContent !== savedContent;

  const queueOptions: ReadonlyArray<{ value: QueueDeliveryMode; label: string }> = [
    { value: "one-at-a-time", label: tr("逐条投递", "One at a time") },
    { value: "all", label: tr("合并投递", "All at once") },
  ];

  const docOptions = PI_SYSTEM_DOC_KINDS.map((kind) => ({ value: kind, label: kind }));

  const handleAddEnabledModel = async () => {
    const trimmed = enabledModelDraft.trim();
    if (!trimmed || enabledModels.includes(trimmed)) return;
    await setSetting("enabledModels", [...enabledModels, trimmed]);
    setEnabledModelDraft("");
  };

  const handleRemoveEnabledModel = async (target: string) => {
    await setSetting(
      "enabledModels",
      enabledModels.filter((item) => item !== target),
    );
  };

  return (
    <div className="space-y-6" data-testid="pi-context-section">
      {/* 1. 全局与项目指令文档 */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("指令与系统提示词文档", "Instruction & System Prompt Files")}
          actions={
            <PiScopeSwitch
              scope={scope}
              onScopeChange={setScope}
              hasWorkspace={hasWorkspace}
              testId="pi-context-scope"
            />
          }
        />

        <PiCard className="p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <PiSegmented
              value={docKind}
              options={docOptions}
              onChange={setDocKind}
              testId="pi-doc-kind"
            />
            {docPath ? (
              <span
                className="truncate font-mono text-ui-xs text-foreground-subtlest"
                title={docPath}
              >
                {docPath}
              </span>
            ) : null}
          </div>

          <Textarea
            value={draftContent}
            disabled={loadingDoc}
            onChange={(e) => setDraftContent(e.currentTarget.value)}
            rows={10}
            className="min-h-48 font-mono text-ui-sm"
            placeholder={tr(`编写 ${docKind} 内容…`, `Write ${docKind} content…`)}
            data-testid="pi-doc-editor"
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-ui-xs text-foreground-subtle">
              {loadingDoc
                ? tr("正在读取…", "Loading…")
                : dirty
                  ? tr("有未保存改动", "Unsaved changes")
                  : docExists
                    ? tr("已与磁盘同步", "Synced with disk")
                    : tr("尚未创建（保存时自动创建）", "Not created yet (Save to create)")}
            </span>
            <div className="flex items-center gap-2">
              {dirty ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDraftContent(savedContent)}
                  data-testid="pi-doc-revert"
                >
                  <RotateCcw className="size-3.5" />
                  {tr("还原", "Revert")}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={savingDoc || loadingDoc || (!dirty && docExists)}
                onClick={() => void handleSaveDoc()}
                data-testid="pi-doc-save"
              >
                <Save className="size-3.5" />
                {tr("保存", "Save")}
              </Button>
            </div>
          </div>
        </PiCard>
      </div>

      {/* 2. 自动压缩与队列投递策略 */}
      <div className="space-y-3">
        <PiSectionHeader title={tr("上下文压缩与忙碌队列", "Compaction & Queue Delivery")} />
        <PiCard>
          <PiRow
            label={tr("启用自动压缩", "Enable auto-compaction")}
            hint={tr("上下文接近窗口上限时自动压缩历史消息", "Auto-compact context near limit")}
            control={
              <Switch
                checked={compactionEnabled}
                onCheckedChange={(checked) => void setSetting("compaction.enabled", checked)}
                data-testid="pi-compaction-enabled"
              />
            }
          />
          <PiRow
            label={tr("预留 Token (reserveTokens)", "Reserve tokens")}
            control={
              <Input
                type="number"
                defaultValue={reserveTokens}
                key={`reserve-${reserveTokens}`}
                className="w-32 text-right font-mono tabular-nums"
                onBlur={(e) => {
                  const n = Number(e.currentTarget.value);
                  if (Number.isFinite(n) && n >= 1024 && n !== reserveTokens) {
                    void setSetting("compaction.reserveTokens", Math.round(n));
                  }
                }}
                data-testid="pi-compaction-reserve"
              />
            }
          />
          <PiRow
            label={tr("保留最近 Token (keepRecentTokens)", "Keep recent tokens")}
            control={
              <Input
                type="number"
                defaultValue={keepRecentTokens}
                key={`keep-${keepRecentTokens}`}
                className="w-32 text-right font-mono tabular-nums"
                onBlur={(e) => {
                  const n = Number(e.currentTarget.value);
                  if (Number.isFinite(n) && n >= 1024 && n !== keepRecentTokens) {
                    void setSetting("compaction.keepRecentTokens", Math.round(n));
                  }
                }}
                data-testid="pi-compaction-keep-recent"
              />
            }
          />
          <PiRow
            label={tr("插话队列模式 (steer)", "Steering queue mode")}
            control={
              <PiSegmented
                value={steeringMode}
                options={queueOptions}
                onChange={(next) => void setSetting("steeringMode", next)}
                testId="pi-steering-mode"
              />
            }
          />
          <PiRow
            label={tr("追问队列模式 (followUp)", "Follow-up queue mode")}
            control={
              <PiSegmented
                value={followUpMode}
                options={queueOptions}
                onChange={(next) => void setSetting("followUpMode", next)}
                testId="pi-followup-mode"
              />
            }
          />
        </PiCard>
      </div>

      {/* 3. enabledModels */}
      <div className="space-y-3">
        <PiSectionHeader
          title={tr("启用的模型白名单 (enabledModels)", "Enabled Models Scope")}
          count={enabledModels.length}
          actions={
            enabledModels.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void resetSetting("enabledModels")}
              >
                {tr("清空限制", "Clear")}
              </Button>
            ) : null
          }
        />
        <PiCard className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={enabledModelDraft}
              onChange={(e) => setEnabledModelDraft(e.currentTarget.value)}
              placeholder="anthropic/claude-sonnet-4-5"
              className="flex-1 font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAddEnabledModel();
              }}
              data-testid="pi-enabled-model-input"
            />
            <Button
              type="button"
              size="sm"
              disabled={!enabledModelDraft.trim()}
              onClick={() => void handleAddEnabledModel()}
              data-testid="pi-enabled-model-add"
            >
              <Plus className="size-3.5" />
              {tr("添加", "Add")}
            </Button>
          </div>
          {enabledModels.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {enabledModels.map((item) => (
                <span
                  key={item}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 font-mono text-ui-xs text-foreground"
                >
                  {item}
                  <button
                    type="button"
                    aria-label={`Remove ${item}`}
                    onClick={() => void handleRemoveEnabledModel(item)}
                    className="text-foreground-subtle hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-ui-sm text-foreground-subtle">
              {tr("留空表示允许全部可用模型。", "Leave empty to allow all discovered models.")}
            </p>
          )}
        </PiCard>
      </div>
    </div>
  );
}
