import { useRef, useState } from "react";
import { ChevronDown, ChevronUp, Image, Moon, RotateCcw, Sun } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import {
  AppearanceSectionHeader,
  AppearanceSettingRow,
  AppearanceSlider,
} from "./AppearancePrimitives.js";
import {
  BUILTIN_APPEARANCE_PRESETS,
  DEFAULT_DARK_COLORS,
  DEFAULT_LIGHT_COLORS,
} from "./presets.js";
import { useCustomAppearanceStore } from "./store.js";
import type { CustomBaseMode, CustomThemeColorOverrides } from "./types.js";

const COLOR_GROUPS: Array<{
  id: string;
  title: string;
  fields: Array<{
    key: keyof CustomThemeColorOverrides;
    label: string;
  }>;
}> = [
  {
    id: "canvas",
    title: "画布与层级",
    fields: [
      { key: "background", label: "主界面底色" },
      { key: "sidebar", label: "左侧栏底色" },
      { key: "card", label: "卡片与面板" },
    ],
  },
  {
    id: "chat",
    title: "对话与强调",
    fields: [
      { key: "input", label: "输入框底色" },
      { key: "userBubble", label: "用户气泡" },
      { key: "brand", label: "主强调色" },
    ],
  },
  {
    id: "typography",
    title: "文字与边框",
    fields: [
      { key: "foreground", label: "主要文字" },
      { key: "foregroundSubtle", label: "次要文字" },
      { key: "border", label: "分割与边框" },
    ],
  },
  {
    id: "markdown",
    title: "聊天输出层级",
    fields: [
      { key: "markdownHeading", label: "标题文字 (H1–H6)" },
      { key: "markdownStrong", label: "加粗强调" },
      { key: "markdownLink", label: "超链接色" },
      { key: "markdownCodeText", label: "行内代码字色" },
      { key: "markdownCodeBg", label: "行内代码底色" },
      { key: "markdownQuote", label: "引用与列表标记" },
    ],
  },
];

function resolveReferencePalette(
  presetId: string,
  mode: CustomBaseMode,
): CustomThemeColorOverrides {
  const base = mode === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS;
  const preset = BUILTIN_APPEARANCE_PRESETS.find((item) => item.id === presetId);
  const patch = mode === "dark" ? preset?.patch.darkColors : preset?.patch.lightColors;
  return { ...base, ...patch };
}

function normalizeHexInput(value: string): string {
  return value.startsWith("#") && value.length === 7 ? value : "#38bdf8";
}

