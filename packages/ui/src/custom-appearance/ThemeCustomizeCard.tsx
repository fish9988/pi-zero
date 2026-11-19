import { Check } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import type { Theme } from "@/useTheme.js";
import { AppearanceSectionHeader } from "./AppearancePrimitives.js";
import {
  BUILTIN_APPEARANCE_PRESETS,
  DEFAULT_DARK_COLORS,
  DEFAULT_LIGHT_COLORS,
} from "./presets.js";
import { useCustomAppearanceStore } from "./store.js";
import type {
  AppearancePreset,
  CustomBaseMode,
  CustomThemeColorOverrides,
  ThemeDesignLanguage,
} from "./types.js";

const FLAGSHIP_PRESET_IDS = new Set([
  "claude-code-desktop",
  "google-m3-expressive",
  "microsoft-fluent-2",
  "apple-liquid-glass",
]);

function resolveBadgeContrast(hex: string): string {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) return "#ffffff";
  const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.56 ? "#141413" : "#ffffff";
}

function getLanguageGeometry(language: ThemeDesignLanguage): {
  bubbleRadius: string;
  inputRadius: string;
  cardRadius: string;
  glassSheen: boolean;
  fluentFocusBar: boolean;
} {
  switch (language) {
    case "m3":
      return {
        bubbleRadius: "9999px",
        inputRadius: "9999px",
        cardRadius: "8px",
        glassSheen: false,
        fluentFocusBar: false,
      };
    case "fluent":
      return {
        bubbleRadius: "4px",
        inputRadius: "4px",
        cardRadius: "4px",
        glassSheen: false,
        fluentFocusBar: true,
      };
    case "liquid-glass":
      return {
        bubbleRadius: "9px",
        inputRadius: "10px",
        cardRadius: "8px",
        glassSheen: true,
        fluentFocusBar: false,
      };
    case "claude":
      return {
        bubbleRadius: "7px",
        inputRadius: "8px",
        cardRadius: "6px",
        glassSheen: false,
        fluentFocusBar: false,
      };
    default:
      return {
        bubbleRadius: "6px",
        inputRadius: "6px",
        cardRadius: "6px",
        glassSheen: false,
        fluentFocusBar: false,
      };
  }
}

function MiniWorkspacePreview({
  palette,
  designLanguage,
  resolvedMode,
  active,
}: {
  palette: CustomThemeColorOverrides;
  designLanguage: ThemeDesignLanguage;
  resolvedMode: CustomBaseMode;
  active: boolean;
}) {
  const geometry = getLanguageGeometry(designLanguage);
  const checkColor = resolveBadgeContrast(palette.brand);
  const sheenOverlay =
    geometry.glassSheen && resolvedMode === "dark"
      ? "linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 60%)"
      : geometry.glassSheen
        ? "linear-gradient(180deg, rgba(255,255,255,0.68) 0%, rgba(255,255,255,0) 60%)"
        : undefined;

  return (
    <div
      aria-hidden="true"
      className="relative flex h-24 w-full overflow-hidden rounded-lg border"
      style={{
        backgroundColor: palette.background,
        borderColor: palette.border,
      }}
    >
      {/* Mini sidebar */}
      <div
        className="flex h-full w-1/4 shrink-0 flex-col justify-between border-r p-2"
        style={{
          backgroundColor: palette.sidebar,
          borderColor: palette.border,
        }}
      >
        <div className="flex items-center gap-1">
          <span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: palette.brand, opacity: 0.9 }}
          />
          <span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: palette.foregroundSubtle, opacity: 0.35 }}
          />
          <span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: palette.foregroundSubtle, opacity: 0.35 }}
          />
        </div>
        <div className="space-y-1.5">
          <div
            className="h-1.5 w-full rounded-full"
            style={{ backgroundColor: palette.brand, opacity: 0.78 }}
          />
          <div
            className="h-1.5 w-4/5 rounded-full"
            style={{ backgroundColor: palette.foregroundSubtle, opacity: 0.32 }}
          />
          <div
            className="h-1.5 w-3/5 rounded-full"
            style={{ backgroundColor: palette.foregroundSubtle, opacity: 0.24 }}
          />
        </div>
        <div
          className="h-1.5 w-2/3 rounded-full"
          style={{ backgroundColor: palette.foregroundSubtle, opacity: 0.22 }}
        />
      </div>

      {/* Mini chat canvas */}
      <div className="flex min-w-0 flex-1 flex-col justify-between p-2">
        {/* User message bubble */}
        <div
          className="ml-auto flex items-center gap-1 border px-2 py-1"
          style={{
            backgroundColor: palette.userBubble,
            borderColor: designLanguage === "m3" ? "transparent" : palette.border,
            borderRadius: geometry.bubbleRadius,
            backgroundImage: sheenOverlay,
          }}
        >
          <span
            className="h-1 w-10 rounded-full"
            style={{ backgroundColor: palette.foreground, opacity: 0.72 }}
          />
        </div>

        {/* Assistant response & mini surface card */}
        <div className="space-y-1">
          <div
            className="h-1 w-4/5 rounded-full"
            style={{ backgroundColor: palette.foreground, opacity: 0.65 }}
          />
          <div
            className="flex items-center gap-1.5 border px-1.5 py-1"
            style={{
              backgroundColor: palette.card,
              borderColor: palette.border,
              borderRadius: geometry.cardRadius,
            }}
          >
            <span
              className="h-3 w-0.5 shrink-0 rounded-full"
              style={{ backgroundColor: palette.brand }}
            />
            <div className="min-w-0 flex-1 space-y-1">
              <div
                className="h-1 w-3/4 rounded-full"
                style={{ backgroundColor: palette.foreground, opacity: 0.55 }}
              />
              <div
                className="h-1 w-1/2 rounded-full"
                style={{ backgroundColor: palette.foregroundSubtle, opacity: 0.5 }}
              />
            </div>
          </div>
        </div>

        {/* Composer input bar */}
        <div
          className="flex items-center justify-between gap-2 border px-2 py-1"
          style={{
            backgroundColor: palette.input,
            borderColor: palette.border,
            borderBottomColor: geometry.fluentFocusBar ? palette.brand : palette.border,
            borderBottomWidth: geometry.fluentFocusBar ? "2px" : "1px",
            borderRadius: geometry.inputRadius,
            backgroundImage: sheenOverlay,
          }}
        >
          <span
            className="h-1 w-1/2 rounded-full"
            style={{ backgroundColor: palette.foregroundSubtle, opacity: 0.35 }}
          />
          <span
            className="h-2.5 w-4 shrink-0 rounded-full"
            style={{ backgroundColor: palette.brand }}
          />
        </div>
      </div>

      {/* Active checkmark badge */}
      {active ? (
        <span
          className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full shadow-xs"
          style={{ backgroundColor: palette.brand, color: checkColor }}
        >
          <Check className="size-3 stroke-[2.5]" />
        </span>
      ) : null}
    </div>
  );
}

