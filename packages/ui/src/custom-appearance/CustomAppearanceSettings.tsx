import { useEffect, useRef, useState } from "react";
import { Download, Moon, RotateCcw, Sun, Upload } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import type { Theme } from "@/useTheme.js";
import { AppearanceSectionHeader } from "./AppearancePrimitives.js";
import { ColorStudioCard } from "./ColorStudioCard.js";
import { FontCustomizeCard } from "./FontCustomizeCard.js";
import { CustomCssSection, ReadingLayoutSection } from "./LayoutAndCssCard.js";
import { useCustomAppearanceStore } from "./store.js";
import { ThemeCustomizeCard } from "./ThemeCustomizeCard.js";
import type { CustomBaseMode } from "./types.js";

export function CustomAppearanceSettings({
  resolvedMode,
  setTheme,
}: {
  resolvedMode: CustomBaseMode;
  setTheme: (theme: Theme) => void;
}) {
  const config = useCustomAppearanceStore((state) => state.config);
  const importConfigJson = useCustomAppearanceStore((state) => state.importConfigJson);
  const resetAll = useCustomAppearanceStore((state) => state.resetAll);

  const [editingMode, setEditingMode] = useState<CustomBaseMode>(resolvedMode);
  const [referencePresetId, setReferencePresetId] = useState<string>(
    config.activePresetId !== "custom" ? config.activePresetId : "zcode-native",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditingMode(resolvedMode);
  }, [resolvedMode]);

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `zcode-appearance-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast("已导出当前外观配置文件", { variant: "success" });
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      if (importConfigJson(text)) {
        toast("外观配置导入成功", { variant: "success" });
      } else {
        toast("配置文件格式不正确", { variant: "warning" });
      }
    } catch {
      toast("读取配置文件失败", { variant: "warning" });
    }
  };

  const handleModeSwitch = (mode: CustomBaseMode) => {
    setTheme(mode === "light" ? "zai-light" : "zai-dark");
    setEditingMode(mode);
  };

  return (
    <div className="min-w-0 space-y-8">
      {/* Header & Quick Mode Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <h2 className="text-ui-xl font-semibold tracking-tight text-foreground">
            外观与主题定制
          </h2>
          <p className="mt-0.5 text-ui-sm leading-5 text-foreground-subtle">
            定制工作台设计语言、字体排版、阅读宽度、语义配色与自定义样式表。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Segmented Light/Dark Switch */}
          <div
            role="group"
            aria-label="明暗模式"
            className="inline-flex items-center rounded-lg border border-border bg-surface p-0.5"
          >
            <button
              type="button"
              aria-pressed={resolvedMode === "light"}
              onClick={() => handleModeSwitch("light")}
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-ui-xs font-medium transition-colors",
                resolvedMode === "light"
                  ? "bg-card text-foreground shadow-xs"
                  : "text-foreground-subtle hover:text-foreground",
              )}
            >
              <Sun className="size-3.5" />
              浅色
            </button>
            <button
              type="button"
              aria-pressed={resolvedMode === "dark"}
              onClick={() => handleModeSwitch("dark")}
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-ui-xs font-medium transition-colors",
                resolvedMode === "dark"
                  ? "bg-card text-foreground shadow-xs"
                  : "text-foreground-subtle hover:text-foreground",
              )}
            >
              <Moon className="size-3.5" />
              深色
            </button>
          </div>

          <span className="hidden h-4 w-px bg-border sm:inline-block" aria-hidden="true" />

          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImportFile}
          />

          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="default"
              className="border border-transparent text-foreground-subtle hover:border-border hover:text-foreground"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="size-3.5" />
              导入
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="default"
              className="border border-transparent text-foreground-subtle hover:border-border hover:text-foreground"
              onClick={handleExport}
            >
              <Download className="size-3.5" />
              导出
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="default"
              className="border border-transparent text-foreground-subtle hover:border-border hover:text-foreground"
              onClick={() => {
                resetAll();
                setReferencePresetId("zcode-native");
                toast("已恢复默认外观设置", { variant: "info" });
              }}
            >
              <RotateCcw className="size-3.5" />
              还原
            </Button>
          </div>
        </div>
      </div>

      {/* Section 1: Visual Theme Gallery */}
      <ThemeCustomizeCard
        resolvedMode={resolvedMode}
        setTheme={setTheme}
        onPresetApplied={(presetId) => {
          setReferencePresetId(presetId);
          setEditingMode(resolvedMode);
        }}
      />

      {/* Section 2: Typography & Reading Width */}
      <section className="min-w-0 space-y-3">
        <AppearanceSectionHeader
          title="排版与布局"
          description="精细配置界面与代码字体栈，并按需调节对话阅读栏宽与卡片紧凑度。"
        />
        <div className="space-y-3">
          <FontCustomizeCard />
          <ReadingLayoutSection />
        </div>
      </section>

      {/* Section 3: Collapsible Color Studio & Wallpaper */}
      <ColorStudioCard
        editingMode={editingMode}
        onEditingModeChange={setEditingMode}
        referencePresetId={referencePresetId}
      />

      {/* Section 4: Collapsible Custom CSS Editor */}
      <CustomCssSection />
    </div>
  );
}
