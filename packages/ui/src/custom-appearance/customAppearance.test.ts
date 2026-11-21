// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import {
  buildCssFontStack,
  buildDualScriptFontCss,
  resolveFontCandidate,
  WESTERN_UNICODE_RANGE,
} from "./fontLoader.js";
import {
  BUILTIN_APPEARANCE_PRESETS,
  BUILTIN_FONT_PAIRING_PRESETS,
  DEFAULT_CUSTOM_APPEARANCE_CONFIG,
} from "./presets.js";
import { CHAT_WIDTH_MAX_PX, CHAT_WIDTH_MIN_PX, normalizeCustomAppearanceConfig } from "./store.js";
import { applyCustomAppearanceToDocument, resolveChatStrongWeight } from "./styleEngine.js";

describe("custom-appearance", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-zcode-wide-code");
    document.documentElement.removeAttribute("data-zcode-compact-process");
    document.documentElement.removeAttribute("data-zcode-custom-width");
  });

  it("normalizes config and clamps chatMaxWidthPx bounds", () => {
    const tooSmall = normalizeCustomAppearanceConfig({
      layout: { chatMaxWidthPx: 200 },
    });
    expect(tooSmall.layout.chatMaxWidthPx).toBe(CHAT_WIDTH_MIN_PX);

    const tooLarge = normalizeCustomAppearanceConfig({
      layout: { chatMaxWidthPx: 9999 },
    });
    expect(tooLarge.layout.chatMaxWidthPx).toBe(CHAT_WIDTH_MAX_PX);

    const invalid = normalizeCustomAppearanceConfig("broken");
    expect(invalid).toEqual(DEFAULT_CUSTOM_APPEARANCE_CONFIG);
  });

  it("builds dual western + CJK font stack and isolates western glyphs via unicode-range @font-face", () => {
    expect(buildCssFontStack("Georgia", "Sarasa UI SC", "sans-serif")).toBe(
      'Georgia, "Sarasa UI SC", sans-serif',
    );
    expect(buildCssFontStack("Sarasa UI SC", "Sarasa UI SC", "sans-serif")).toBe(
      '"Sarasa UI SC", sans-serif',
    );

    // 即使西文槽选了含中文字形的字体，unicode-range 也将其限制在西文区，确保中文字体独立生效
    const dual = buildDualScriptFontCss(
      "__pizero_chat_west",
      "Microsoft YaHei",
      "LXGW WenKai",
      "sans-serif",
    );
    expect(dual.fontFacesCss).toContain('font-family: "__pizero_chat_west"');
    expect(dual.fontFacesCss).toContain('local("Microsoft YaHei Regular")');
    expect(dual.fontFacesCss).toContain('local("Microsoft YaHei")');
    expect(dual.fontFacesCss).toContain('local("MicrosoftYaHei-Regular")');
    expect(dual.fontFacesCss).toContain("font-weight: 600 650;");
    expect(dual.fontFacesCss).toContain("font-weight: 651 900;");
    expect(dual.fontFacesCss).toContain(`unicode-range: ${WESTERN_UNICODE_RANGE}`);
    expect(dual.stack).toBe('"__pizero_chat_west", "LXGW WenKai", sans-serif');

    // 提供真实扫描到的本地字型时，优先写入精确 fullName/postscriptName
    const dualWithScanned = buildDualScriptFontCss(
      "__pizero_chat_west",
      "Anthropic Serif",
      "Noto Serif SC",
      "serif",
      [
        {
          fullName: "Anthropic Serif Regular",
          postscriptName: "AnthropicSerif-Regular",
          style: "Regular",
        },
        {
          fullName: "Anthropic Serif Bold",
          postscriptName: "AnthropicSerif-Bold",
          style: "Bold",
        },
      ],
    );
    expect(dualWithScanned.fontFacesCss).toContain('local("AnthropicSerif-Regular")');
    expect(dualWithScanned.fontFacesCss).toContain('local("AnthropicSerif-Bold")');
  });

  it("resolves chat strong weights, font pairing candidates, and curated font presets", () => {
    expect(resolveChatStrongWeight(400, "auto")).toBe(600);
    expect(resolveChatStrongWeight(500, "auto")).toBe(700);
    expect(resolveChatStrongWeight(600, "auto")).toBe(700);
    expect(resolveChatStrongWeight(400, 600)).toBe(600);
    expect(resolveChatStrongWeight(400, 700)).toBe(700);

    expect(resolveFontCandidate(["Anthropic Serif", "Georgia"], ["Georgia", "Noto Serif SC"])).toBe(
      "Georgia",
    );
    expect(resolveFontCandidate(["Sarasa UI SC", "Microsoft YaHei UI"], [])).toBe("Sarasa UI SC");

    const presetIds = BUILTIN_FONT_PAIRING_PRESETS.map((p) => p.id);
    expect(presetIds).toContain("sarasa-clean");
    expect(presetIds).toContain("editorial-serif");
    expect(presetIds).toContain("harmony-modern");
    expect(presetIds).toContain("system-default");

    const normalizedLegacy = normalizeCustomAppearanceConfig({
      fonts: { enabled: true, chat: { weight: 400 } },
    });
    expect(normalizedLegacy.fonts.chat.strongWeight).toBe("auto");

    const normalizedExplicit = normalizeCustomAppearanceConfig({
      fonts: { enabled: true, chat: { weight: 400, strongWeight: 600 } },
    });
    applyCustomAppearanceToDocument(normalizedExplicit, "light", false);
    const css = document.getElementById("zcode-custom-appearance-vars")?.textContent ?? "";
    expect(css).toContain("--zcode-chat-strong-weight: 600;");
    expect(css).toContain("font-weight: 600;");
  });

  it("injects theme markdown hierarchy variables, scoped dual-script fonts, chat width and respects safe mode", () => {
    const cfg = normalizeCustomAppearanceConfig({
      enableCustomColors: true,
      lightColors: {
        brand: "#123456",
        markdownHeading: "#101836",
        markdownStrong: "#111111",
        markdownLink: "#2244cc",
        markdownCodeText: "#8f3c22",
        markdownCodeBg: "#f3eee8",
        markdownQuote: "#6b665d",
      },
      fonts: {
        enabled: true,
        ui: { westernFamily: "Inter", cjkFamily: "Sarasa UI SC", weight: 500 },
        chat: {
          westernFamily: "Georgia",
          cjkFamily: "LXGW WenKai",
          weight: 500,
          fontSizePx: 16,
          lineHeight: 1.75,
        },
        mono: { westernFamily: "JetBrains Mono", cjkFamily: "Sarasa Term SC", weight: 400 },
      },
      layout: {
        chatMaxWidthPx: 1020,
        wideCodeBlocks: true,
        compactProcessCards: true,
      },
      customCss: {
        enabled: true,
        code: "body { opacity: 0.99; }",
      },
    });

    applyCustomAppearanceToDocument(cfg, "light", false);

    const varsStyle = document.getElementById("zcode-custom-appearance-vars");
    const cssStyle = document.getElementById("zcode-custom-css");
    const cssText = varsStyle?.textContent ?? "";

    expect(cssText).toContain("--color-brand: #123456;");
    expect(cssText).toContain("--color-markdown-heading: #101836;");
    expect(cssText).toContain("--color-markdown-strong: #111111;");
    expect(cssText).toContain("--color-markdown-link: #2244cc;");
    expect(cssText).toContain("--color-markdown-inline-code-fg: #8f3c22;");
    expect(cssText).toContain("--color-markdown-inline-code-bg: #f3eee8;");
    expect(cssText).toContain("--color-markdown-quote: #6b665d;");
    expect(cssText).toContain('[data-conversation-selectable="true"] :not(pre) > code');
    expect(cssText).toContain("font-size: 0.9em;");
    expect(cssText).toContain('local("Inter")');
    expect(cssText).toContain('"__pizero_ui_west", "Sarasa UI SC"');
    expect(cssText).toContain('local("Georgia")');
    expect(cssText).toContain('"__pizero_chat_west", "LXGW WenKai"');
    expect(cssText).toContain('local("JetBrains Mono")');
    expect(cssText).toContain('"__pizero_mono_west", "Sarasa Term SC"');
    expect(cssText).toContain("--zcode-chat-max-width: 1020px;");
    expect(cssText).toContain(':not([data-centered-empty="true"])');
    expect(cssText).toContain("calc(100% - 24rem)");
    expect(cssText).toContain("--color-surface:");
    expect(document.documentElement.getAttribute("data-zcode-wide-code")).toBe("true");
    expect(document.documentElement.getAttribute("data-zcode-compact-process")).toBe("true");
    expect(cssStyle?.textContent).toContain("opacity: 0.99");

    // 开启安全模式后立即清空用户 CSS，但保留配置本身
    applyCustomAppearanceToDocument(cfg, "light", true);
    expect(document.getElementById("zcode-custom-css")?.textContent).toBe("");
  });

  it("includes Claude Code Desktop, Google M3, Microsoft Fluent 2, and Apple Liquid Glass dual-mode presets with markdown semantics", () => {
    const ids = BUILTIN_APPEARANCE_PRESETS.map((p) => p.id);
    expect(ids).toContain("claude-code-desktop");
    expect(ids).toContain("google-m3-expressive");
    expect(ids).toContain("microsoft-fluent-2");
    expect(ids).toContain("apple-liquid-glass");

    for (const preset of BUILTIN_APPEARANCE_PRESETS) {
      expect(preset.patch.lightColors).toBeDefined();
      expect(preset.patch.darkColors).toBeDefined();
      expect(preset.patch.lightColors?.markdownHeading).toBeTruthy();
      expect(preset.patch.lightColors?.markdownCodeText).toBeTruthy();
      expect(preset.patch.lightColors?.markdownCodeBg).toBeTruthy();
      expect(preset.patch.darkColors?.markdownHeading).toBeTruthy();
      expect(preset.patch.darkColors?.markdownCodeText).toBeTruthy();
      expect(preset.patch.darkColors?.markdownCodeBg).toBeTruthy();
    }

    const claudeCfg = normalizeCustomAppearanceConfig({
      activePresetId: "claude-code-desktop",
      designLanguage: "claude",
      enableCustomColors: true,
      lightColors: BUILTIN_APPEARANCE_PRESETS.find((p) => p.id === "claude-code-desktop")!.patch
        .lightColors,
      darkColors: BUILTIN_APPEARANCE_PRESETS.find((p) => p.id === "claude-code-desktop")!.patch
        .darkColors,
    });
    applyCustomAppearanceToDocument(claudeCfg, "dark", false);
    expect(document.documentElement.getAttribute("data-zcode-design-language")).toBe("claude");
    expect(document.getElementById("zcode-custom-appearance-vars")?.textContent).toContain(
      "#d97757",
    );
    expect(document.getElementById("zcode-custom-appearance-vars")?.textContent).toContain(
      "#f2a488",
    );
  });
});
