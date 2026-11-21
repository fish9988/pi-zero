export type LocalFontLoadStatus = "idle" | "loading" | "ready" | "denied" | "unsupported";

export interface LocalFontFaceMeta {
  fullName: string;
  postscriptName: string;
  style: string;
}

export interface LocalFontEntry {
  family: string;
  isLikelyCjk: boolean;
  isLikelyMono: boolean;
  faces?: readonly LocalFontFaceMeta[];
}

interface LocalFontDataLike {
  family: string;
  fullName?: string;
  postscriptName?: string;
  style?: string;
}

const scannedFaceCache = new Map<string, LocalFontFaceMeta[]>();

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
    const families = new Map<string, LocalFontFaceMeta[]>();
    for (const item of rawFonts) {
      const name = item?.family?.trim();
      if (!name) continue;
      const list = families.get(name) ?? [];
      const fullName = item.fullName?.trim() ?? "";
      const postscriptName = item.postscriptName?.trim() ?? "";
      const style = item.style?.trim() ?? "";
      if (fullName || postscriptName) {
        list.push({ fullName, postscriptName, style });
      }
      families.set(name, list);
    }

    if (families.size === 0) {
      return { status: "denied", fonts: buildFallbackEntries() };
    }

    scannedFaceCache.clear();
    for (const [family, faces] of families) {
      if (faces.length > 0) {
        scannedFaceCache.set(family.toLowerCase(), faces);
      }
    }

    const entries = Array.from(families.entries())
      .map(([family, faces]) => ({
        ...classifyFont(family),
        ...(faces.length > 0 ? { faces } : {}),
      }))
      .sort((a, b) => a.family.localeCompare(b.family, "zh-Hans-CN"));

    return { status: "ready", fonts: entries };
  } catch {
    return { status: "denied", fonts: buildFallbackEntries() };
  }
}