function PresetPreviewCard({
  preset,
  active,
  resolvedMode,
  onSelect,
}: {
  preset: AppearancePreset;
  active: boolean;
  resolvedMode: CustomBaseMode;
  onSelect: () => void;
}) {
  const fallbackPalette = resolvedMode === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS;
  const patchPalette = resolvedMode === "dark" ? preset.patch.darkColors : preset.patch.lightColors;
  const palette: CustomThemeColorOverrides = { ...fallbackPalette, ...patchPalette };

  return (
    <button
      type="button"
      data-preset-id={preset.id}
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "group flex min-w-0 flex-col gap-2.5 rounded-xl border p-2.5 text-left transition-colors",
        active
          ? "border-brand bg-card ring-1 ring-brand/40"
          : "border-border bg-card hover:border-border-hover hover:bg-surface-hover",
      )}
    >
      <MiniWorkspacePreview
        palette={palette}
        designLanguage={preset.designLanguage}
        resolvedMode={resolvedMode}
        active={active}
      />

      <div className="min-w-0 space-y-1 px-0.5">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">{preset.name}</span>
          <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
            {preset.badge}
          </span>
        </div>
        <p className="truncate text-ui-sm text-foreground-subtle">{preset.description}</p>
      </div>
    </button>
  );
}

export function ThemeCustomizeCard({
  resolvedMode,
  onPresetApplied,
}: {
  resolvedMode: CustomBaseMode;
  setTheme?: (theme: Theme) => void;
  onPresetApplied?: (presetId: string) => void;
}) {
  const activePresetId = useCustomAppearanceStore((state) => state.config.activePresetId);
  const applyPreset = useCustomAppearanceStore((state) => state.applyPreset);

  const flagshipPresets = BUILTIN_APPEARANCE_PRESETS.filter((preset) =>
    FLAGSHIP_PRESET_IDS.has(preset.id),
  );
  const curatedPresets = BUILTIN_APPEARANCE_PRESETS.filter(
    (preset) => !FLAGSHIP_PRESET_IDS.has(preset.id),
  );

  const handleSelectPreset = (presetId: string) => {
    applyPreset(presetId);
    onPresetApplied?.(presetId);
  };

  return (
    <section className="min-w-0 space-y-4">
      <AppearanceSectionHeader
        title="主题与设计语言"
        description="即时预览当前明暗模式下的工作台质感，所有设计语言均原生适配浅色与深色双模式。"
        action={
          activePresetId === "custom" ? (
            <span className="rounded-md bg-accent px-2 py-0.5 text-ui-xs font-medium text-foreground">
              已自定义配色
            </span>
          ) : null
        }
      />

      <div className="space-y-4">
        <div className="space-y-2">
          <div className="text-ui-xs font-medium tracking-wide text-foreground-subtlest">
            旗舰设计语言
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {flagshipPresets.map((preset) => (
              <PresetPreviewCard
                key={preset.id}
                preset={preset}
                active={activePresetId === preset.id}
                resolvedMode={resolvedMode}
                onSelect={() => handleSelectPreset(preset.id)}
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-ui-xs font-medium tracking-wide text-foreground-subtlest">
            原生与精选配色
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {curatedPresets.map((preset) => (
              <PresetPreviewCard
                key={preset.id}
                preset={preset}
                active={activePresetId === preset.id}
                resolvedMode={resolvedMode}
                onSelect={() => handleSelectPreset(preset.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
