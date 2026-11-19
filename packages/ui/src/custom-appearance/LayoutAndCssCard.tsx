import { useState } from "react";
import { ChevronDown, ChevronUp, Code2, RotateCcw, ShieldAlert, Sparkles } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Switch } from "@/components/ui/switch.js";
import {
  AppearanceSectionHeader,
  AppearanceSettingRow,
  AppearanceSlider,
} from "./AppearancePrimitives.js";
import { CUSTOM_CSS_SNIPPETS } from "./presets.js";
import {
  CHAT_WIDTH_DEFAULT_PX,
  CHAT_WIDTH_MAX_PX,
  CHAT_WIDTH_MIN_PX,
  useCustomAppearanceStore,
} from "./store.js";

const WIDTH_PRESETS: Array<{ label: string; value: number | null }> = [
  { label: "自动", value: null },
  { label: "紧凑", value: 760 },
  { label: "标准", value: 960 },
  { label: "宽屏", value: 1200 },
  { label: "全宽", value: 1480 },
];

export function ReadingLayoutSection() {
  const layout = useCustomAppearanceStore((state) => state.config.layout);
  const updateConfig = useCustomAppearanceStore((state) => state.updateConfig);
  const setChatMaxWidthPx = useCustomAppearanceStore((state) => state.setChatMaxWidthPx);

  return (
    <Card className="overflow-hidden rounded-xl border border-border bg-card py-0 shadow-none">
      <CardContent className="space-y-0 px-0">
        {/* Reading width row with segmented presets + slider */}
        <div className="space-y-3 px-4 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-ui-base font-medium text-foreground">对话阅读宽度</div>
              <div className="mt-0.5 text-ui-sm leading-5 text-foreground-subtle">
                调节主聊天区域的最大行宽，与画布左侧隐藏拖拽条实时同步。
              </div>
            </div>
            <span className="shrink-0 rounded-md bg-surface px-2 py-0.5 font-mono text-ui-xs font-medium tabular-nums text-foreground">
              {layout.chatMaxWidthPx === null ? "自动适应" : `${layout.chatMaxWidthPx} px`}
            </span>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div
              role="group"
              aria-label="对话宽度预设"
              className="inline-flex shrink-0 items-center rounded-lg border border-border bg-surface p-0.5"
            >
              {WIDTH_PRESETS.map((preset) => {
                const active = layout.chatMaxWidthPx === preset.value;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setChatMaxWidthPx(preset.value)}
                    className={cn(
                      "h-6 rounded-md px-2.5 text-ui-xs font-medium transition-colors",
                      active
                        ? "bg-card text-foreground shadow-xs"
                        : "text-foreground-subtle hover:text-foreground",
                    )}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>

            <AppearanceSlider
              ariaLabel="对话最大宽度"
              valueLabel={`${layout.chatMaxWidthPx ?? CHAT_WIDTH_DEFAULT_PX} px`}
              min={CHAT_WIDTH_MIN_PX}
              max={CHAT_WIDTH_MAX_PX}
              step={10}
              value={layout.chatMaxWidthPx ?? CHAT_WIDTH_DEFAULT_PX}
              onChange={(widthPx) => setChatMaxWidthPx(widthPx)}
              className="flex-1"
            />
          </div>
        </div>

        <AppearanceSettingRow
          label="隐藏半高拉伸边界"
          description="鼠标悬停聊天区左侧边缘 0.15 秒显现拖拽条，双击可快速还原默认宽度。"
          control={
            <Switch
              aria-label="启用隐藏半高拉伸边界"
              checked={layout.enableResizeHandle}
              onCheckedChange={(checked) =>
                updateConfig((prev) => ({
                  ...prev,
                  layout: { ...prev.layout, enableResizeHandle: checked },
                }))
              }
            />
          }
        />

        <AppearanceSettingRow
          label="宽屏下仅拉宽代码与表格"
          description="普通文字保持舒适的 72ch 阅读宽度，代码块与表格占满整个聊天栏。"
          control={
            <Switch
              aria-label="宽屏下仅拉宽代码与表格"
              checked={layout.wideCodeBlocks}
              onCheckedChange={(checked) =>
                updateConfig((prev) => ({
                  ...prev,
                  layout: { ...prev.layout, wideCodeBlocks: checked },
                }))
              }
            />
          }
        />

        <AppearanceSettingRow
          label="思考与工具卡片紧凑排版"
          description="收窄思考过程与工具调用折叠块的上下间距，长对话阅读更聚焦。"
          control={
            <Switch
              aria-label="思考与工具卡片紧凑排版"
              checked={layout.compactProcessCards}
              onCheckedChange={(checked) =>
                updateConfig((prev) => ({
                  ...prev,
                  layout: { ...prev.layout, compactProcessCards: checked },
                }))
              }
            />
          }
        />
      </CardContent>
    </Card>
  );
}

export function CustomCssSection() {
  const customCss = useCustomAppearanceStore((state) => state.config.customCss);
  const safeModeActive = useCustomAppearanceStore((state) => state.safeModeActive);
  const updateConfig = useCustomAppearanceStore((state) => state.updateConfig);
  const toggleSafeMode = useCustomAppearanceStore((state) => state.toggleSafeMode);

  const [expanded, setExpanded] = useState(true);

  const trimmedCode = customCss.code.trim();
  const hasCode = trimmedCode.length > 0;
  const lineCount = customCss.code ? customCss.code.split("\n").length : 0;

  const statusPill = safeModeActive
    ? { label: "安全模式", className: "bg-destructive-surface text-destructive-surface-foreground" }
    : !customCss.enabled
      ? { label: "已停用", className: "bg-surface text-foreground-subtle" }
      : hasCode
        ? { label: "已生效", className: "bg-success-surface text-success-surface-foreground" }
        : { label: "就绪", className: "bg-surface text-foreground-subtle" };

  return (
    <section className="min-w-0 space-y-3">
      <AppearanceSectionHeader
        title="自定义样式表"
        description="实时注入自定义 CSS 覆盖规则，按 Ctrl+Shift+Alt+R（Mac 为 Cmd+Shift+Alt+R）可随时紧急关闭。"
      />

      <Card className="overflow-hidden rounded-xl border border-border bg-card py-0 shadow-none">
        <CardContent className="space-y-0 px-0">
          {/* Card header */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
            >
              <Code2 className="size-4 shrink-0 text-foreground-subtle" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-ui-base font-medium text-foreground">CSS 样式覆盖</span>
                  <span
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-ui-xs font-medium",
                      statusPill.className,
                    )}
                  >
                    {statusPill.label}
                  </span>
                </div>
                <div className="mt-0.5 text-ui-sm leading-5 text-foreground-subtle">
                  作用域 <span className="font-mono text-ui-xs">#zcode-custom-css</span> ·
                  关闭开关即可一键回退
                </div>
              </div>
            </button>

            <div className="flex shrink-0 items-center gap-2">
              {safeModeActive ? (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => toggleSafeMode(false)}
                >
                  <ShieldAlert className="size-3" />
                  恢复 CSS
                </Button>
              ) : null}

              {hasCode ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    updateConfig((prev) => ({
                      ...prev,
                      customCss: { ...prev.customCss, code: "" },
                    }))
                  }
                >
                  <RotateCcw className="size-3" />
                  重置
                </Button>
              ) : null}

              <Switch
                aria-label="启用自定义 CSS"
                checked={customCss.enabled}
                onCheckedChange={(checked) =>
                  updateConfig((prev) => ({
                    ...prev,
                    customCss: { ...prev.customCss, enabled: checked },
                  }))
                }
              />

              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={expanded ? "收起样式表编辑器" : "展开样式表编辑器"}
                aria-expanded={expanded}
                onClick={() => setExpanded((prev) => !prev)}
              >
                {expanded ? (
                  <ChevronUp className="size-3.5 text-foreground-subtle" />
                ) : (
                  <ChevronDown className="size-3.5 text-foreground-subtle" />
                )}
              </Button>
            </div>
          </div>

          {expanded ? (
            <div className="space-y-3 border-t border-border bg-surface/40 p-4">
              {/* Quick snippets */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 pr-1 text-ui-xs font-medium text-foreground-subtle">
                  <Sparkles className="size-3" />
                  快捷片段
                </span>
                {CUSTOM_CSS_SNIPPETS.map((snippet) => (
                  <Button
                    key={snippet.id}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      updateConfig((prev) => ({
                        ...prev,
                        customCss: {
                          ...prev.customCss,
                          enabled: true,
                          code: prev.customCss.code.trim()
                            ? `${prev.customCss.code.trimEnd()}\n\n${snippet.code}`
                            : snippet.code,
                        },
                      }))
                    }
                  >
                    + {snippet.label}
                  </Button>
                ))}
              </div>

              {/* Monospace editor surface */}
              <div className="overflow-hidden rounded-lg border border-input-border bg-input transition-colors focus-within:border-input-border-focused focus-within:bg-input-focused">
                <div className="flex items-center justify-between border-b border-border bg-surface/60 px-3 py-1.5">
                  <span className="font-mono text-ui-xs text-foreground-subtle">custom.css</span>
                  <span className="font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                    {lineCount} 行 · {customCss.code.length} 字符
                  </span>
                </div>
                <textarea
                  value={customCss.code}
                  aria-label="自定义 CSS 代码"
                  onChange={(event) => {
                    const code = event.currentTarget.value;
                    updateConfig((prev) => ({
                      ...prev,
                      customCss: { ...prev.customCss, code },
                    }));
                  }}
                  rows={7}
                  spellCheck={false}
                  placeholder={`/* 在此输入自定义 CSS 规则，例如：\n[data-v4-user-input-bubble="true"] {\n  border-radius: 16px;\n}\n*/`}
                  className="block w-full resize-y bg-transparent p-3.5 font-mono text-ui-sm leading-6 text-foreground placeholder:text-foreground-subtlest"
                />
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

export function LayoutAndCssCard() {
  return (
    <div className="min-w-0 space-y-6">
      <ReadingLayoutSection />
      <CustomCssSection />
    </div>
  );
}
