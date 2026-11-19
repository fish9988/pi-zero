import { useCallback, useEffect, useState } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { AppearanceSlider } from "./AppearancePrimitives.js";
import {
  buildCssFontStack,
  FALLBACK_CJK_FONTS,
  FALLBACK_MONO_FONTS,
  FALLBACK_WESTERN_FONTS,
  querySystemLocalFonts,
  type LocalFontEntry,
  type LocalFontLoadStatus,
} from "./fontLoader.js";
import { useCustomAppearanceStore } from "./store.js";

type FontScope = "ui" | "chat" | "mono";

const FONT_SCOPE_TABS: Array<{ id: FontScope; label: string }> = [
  { id: "ui", label: "界面 UI" },
  { id: "chat", label: "聊天正文" },
  { id: "mono", label: "等宽代码" },
];

const WEIGHT_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 300, label: "300 细体" },
  { value: 400, label: "400 常规" },
  { value: 500, label: "500 适中" },
  { value: 600, label: "600 半粗" },
  { value: 700, label: "700 粗体" },
];

function FontFamilyField({
  label,
  value,
  placeholder,
  options,
  datalistId,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: string[];
  datalistId: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-sm font-medium text-foreground">{label}</span>
        {value ? (
          <button
            type="button"
            onClick={() => onChange("")}
            className="inline-flex items-center gap-1 text-ui-xs text-foreground-subtle transition-colors hover:text-foreground"
          >
            <RotateCcw className="size-3" />
            默认
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={value || "__default__"}
          onValueChange={(next) => onChange(next === "__default__" ? "" : next)}
        >
          <SelectTrigger size="default" className="w-full min-w-0 justify-between">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="__default__">跟随系统默认</SelectItem>
            {options.map((family) => (
              <SelectItem key={family} value={family}>
                {family}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          list={datalistId}
          size="default"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="min-w-0"
        />
        <datalist id={datalistId}>
          {options.map((family) => (
            <option key={family} value={family} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

function WeightSegmentPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (weight: number) => void;
}) {
  return (
    <div
      role="group"
      aria-label="字重选择"
      className="grid grid-cols-5 gap-1 rounded-lg border border-border bg-surface p-0.5"
    >
      {WEIGHT_OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-6 truncate rounded-md px-1.5 text-ui-xs font-medium tabular-nums transition-colors",
              active
                ? "bg-card text-foreground shadow-xs"
                : "text-foreground-subtle hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function FontCustomizeCard() {
  const fonts = useCustomAppearanceStore((state) => state.config.fonts);
  const updateConfig = useCustomAppearanceStore((state) => state.updateConfig);

  const [activeScope, setActiveScope] = useState<FontScope>("ui");
  const [loadStatus, setLoadStatus] = useState<LocalFontLoadStatus>("idle");
  const [localFonts, setLocalFonts] = useState<LocalFontEntry[]>([]);

  const loadLocalFonts = useCallback(async () => {
    setLoadStatus("loading");
    const result = await querySystemLocalFonts();
    setLoadStatus(result.status);
    setLocalFonts(result.fonts);
  }, []);

  useEffect(() => {
    void loadLocalFonts();
  }, [loadLocalFonts]);

  const allFamilies =
    localFonts.length > 0
      ? localFonts.map((f) => f.family)
      : Array.from(
          new Set([...FALLBACK_CJK_FONTS, ...FALLBACK_WESTERN_FONTS, ...FALLBACK_MONO_FONTS]),
        );

  const cjkOptions =
    localFonts.length > 0
      ? [
          ...localFonts.filter((f) => f.isLikelyCjk).map((f) => f.family),
          ...localFonts.filter((f) => !f.isLikelyCjk).map((f) => f.family),
        ]
      : FALLBACK_CJK_FONTS;

  const monoOptions =
    localFonts.length > 0
      ? [
          ...localFonts.filter((f) => f.isLikelyMono).map((f) => f.family),
          ...localFonts.filter((f) => !f.isLikelyMono).map((f) => f.family),
        ]
      : FALLBACK_MONO_FONTS;

  const previewUiStack = buildCssFontStack(
    fonts.ui.westernFamily,
    fonts.ui.cjkFamily,
    "system-ui, sans-serif",
  );
  const previewChatStack = buildCssFontStack(
    fonts.chat.westernFamily,
    fonts.chat.cjkFamily,
    previewUiStack,
  );
  const previewMonoStack = buildCssFontStack(
    fonts.mono.westernFamily,
    fonts.mono.cjkFamily,
    "ui-monospace, monospace",
  );

  const hasCustomScope = (scope: FontScope): boolean => {
    const target = fonts[scope];
    return Boolean(target.westernFamily || target.cjkFamily || target.weight !== 400);
  };

  const activeConfig = fonts[activeScope];
  const westernOptions = activeScope === "mono" ? monoOptions : allFamilies;
  const westernPlaceholder =
    activeScope === "mono"
      ? "如 JetBrains Mono、Cascadia Code"
      : activeScope === "chat"
        ? "如 Georgia、Inter"
        : "如 Segoe UI、Inter";
  const cjkPlaceholder =
    activeScope === "mono"
      ? "如 Sarasa Term SC、微软雅黑"
      : activeScope === "chat"
        ? "如 Sarasa UI SC、霞鹜文楷"
        : "如 Sarasa UI SC、微软雅黑";

  const updateActiveFont = (
    patch: Partial<{ westernFamily: string; cjkFamily: string; weight: number }>,
  ) => {
    updateConfig((prev) => ({
      ...prev,
      fonts: {
        ...prev.fonts,
        [activeScope]: {
          ...prev.fonts[activeScope],
          ...patch,
        },
      },
    }));
  };

  return (
    <Card className="overflow-hidden rounded-xl border border-border bg-card py-0 shadow-none">
      <CardContent className="space-y-0 px-0">
        {/* Header row */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-ui-base font-medium text-foreground">界面与代码字体</div>
            <div className="mt-0.5 text-ui-sm leading-5 text-foreground-subtle">
              独立搭配界面 UI、聊天正文与等宽代码的中英文字体、字重与行距。
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loadStatus === "loading"}
              onClick={() => void loadLocalFonts()}
            >
              <RefreshCw className={cn("size-3", loadStatus === "loading" && "animate-spin")} />
              {loadStatus === "ready"
                ? `${localFonts.length} 个本机字体`
                : loadStatus === "denied"
                  ? "授权读取字体"
                  : "扫描本机字体"}
            </Button>
            <Switch
              aria-label="启用独立字体设定"
              checked={fonts.enabled}
              onCheckedChange={(checked) =>
                updateConfig((prev) => ({
                  ...prev,
                  fonts: { ...prev.fonts, enabled: checked },
                }))
              }
            />
          </div>
        </div>

        {fonts.enabled ? (
          <>
            {/* Compact live typography preview strip */}
            <div className="border-t border-border bg-surface/50 px-4 py-3">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-ui-xs font-medium text-foreground-subtlest">
                  实时排版预览
                </span>
                <span className="font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                  {fonts.chat.fontSizePx}px · 行距 {fonts.chat.lineHeight.toFixed(2)} · W
                  {activeConfig.weight}
                </span>
              </div>
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2.5">
                <div
                  className="text-foreground"
                  style={{
                    fontFamily: activeScope === "ui" ? previewUiStack : previewChatStack,
                    fontSize: `${fonts.chat.fontSizePx}px`,
                    lineHeight: fonts.chat.lineHeight,
                    fontWeight: activeScope === "ui" ? fonts.ui.weight : fonts.chat.weight,
                  }}
                >
                  Aa Bb 字体预览 0123 · 中英混排清晰度与 <strong>粗体强调</strong> 效果
                </div>
                <div
                  className="truncate text-ui-sm text-foreground-subtle"
                  style={{
                    fontFamily: previewMonoStack,
                    fontWeight: fonts.mono.weight,
                  }}
                >
                  const pi = true; // 0O 1lI 等宽代码与路径预览
                </div>
              </div>
            </div>

            {/* Segmented font tier tabs + structured fields */}
            <div className="space-y-4 border-t border-border px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div
                  role="tablist"
                  aria-label="字体作用域"
                  className="inline-flex items-center rounded-lg border border-border bg-surface p-0.5"
                >
                  {FONT_SCOPE_TABS.map((tab) => {
                    const active = activeScope === tab.id;
                    const customized = hasCustomScope(tab.id);
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setActiveScope(tab.id)}
                        className={cn(
                          "inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-ui-xs font-medium transition-colors",
                          active
                            ? "bg-card text-foreground shadow-xs"
                            : "text-foreground-subtle hover:text-foreground",
                        )}
                      >
                        <span>{tab.label}</span>
                        {customized ? (
                          <span className="size-1.5 rounded-full bg-brand" aria-hidden="true" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                <span className="text-ui-xs text-foreground-subtlest">
                  {activeScope === "ui"
                    ? "应用于侧栏、导航、菜单与按钮"
                    : activeScope === "chat"
                      ? "应用于对话正文、气泡与输入框"
                      : "应用于代码块、路径与终端输出"}
                </span>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FontFamilyField
                  label={activeScope === "mono" ? "代码西文字体" : "西文 / 数字字体"}
                  value={activeConfig.westernFamily}
                  placeholder={westernPlaceholder}
                  options={westernOptions}
                  datalistId={`zcode-font-${activeScope}-west`}
                  onChange={(westernFamily) => updateActiveFont({ westernFamily })}
                />
                <FontFamilyField
                  label={activeScope === "mono" ? "代码中文搭配" : "中文字体"}
                  value={activeConfig.cjkFamily}
                  placeholder={cjkPlaceholder}
                  options={cjkOptions}
                  datalistId={`zcode-font-${activeScope}-cjk`}
                  onChange={(cjkFamily) => updateActiveFont({ cjkFamily })}
                />
              </div>

              <div className="space-y-1.5">
                <span className="text-ui-sm font-medium text-foreground">字重</span>
                <WeightSegmentPicker
                  value={activeConfig.weight}
                  onChange={(weight) => updateActiveFont({ weight })}
                />
              </div>

              {activeScope === "chat" ? (
                <div className="grid grid-cols-1 gap-4 border-t border-border pt-3.5 sm:grid-cols-2">
                  <AppearanceSlider
                    label="聊天正文字号"
                    valueLabel={`${fonts.chat.fontSizePx} px`}
                    min={12}
                    max={22}
                    step={1}
                    value={fonts.chat.fontSizePx}
                    onChange={(fontSizePx) =>
                      updateConfig((prev) => ({
                        ...prev,
                        fonts: { ...prev.fonts, chat: { ...prev.fonts.chat, fontSizePx } },
                      }))
                    }
                  />
                  <AppearanceSlider
                    label="聊天正文行距"
                    valueLabel={fonts.chat.lineHeight.toFixed(2)}
                    min={1.35}
                    max={2.1}
                    step={0.05}
                    value={fonts.chat.lineHeight}
                    onChange={(lineHeight) =>
                      updateConfig((prev) => ({
                        ...prev,
                        fonts: { ...prev.fonts, chat: { ...prev.fonts.chat, lineHeight } },
                      }))
                    }
                  />
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
