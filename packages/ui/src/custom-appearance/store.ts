import { create } from "zustand";
import {
  BUILTIN_APPEARANCE_PRESETS,
  DEFAULT_CUSTOM_APPEARANCE_CONFIG,
  DEFAULT_DARK_COLORS,
  DEFAULT_LIGHT_COLORS,
} from "./presets.js";
import type {
  CustomAppearanceConfig,
  CustomBaseMode,
  CustomThemeColorOverrides,
  ThemeDesignLanguage,
} from "./types.js";

const STORAGE_KEY = "zcode-custom-appearance-v1";
export const CHAT_WIDTH_MIN_PX = 640;
export const CHAT_WIDTH_MAX_PX = 1680;
export const CHAT_WIDTH_DEFAULT_PX = 960;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeColors(
  raw: unknown,
  fallback: CustomThemeColorOverrides,
): CustomThemeColorOverrides {
  if (!isRecord(raw)) return { ...fallback };
  const brand = readString(raw.brand, fallback.brand);
  const foreground = readString(raw.foreground, fallback.foreground);
  const foregroundSubtle = readString(raw.foregroundSubtle, fallback.foregroundSubtle);
  return {
    background: readString(raw.background, fallback.background),
    sidebar: readString(raw.sidebar, fallback.sidebar),
    card: readString(raw.card, fallback.card),
    input: readString(raw.input, fallback.input),
    userBubble: readString(raw.userBubble, fallback.userBubble),
    brand,
    foreground,
    foregroundSubtle,
    border: readString(raw.border, fallback.border),
    markdownHeading: readString(raw.markdownHeading, fallback.markdownHeading || foreground),
    markdownStrong: readString(raw.markdownStrong, fallback.markdownStrong || foreground),
    markdownLink: readString(raw.markdownLink, brand || fallback.markdownLink),
    markdownCodeText: readString(raw.markdownCodeText, fallback.markdownCodeText),
    markdownCodeBg: readString(raw.markdownCodeBg, fallback.markdownCodeBg),
    markdownQuote: readString(raw.markdownQuote, foregroundSubtle || fallback.markdownQuote),
  };
}

export function normalizeCustomAppearanceConfig(raw: unknown): CustomAppearanceConfig {
  const def = DEFAULT_CUSTOM_APPEARANCE_CONFIG;
  if (!isRecord(raw)) return structuredClone(def);

  const rawWallpaper = isRecord(raw.wallpaper) ? raw.wallpaper : {};
  const rawFonts = isRecord(raw.fonts) ? raw.fonts : {};
  const rawUiFont = isRecord(rawFonts.ui) ? rawFonts.ui : {};
  const rawChatFont = isRecord(rawFonts.chat) ? rawFonts.chat : {};
  const rawMonoFont = isRecord(rawFonts.mono) ? rawFonts.mono : {};
  const rawLayout = isRecord(raw.layout) ? raw.layout : {};
  const rawCss = isRecord(raw.customCss) ? raw.customCss : {};

  const chatMaxWidthPx =
    rawLayout.chatMaxWidthPx === null
      ? null
      : typeof rawLayout.chatMaxWidthPx === "number" && Number.isFinite(rawLayout.chatMaxWidthPx)
        ? Math.round(
            Math.min(CHAT_WIDTH_MAX_PX, Math.max(CHAT_WIDTH_MIN_PX, rawLayout.chatMaxWidthPx)),
          )
        : def.layout.chatMaxWidthPx;

  const designLanguage: ThemeDesignLanguage =
    raw.designLanguage === "claude" ||
    raw.designLanguage === "m3" ||
    raw.designLanguage === "fluent" ||
    raw.designLanguage === "liquid-glass"
      ? raw.designLanguage
      : "default";

  return {
    version: 1,
    activePresetId: readString(raw.activePresetId, def.activePresetId),
    designLanguage,
    enableCustomColors: readBoolean(raw.enableCustomColors, def.enableCustomColors),
    lightColors: normalizeColors(raw.lightColors, DEFAULT_LIGHT_COLORS),
    darkColors: normalizeColors(raw.darkColors, DEFAULT_DARK_COLORS),
    wallpaper: {
      enabled: readBoolean(rawWallpaper.enabled, def.wallpaper.enabled),
      imageUrl: readString(rawWallpaper.imageUrl, def.wallpaper.imageUrl),
      blurPx: readNumber(rawWallpaper.blurPx, def.wallpaper.blurPx, 0, 40),
      overlayOpacity: readNumber(
        rawWallpaper.overlayOpacity,
        def.wallpaper.overlayOpacity,
        0.2,
        0.96,
      ),
      surfaceOpacity: readNumber(
        rawWallpaper.surfaceOpacity,
        def.wallpaper.surfaceOpacity,
        0.45,
        1,
      ),
    },
    fonts: {
      enabled: readBoolean(rawFonts.enabled, def.fonts.enabled),
      ui: {
        westernFamily: readString(rawUiFont.westernFamily, def.fonts.ui.westernFamily),
        cjkFamily: readString(rawUiFont.cjkFamily, def.fonts.ui.cjkFamily),
        weight: readNumber(rawUiFont.weight, def.fonts.ui.weight, 300, 800),
      },
      chat: {
        westernFamily: readString(rawChatFont.westernFamily, def.fonts.chat.westernFamily),
        cjkFamily: readString(rawChatFont.cjkFamily, def.fonts.chat.cjkFamily),
        weight: readNumber(rawChatFont.weight, def.fonts.chat.weight, 300, 800),
        fontSizePx: readNumber(rawChatFont.fontSizePx, def.fonts.chat.fontSizePx, 12, 22),
        lineHeight: readNumber(rawChatFont.lineHeight, def.fonts.chat.lineHeight, 1.3, 2.2),
      },
      mono: {
        westernFamily: readString(rawMonoFont.westernFamily, def.fonts.mono.westernFamily),
        cjkFamily: readString(rawMonoFont.cjkFamily, def.fonts.mono.cjkFamily),
        weight: readNumber(rawMonoFont.weight, def.fonts.mono.weight, 300, 800),
      },
    },
    layout: {
      chatMaxWidthPx,
      enableResizeHandle: readBoolean(rawLayout.enableResizeHandle, def.layout.enableResizeHandle),
      wideCodeBlocks: readBoolean(rawLayout.wideCodeBlocks, def.layout.wideCodeBlocks),
      compactProcessCards: readBoolean(
        rawLayout.compactProcessCards,
        def.layout.compactProcessCards,
      ),
    },
    customCss: {
      enabled: readBoolean(rawCss.enabled, def.customCss.enabled),
      code: readString(rawCss.code, def.customCss.code),
    },
  };
}

