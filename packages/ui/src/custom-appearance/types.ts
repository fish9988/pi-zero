export type CustomBaseMode = "light" | "dark";
export type ThemeDesignLanguage = "default" | "claude" | "m3" | "fluent" | "liquid-glass";

export interface CustomThemeColorOverrides {
  background: string;
  sidebar: string;
  card: string;
  input: string;
  userBubble: string;
  brand: string;
  foreground: string;
  foregroundSubtle: string;
  border: string;
  /** 聊天 Markdown 语义层级色 */
  markdownHeading: string;
  markdownStrong: string;
  markdownLink: string;
  markdownCodeText: string;
  markdownCodeBg: string;
  markdownQuote: string;
}

export interface CustomWallpaperConfig {
  enabled: boolean;
  imageUrl: string;
  blurPx: number;
  overlayOpacity: number;
  surfaceOpacity: number;
}

export type ChatStrongWeight = "auto" | 600 | 700;

export interface FontPairConfig {
  westernFamily: string;
  cjkFamily: string;
  weight: number;
}

export interface CustomFontsConfig {
  enabled: boolean;
  ui: FontPairConfig;
  chat: FontPairConfig & {
    strongWeight: ChatStrongWeight;
    fontSizePx: number;
    lineHeight: number;
  };
  mono: FontPairConfig;
}

export interface FontPairingPreset {
  id: string;
  name: string;
  badge: string;
  description: string;
  ui: {
    westernCandidates: string[];
    cjkCandidates: string[];
    weight: number;
  };
  chat: {
    westernCandidates: string[];
    cjkCandidates: string[];
    weight: number;
    strongWeight: ChatStrongWeight;
    fontSizePx: number;
    lineHeight: number;
  };
  mono: {
    westernCandidates: string[];
    cjkCandidates: string[];
    weight: number;
  };
}

export interface CustomLayoutConfig {
  /** null 表示跟随 ZCode 原生响应式断点宽度 */
  chatMaxWidthPx: number | null;
  enableResizeHandle: boolean;
  /** 宽屏时普通文字维持舒适阅读行宽，代码块/表格/工具卡吃满聊天栏宽度 */
  wideCodeBlocks: boolean;
  /** 思考块与工具调用卡片采用更省空间的紧凑排版 */
  compactProcessCards: boolean;
}

export interface CustomCssConfig {
  enabled: boolean;
  code: string;
}

export interface CustomAppearanceConfig {
  version: 1;
  activePresetId: string;
  designLanguage: ThemeDesignLanguage;
  enableCustomColors: boolean;
  lightColors: CustomThemeColorOverrides;
  darkColors: CustomThemeColorOverrides;
  wallpaper: CustomWallpaperConfig;
  fonts: CustomFontsConfig;
  layout: CustomLayoutConfig;
  customCss: CustomCssConfig;
}

export interface AppearancePreset {
  id: string;
  name: string;
  badge: string;
  description: string;
  designLanguage: ThemeDesignLanguage;
  recommendedMode: CustomBaseMode;
  patch: {
    enableCustomColors: boolean;
    lightColors?: Partial<CustomThemeColorOverrides>;
    darkColors?: Partial<CustomThemeColorOverrides>;
    layout?: Partial<CustomLayoutConfig>;
    customCss?: Partial<CustomCssConfig>;
  };
}