/** 根据已扫描的本机字体列表按优先级选择首个可用候选；未扫描时返回首选候选。 */
export function resolveFontCandidate(
  candidates: readonly string[],
  availableFamilies: readonly string[],
): string {
  if (candidates.length === 0) return "";
  if (availableFamilies.length === 0) return candidates[0] ?? "";
  const availableByLower = new Map<string, string>();
  for (const family of availableFamilies) {
    const key = family.trim().toLowerCase();
    if (key && !availableByLower.has(key)) {
      availableByLower.set(key, family.trim());
    }
  }
  for (const candidate of candidates) {
    const matched = availableByLower.get(candidate.trim().toLowerCase());
    if (matched) return matched;
  }
  return candidates[0] ?? "";
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

type DualScriptFaceSlot = "regular" | "medium" | "semibold" | "bold" | "italic" | "boldItalic";

function matchesScannedFaceSlot(styleRaw: string, slot: DualScriptFaceSlot): boolean {
  const s = styleRaw.trim().toLowerCase();
  const isItalic = /\b(italic|oblique)\b/.test(s);
  const isSemiBold = /\b(semibold|semi bold|semi-bold|demibold|demi bold|demi-bold)\b/.test(s);
  const isBold = !isSemiBold && /\bbold\b/.test(s) && !/\b(extra|ultra|heavy|black)\b/.test(s);
  const isMedium = /\bmedium\b/.test(s);
  const isRegular =
    s === "" ||
    (/\b(regular|normal|book|roman|text)\b/.test(s) &&
      !isItalic &&
      !isSemiBold &&
      !isBold &&
      !isMedium &&
      !/\b(light|thin|extra|ultra|heavy|black)\b/.test(s));

  switch (slot) {
    case "regular":
      return isRegular;
    case "medium":
      return !isItalic && isMedium;
    case "semibold":
      return !isItalic && isSemiBold;
    case "bold":
      return !isItalic && isBold;
    case "italic":
      return isItalic && !isSemiBold && !isBold && !/\b(extra|ultra|heavy|black)\b/.test(s);
    case "boldItalic":
      return isItalic && (isBold || isSemiBold);
  }
}

function buildLocalSrcCandidates(
  family: string,
  slot: DualScriptFaceSlot,
  scannedFaces?: readonly LocalFontFaceMeta[],
): string {
  const compact = family.replace(/\s+/g, "");
  const names: string[] = [];
  const push = (name: string | undefined) => {
    const trimmed = name?.trim();
    if (trimmed && !names.includes(trimmed)) names.push(trimmed);
  };

  // 优先使用本机真实扫描到的 fullName / postscriptName，避免 Windows Chromium local() 命名猜测失配。
  const faces = scannedFaces ?? scannedFaceCache.get(family.toLowerCase());
  if (faces && faces.length > 0) {
    for (const face of faces) {
      if (matchesScannedFaceSlot(face.style, slot)) {
        push(face.fullName);
        push(face.postscriptName);
      }
    }
  }

  const pushRegularFallbacks = () => {
    push(`${family} Regular`);
    push(family);
    push(`${family}-Regular`);
    if (compact !== family) {
      push(`${compact}-Regular`);
      push(compact);
    }
  };

  const pushSemiBoldCandidates = () => {
    push(`${family} SemiBold`);
    push(`${family} Semibold`);
    push(`${family} DemiBold`);
    push(`${family}-SemiBold`);
    if (compact !== family) {
      push(`${compact}-SemiBold`);
      push(`${compact}-Semibold`);
    }
  };

  const pushBoldCandidates = () => {
    push(`${family} Bold`);
    push(`${family}-Bold`);
    if (compact !== family) {
      push(`${compact}-Bold`);
    }
  };

  switch (slot) {
    case "regular":
      pushRegularFallbacks();
      break;
    case "medium":
      push(`${family} Medium`);
      push(`${family}-Medium`);
      if (compact !== family) push(`${compact}-Medium`);
      pushRegularFallbacks();
      break;
    case "semibold":
      pushSemiBoldCandidates();
      pushBoldCandidates();
      pushRegularFallbacks();
      break;
    case "bold":
      pushBoldCandidates();
      pushSemiBoldCandidates();
      pushRegularFallbacks();
      break;
    case "italic":
      push(`${family} Italic`);
      push(`${family}-Italic`);
      if (compact !== family) push(`${compact}-Italic`);
      push(`${family} Oblique`);
      pushRegularFallbacks();
      break;
    case "boldItalic":
      push(`${family} Bold Italic`);
      push(`${family}-BoldItalic`);
      if (compact !== family) push(`${compact}-BoldItalic`);
      push(`${family} SemiBold Italic`);
      push(`${family}-SemiBoldItalic`);
      pushBoldCandidates();
      pushRegularFallbacks();
      break;
  }

  return names.map((name) => `local("${escapeCssFontName(name)}")`).join(", ");
}

/**
 * 为「西文字体 + 中文字体」生成真正互不干扰的双语字体规则：
 * - 当同时指定了不同的西文字体与中文字体时，通过 `@font-face` + `unicode-range` 将西文字体严格限定在拉丁/数字/符号区间；
 * - 即使所选西文字体本身包含中文字形（如更纱、思源、微软雅黑等），汉字也会强制跳过它并命中中文字体；
 * - 常规/中等/半粗/粗体分别补全 Regular/Medium/SemiBold/Bold 与 PostScript 名，避免常规体匹配失败退回中文字体而粗体命中西文字体。
 */
export function buildDualScriptFontCss(
  aliasName: string,
  westernFamily: string,
  cjkFamily: string,
  fallbackStack: string,
  scannedFaces?: readonly LocalFontFaceMeta[],
): { readonly fontFacesCss: string; readonly stack: string } {
  const westTrimmed = westernFamily.trim();
  const cjkTrimmed = cjkFamily.trim();
  if (!westTrimmed || !cjkTrimmed || westTrimmed === cjkTrimmed) {
    return {
      fontFacesCss: "",
      stack: buildCssFontStack(westTrimmed, cjkTrimmed, fallbackStack),
    };
  }
  const alias = `"${escapeCssFontName(aliasName)}"`;
  const facesSpec: Array<{ slot: DualScriptFaceSlot; weight: string; style: "normal" | "italic" }> =
    [
      { slot: "regular", weight: "100 499", style: "normal" },
      { slot: "medium", weight: "500 599", style: "normal" },
      { slot: "semibold", weight: "600 650", style: "normal" },
      { slot: "bold", weight: "651 900", style: "normal" },
      { slot: "italic", weight: "100 599", style: "italic" },
      { slot: "boldItalic", weight: "600 900", style: "italic" },
    ];
  const fontFacesCss = facesSpec
    .map(
      ({ slot, weight, style }) =>
        `@font-face {\n  font-family: ${alias};\n  src: ${buildLocalSrcCandidates(westTrimmed, slot, scannedFaces)};\n  font-weight: ${weight};\n  font-style: ${style};\n  unicode-range: ${WESTERN_UNICODE_RANGE};\n}`,
    )
    .join("\n");
  const stack = [alias, quoteCssFontFamily(cjkTrimmed), fallbackStack].filter(Boolean).join(", ");
  return { fontFacesCss, stack };
}