function readInitialConfig(): CustomAppearanceConfig {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return structuredClone(DEFAULT_CUSTOM_APPEARANCE_CONFIG);
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_CUSTOM_APPEARANCE_CONFIG);
    return normalizeCustomAppearanceConfig(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_CUSTOM_APPEARANCE_CONFIG);
  }
}

function detectInitialSafeMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("safemode") === "1";
  } catch {
    return false;
  }
}

function persistConfig(config: CustomAppearanceConfig): void {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // 忽略配额或隐私模式下的写入异常
  }
}

interface CustomAppearanceState {
  config: CustomAppearanceConfig;
  safeModeActive: boolean;
  updateConfig: (updater: (prev: CustomAppearanceConfig) => CustomAppearanceConfig) => void;
  setColor: (mode: CustomBaseMode, key: keyof CustomThemeColorOverrides, value: string) => void;
  applyPreset: (presetId: string) => CustomBaseMode | null;
  setChatMaxWidthPx: (widthPx: number | null) => void;
  toggleSafeMode: (force?: boolean) => void;
  importConfigJson: (jsonText: string) => boolean;
  resetAll: () => void;
  syncFromStorage: () => void;
}

export const useCustomAppearanceStore = create<CustomAppearanceState>((set, get) => ({
  config: readInitialConfig(),
  safeModeActive: detectInitialSafeMode(),

  updateConfig: (updater) => {
    const next = normalizeCustomAppearanceConfig(updater(get().config));
    persistConfig(next);
    set({ config: next });
  },

  setColor: (mode, key, value) => {
    get().updateConfig((prev) => ({
      ...prev,
      activePresetId: "custom",
      enableCustomColors: true,
      lightColors: mode === "light" ? { ...prev.lightColors, [key]: value } : prev.lightColors,
      darkColors: mode === "dark" ? { ...prev.darkColors, [key]: value } : prev.darkColors,
    }));
  },

  applyPreset: (presetId) => {
    const preset = BUILTIN_APPEARANCE_PRESETS.find((item) => item.id === presetId);
    if (!preset) return null;
    get().updateConfig((prev) => ({
      ...prev,
      activePresetId: preset.id,
      designLanguage: preset.designLanguage,
      enableCustomColors: preset.patch.enableCustomColors,
      lightColors: preset.patch.lightColors
        ? { ...prev.lightColors, ...preset.patch.lightColors }
        : prev.lightColors,
      darkColors: preset.patch.darkColors
        ? { ...prev.darkColors, ...preset.patch.darkColors }
        : prev.darkColors,
      layout: preset.patch.layout ? { ...prev.layout, ...preset.patch.layout } : prev.layout,
    }));
    return preset.recommendedMode;
  },

  setChatMaxWidthPx: (widthPx) => {
    get().updateConfig((prev) => ({
      ...prev,
      layout: {
        ...prev.layout,
        chatMaxWidthPx:
          widthPx === null
            ? null
            : Math.round(Math.min(CHAT_WIDTH_MAX_PX, Math.max(CHAT_WIDTH_MIN_PX, widthPx))),
      },
    }));
  },

  toggleSafeMode: (force) => {
    set((state) => ({
      safeModeActive: force !== undefined ? force : !state.safeModeActive,
    }));
  },

  importConfigJson: (jsonText) => {
    try {
      const parsed: unknown = JSON.parse(jsonText);
      const next = normalizeCustomAppearanceConfig(parsed);
      persistConfig(next);
      set({ config: next });
      return true;
    } catch {
      return false;
    }
  },

  resetAll: () => {
    const fresh = structuredClone(DEFAULT_CUSTOM_APPEARANCE_CONFIG);
    persistConfig(fresh);
    set({ config: fresh, safeModeActive: false });
  },

  syncFromStorage: () => {
    set({ config: readInitialConfig() });
  },
}));
