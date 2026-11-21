export type LocalFontLoadStatus = "idle" | "loading" | "ready" | "denied" | "unsupported";

export interface LocalFontEntry {
  family: string;
  isLikelyCjk: boolean;
  isLikelyMono: boolean;
}

interface LocalFontDataLike {
  family: string;
}

const CJK_FONT_NAME_HINTS = [
  "sarasa",
  "更纱",
  "noto sans sc",
  "noto serif sc",
  "source han",
  "思源",
  "lxgw",
  "霞鹜",
  "yahei",
  "雅黑",
  "pingfang",
  "苹方",
  "kaiti",
  "楷体",
  "songti",
  "宋体",
  "simsun",
  "simhei",
  "黑体",
  "fangsong",
  "仿宋",
  "wenquanyi",
  "harmonyos",
  "mi sans",
  "misans",
  "alibaba",
  "oppo sans",
  "youyuan",
  "幼圆",
  "heiti",
  "hiragino",
  "yu gothic",
  "meiryo",
];

const MONO_FONT_NAME_HINTS = [
  "mono",
  "code",
  "consolas",
  "courier",
  "cascadia",
  "jetbrains",
  "fira",
  "hack",
  "menlo",
  "monaco",
  "iosevka",
  "inconsolata",
  "victor",
  "sarasa term",
  "sarasa mono",
  "等宽",
];

export const FALLBACK_WESTERN_FONTS = [
  "Segoe UI",
  "Inter",
  "Roboto",
  "Georgia",
  "Calibri",
  "Arial",
  "Helvetica Neue",
  "Times New Roman",
];

export const FALLBACK_CJK_FONTS = [
  "Sarasa UI SC",
  "Sarasa Gothic SC",
  "Microsoft YaHei UI",
  "Microsoft YaHei",
  "LXGW WenKai",
  "Source Han Sans SC",
  "Source Han Serif SC",
  "PingFang SC",
  "Noto Sans CJK SC",
  "SimSun",
];

export const FALLBACK_MONO_FONTS = [
  "Sarasa Term SC",
  "Sarasa Mono SC",
  "Cascadia Code",
  "Cascadia Mono",
  "JetBrains Mono",
  "Fira Code",
  "Consolas",
  "Menlo",
  "Monaco",
];

function classifyFont(family: string): LocalFontEntry {
  const lower = family.toLowerCase();
  const hasCjkChar = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(family);
  const isLikelyCjk = hasCjkChar || CJK_FONT_NAME_HINTS.some((hint) => lower.includes(hint));
  const isLikelyMono = MONO_FONT_NAME_HINTS.some((hint) => lower.includes(hint));
  return { family, isLikelyCjk, isLikelyMono };
}

function buildFallbackEntries(): LocalFontEntry[] {
  const seen = new Set<string>();
  const all = [...FALLBACK_CJK_FONTS, ...FALLBACK_WESTERN_FONTS, ...FALLBACK_MONO_FONTS];
  const entries: LocalFontEntry[] = [];
  for (const family of all) {
    if (!seen.has(family)) {
      seen.add(family);
      entries.push(classifyFont(family));
    }
  }
  return entries;
}

export async function querySystemLocalFonts(): Promise<{
  status: LocalFontLoadStatus;
  fonts: LocalFontEntry[];
}> {
  const win = window as Window & {
    queryLocalFonts?: () => Promise<LocalFontDataLike[]>;
  };
  if (typeof win.queryLocalFonts !== "function") {
    return { status: "unsupported", fonts: buildFallbackEntries() };
  }

  try {
    const rawFonts = await win.queryLocalFonts();
    const families = new Set<string>();
    for (const item of rawFonts) {
      const name = item?.family?.trim();
      if (name) families.add(name);
    }

    if (families.size === 0) {
      return { status: "denied", fonts: buildFallbackEntries() };
    }

    const entries = Array.from(families)
      .map(classifyFont)
      .sort((a, b) => a.family.localeCompare(b.family, "zh-Hans-CN"));

    return { status: "ready", fonts: entries };
  } catch {
    return { status: "denied", fonts: buildFallbackEntries() };
  }
}

/** 仅覆盖西文/数字/常用符号，显式排除 CJK 汉字与中文标点，确保西文字体绝不劫持中文字体。 */
export const WESTERN_UNICODE_RANGE =
  "U+0000-00FF, U+0100-024F, U+0250-02AF, U+0370-03FF, U+2000-206F, U+2070-209F, U+20A0-20CF, U+2100-218F, U+2190-21FF, U+2200-22FF, U+2500-257F";

function escapeCssFontName(name: string): string {
  return name.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function quoteCssFontFamily(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (/^[a-z-]+$/i.test(trimmed)) return trimmed;
  return `"${escapeCssFontName(trimmed)}"`;
}

export function buildCssFontStack(
  westernFamily: string,
  cjkFamily: string,
  fallbackStack: string,
): string {
  const parts: string[] = [];
  const west = quoteCssFontFamily(westernFamily);
  const cjk = quoteCssFontFamily(cjkFamily);
  if (west) parts.push(west);
  if (cjk && cjk !== west) parts.push(cjk);
  parts.push(fallbackStack);
  return parts.join(", ");
}

/**
 * 为「西文字体 + 中文字体」生成真正互不干扰的双语字体规则：
 * - 当同时指定了不同的西文字体与中文字体时，通过 `@font-face` + `unicode-range` 将西文字体严格限定在拉丁/数字/符号区间；
 * - 即使所选西文字体本身包含中文字形（如更纱、思源、微软雅黑等），汉字也会强制跳过它并命中中文字体。
 */
export function buildDualScriptFontCss(
  aliasName: string,
  westernFamily: string,
  cjkFamily: string,
  fallbackStack: string,
): { readonly fontFacesCss: string; readonly stack: string } {
  const westTrimmed = westernFamily.trim();
  const cjkTrimmed = cjkFamily.trim();
  if (!westTrimmed || !cjkTrimmed || westTrimmed === cjkTrimmed) {
    return {
      fontFacesCss: "",
      stack: buildCssFontStack(westTrimmed, cjkTrimmed, fallbackStack),
    };
  }
  const escaped = escapeCssFontName(westTrimmed);
  const alias = `"${escapeCssFontName(aliasName)}"`;
  const fontFacesCss = [
    `@font-face {\n  font-family: ${alias};\n  src: local("${escaped}");\n  font-weight: 100 599;\n  font-style: normal;\n  unicode-range: ${WESTERN_UNICODE_RANGE};\n}`,
    `@font-face {\n  font-family: ${alias};\n  src: local("${escaped} Bold"), local("${escaped}-Bold"), local("${escaped} SemiBold"), local("${escaped}");\n  font-weight: 600 900;\n  font-style: normal;\n  unicode-range: ${WESTERN_UNICODE_RANGE};\n}`,
    `@font-face {\n  font-family: ${alias};\n  src: local("${escaped} Italic"), local("${escaped}-Italic"), local("${escaped}");\n  font-weight: 100 599;\n  font-style: italic;\n  unicode-range: ${WESTERN_UNICODE_RANGE};\n}`,
    `@font-face {\n  font-family: ${alias};\n  src: local("${escaped} Bold Italic"), local("${escaped}-BoldItalic"), local("${escaped} Bold"), local("${escaped}");\n  font-weight: 600 900;\n  font-style: italic;\n  unicode-range: ${WESTERN_UNICODE_RANGE};\n}`,
  ].join("\n");
  const stack = [alias, quoteCssFontFamily(cjkTrimmed), fallbackStack].filter(Boolean).join(", ");
  return { fontFacesCss, stack };
}