export function ColorStudioCard({
  editingMode,
  onEditingModeChange,
  referencePresetId,
}: {
  editingMode: CustomBaseMode;
  onEditingModeChange: (mode: CustomBaseMode) => void;
  referencePresetId: string;
}) {
  const config = useCustomAppearanceStore((state) => state.config);
  const updateConfig = useCustomAppearanceStore((state) => state.updateConfig);
  const setColor = useCustomAppearanceStore((state) => state.setColor);

  const [paletteExpanded, setPaletteExpanded] = useState(true);
  const wallpaperInputRef = useRef<HTMLInputElement>(null);

  const activePalette = editingMode === "dark" ? config.darkColors : config.lightColors;
  const referencePalette = resolveReferencePalette(referencePresetId, editingMode);

  const previewSwatches = [
    activePalette.background,
    activePalette.sidebar,
    activePalette.userBubble,
    activePalette.brand,
  ];

  const handleWallpaperFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      toast("图片太大了，建议选 4MB 以内的壁纸以免卡顿", { variant: "warning" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        updateConfig((prev) => ({
          ...prev,
          wallpaper: {
            ...prev.wallpaper,
            enabled: true,
            imageUrl: reader.result as string,
          },
        }));
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <section className="min-w-0 space-y-3">
      <AppearanceSectionHeader
        title="配色微调"
        description="按语义分层精细调整浅色与深色两套配色令牌，或叠加半透明背景壁纸。"
      />

      <Card className="overflow-hidden rounded-xl border border-border bg-card py-0 shadow-none">
        <CardContent className="space-y-0 px-0">
          {/* Master switch + scheme selector header */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-ui-base font-medium text-foreground">启用自定义颜色</span>
                  {config.enableCustomColors ? (
                    <span className="flex items-center gap-1" aria-hidden="true">
                      {previewSwatches.map((hex, idx) => (
                        <span
                          key={idx}
                          className="size-2.5 rounded-full border border-border"
                          style={{ backgroundColor: hex }}
                        />
                      ))}
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-ui-sm leading-5 text-foreground-subtle">
                  {config.enableCustomColors
                    ? `正在覆盖${editingMode === "light" ? "浅色" : "深色"}模式令牌，支持单项还原`
                    : "关闭时完全沿用官方默认浅色与深色配色"}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {config.enableCustomColors ? (
                <>
                  <div
                    role="group"
                    aria-label="编辑配色方案"
                    className="inline-flex items-center rounded-lg border border-border bg-surface p-0.5"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onEditingModeChange("light");
                        setPaletteExpanded(true);
                      }}
                      className={cn(
                        "inline-flex h-6 items-center gap-1 rounded-md px-2 text-ui-xs font-medium transition-colors",
                        editingMode === "light"
                          ? "bg-card text-foreground shadow-xs"
                          : "text-foreground-subtle hover:text-foreground",
                      )}
                    >
                      <Sun className="size-3" />
                      浅色方案
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onEditingModeChange("dark");
                        setPaletteExpanded(true);
                      }}
                      className={cn(
                        "inline-flex h-6 items-center gap-1 rounded-md px-2 text-ui-xs font-medium transition-colors",
                        editingMode === "dark"
                          ? "bg-card text-foreground shadow-xs"
                          : "text-foreground-subtle hover:text-foreground",
                      )}
                    >
                      <Moon className="size-3" />
                      深色方案
                    </button>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={paletteExpanded ? "收起配色面板" : "展开配色面板"}
                    aria-expanded={paletteExpanded}
                    onClick={() => setPaletteExpanded((prev) => !prev)}
                  >
                    {paletteExpanded ? (
                      <ChevronUp className="size-3.5 text-foreground-subtle" />
                    ) : (
                      <ChevronDown className="size-3.5 text-foreground-subtle" />
                    )}
                  </Button>
                </>
              ) : null}

              <Switch
                aria-label="启用自定义颜色"
                checked={config.enableCustomColors}
                onCheckedChange={(checked) => {
                  updateConfig((prev) => ({
                    ...prev,
                    enableCustomColors: checked,
                  }));
                  if (checked) {
                    setPaletteExpanded(true);
                  }
                }}
              />
            </div>
          </div>

          {/* 3 Semantic Color Sub-Groups */}
          {config.enableCustomColors && paletteExpanded ? (
            <div className="border-t border-border bg-surface/40 p-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {COLOR_GROUPS.map((group) => (
                  <div
                    key={group.id}
                    className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
                  >
                    <div className="border-b border-border bg-surface/60 px-3 py-1.5 text-ui-xs font-medium text-foreground-subtle">
                      {group.title}
                    </div>
                    <div className="divide-y divide-border">
                      {group.fields.map((field) => {
                        const value = activePalette[field.key];
                        const defaultValue = referencePalette[field.key];
                        const isModified = value.toLowerCase() !== defaultValue.toLowerCase();
                        return (
                          <div
                            key={field.key}
                            className="flex items-center justify-between gap-2 px-3 py-2 transition-colors hover:bg-hover"
                          >
                            <label className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2">
                              <span className="flex min-w-0 items-center gap-2.5">
                                <span
                                  className="relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border shadow-xs transition-colors hover:border-border-hover"
                                  style={{ backgroundColor: value }}
                                >
                                  <input
                                    type="color"
                                    aria-label={`${field.label}颜色`}
                                    value={normalizeHexInput(value)}
                                    onChange={(event) =>
                                      setColor(editingMode, field.key, event.currentTarget.value)
                                    }
                                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                                  />
                                </span>
                                <span className="truncate text-ui-sm font-medium text-foreground">
                                  {field.label}
                                </span>
                              </span>
                              <span className="shrink-0 font-mono text-ui-xs uppercase tabular-nums text-foreground-subtle">
                                {value}
                              </span>
                            </label>

                            {isModified ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                title={`还原为 ${defaultValue}`}
                                aria-label={`还原${field.label}`}
                                onClick={() => setColor(editingMode, field.key, defaultValue)}
                              >
                                <RotateCcw className="size-3 text-foreground-subtle" />
                              </Button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Background Wallpaper & Translucent Glass */}
          <AppearanceSettingRow
            label={
              <span className="inline-flex items-center gap-1.5">
                <Image className="size-3.5 text-foreground-subtle" />
                背景壁纸与毛玻璃层
              </span>
            }
            description="将图片铺在窗口底层，工作台面板与侧栏以半透明质感透出背景。"
            control={
              <Switch
                aria-label="启用背景壁纸与毛玻璃层"
                checked={config.wallpaper.enabled}
                onCheckedChange={(checked) =>
                  updateConfig((prev) => ({
                    ...prev,
                    wallpaper: { ...prev.wallpaper, enabled: checked },
                  }))
                }
              />
            }
          />

          {config.wallpaper.enabled ? (
            <div className="space-y-4 border-t border-border bg-surface/40 px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={wallpaperInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleWallpaperFile}
                />
                <Input
                  value={
                    config.wallpaper.imageUrl.startsWith("data:")
                      ? "(已选择本地图片)"
                      : config.wallpaper.imageUrl
                  }
                  placeholder="粘贴图片链接，或点击右侧选择本地图片"
                  onChange={(event) => {
                    const nextUrl = event.currentTarget.value;
                    updateConfig((prev) => ({
                      ...prev,
                      wallpaper: { ...prev.wallpaper, imageUrl: nextUrl },
                    }));
                  }}
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  onClick={() => wallpaperInputRef.current?.click()}
                >
                  选择图片
                </Button>
                {config.wallpaper.imageUrl ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="default"
                    onClick={() =>
                      updateConfig((prev) => ({
                        ...prev,
                        wallpaper: { ...prev.wallpaper, imageUrl: "" },
                      }))
                    }
                  >
                    清除
                  </Button>
                ) : null}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <AppearanceSlider
                  label="背景模糊度"
                  valueLabel={`${config.wallpaper.blurPx}px`}
                  min={0}
                  max={40}
                  step={1}
                  value={config.wallpaper.blurPx}
                  onChange={(blurPx) =>
                    updateConfig((prev) => ({
                      ...prev,
                      wallpaper: { ...prev.wallpaper, blurPx },
                    }))
                  }
                />
                <AppearanceSlider
                  label="护眼遮罩浓度"
                  valueLabel={`${Math.round(config.wallpaper.overlayOpacity * 100)}%`}
                  min={0.25}
                  max={0.95}
                  step={0.05}
                  value={config.wallpaper.overlayOpacity}
                  onChange={(overlayOpacity) =>
                    updateConfig((prev) => ({
                      ...prev,
                      wallpaper: { ...prev.wallpaper, overlayOpacity },
                    }))
                  }
                />
                <AppearanceSlider
                  label="面板不透明度"
                  valueLabel={`${Math.round(config.wallpaper.surfaceOpacity * 100)}%`}
                  min={0.5}
                  max={1}
                  step={0.05}
                  value={config.wallpaper.surfaceOpacity}
                  onChange={(surfaceOpacity) =>
                    updateConfig((prev) => ({
                      ...prev,
                      wallpaper: { ...prev.wallpaper, surfaceOpacity },
                    }))
                  }
                />
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
