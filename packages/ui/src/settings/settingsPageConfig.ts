import {
  BarChart3,
  Blocks,
  Cable,
  Cpu,
  FileText,
  KeyRound,
  Keyboard,
  Monitor,
  Moon,
  Package,
  Palette,
  Settings,
  Settings2,
  Sun,
} from "lucide-react";
import { isSettingsSectionEnabled, type SettingsSectionId } from "@/lib/settingsNavigation.js";
import type { Theme } from "@/useTheme.js";

export const THEME_MODES: Array<{
  mode: Theme;
  icon: typeof Sun;
}> = [
  { mode: "system", icon: Monitor },
  { mode: "zai-dark", icon: Moon },
  { mode: "zai-light", icon: Sun },
];

export type SettingsSectionGroupId = "basics" | "piCore" | "agentCapabilities" | "dataAndStats";

interface SettingsSectionDefinition {
  id: SettingsSectionId;
  icon: typeof Settings;
  titleId: string;
  contentTitleId?: string;
  titleBadgeId?: string;
  groupId: SettingsSectionGroupId;
}

const BASE_SETTINGS_SECTION_GROUPS: Array<{
  id: SettingsSectionGroupId;
  titleId: string;
}> = [
  { id: "basics", titleId: "settings.sidebar.group.basics" },
  { id: "piCore", titleId: "settings.sidebar.group.piCore" },
  { id: "agentCapabilities", titleId: "settings.sidebar.group.agentCapabilities" },
  { id: "dataAndStats", titleId: "settings.sidebar.group.dataAndStats" },
];

/**
 * Pi 桌面工作台 9 大核心设置分区（通用与外观成对置顶，保持 appearance 一键直达）。
 */
const BASE_SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "general",
    icon: Settings2,
    titleId: "settings.systemTitle",
    groupId: "basics",
  },
  {
    id: "appearance",
    icon: Palette,
    titleId: "settings.appearanceTitle",
    groupId: "basics",
  },
  {
    id: "pi-runtime",
    icon: Cpu,
    titleId: "settings.piRuntime.title",
    groupId: "piCore",
  },
  {
    id: "pi-credentials",
    icon: KeyRound,
    titleId: "settings.piCredentials.title",
    groupId: "piCore",
  },
  {
    id: "modelProvider",
    icon: Package,
    titleId: "settings.modelsThinking.title",
    groupId: "piCore",
  },
  {
    id: "pi-context",
    icon: FileText,
    titleId: "settings.piContext.title",
    groupId: "agentCapabilities",
  },
  {
    id: "pi-extensions",
    icon: Blocks,
    titleId: "settings.piExtensions.title",
    groupId: "agentCapabilities",
  },
  {
    id: "pi-mcp-tools",
    icon: Cable,
    titleId: "settings.piMcpTools.title",
    groupId: "agentCapabilities",
  },
  {
    id: "pi-keybindings-network",
    icon: Keyboard,
    titleId: "settings.piKeybindingsNetwork.title",
    groupId: "dataAndStats",
  },
  {
    id: "usage",
    icon: BarChart3,
    titleId: "settings.usageAbout.title",
    groupId: "dataAndStats",
  },
];

export const SETTINGS_SECTIONS = BASE_SETTINGS_SECTIONS.filter((section) =>
  isSettingsSectionEnabled(section.id),
);

export interface SettingsPageConfigOptions {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}

export function createSettingsPageConfig(_options: SettingsPageConfigOptions = {}) {
  const settingsSections = BASE_SETTINGS_SECTIONS.filter((section) =>
    isSettingsSectionEnabled(section.id),
  );
  const settingsSectionGroups = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
    ...group,
    sections: settingsSections.filter((section) => section.groupId === group.id),
  })).filter((group) => group.sections.length > 0);

  return { settingsSectionGroups, settingsSections };
}

export function resolveSettingsSectionForPlatform(
  section: SettingsSectionId,
  visibleSections: ReadonlyArray<Pick<SettingsSectionDefinition, "id">>,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (visibleSections.some((candidate) => candidate.id === section)) return section;
  if (visibleSections.some((candidate) => candidate.id === fallbackSection)) {
    return fallbackSection;
  }
  return visibleSections[0]?.id ?? "general";
}

export const SETTINGS_SECTION_GROUPS = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
  ...group,
  sections: SETTINGS_SECTIONS.filter((section) => section.groupId === group.id),
})).filter((group) => group.sections.length > 0);

export type { SettingsSectionId };

const DESKTOP_ONLY_SETTINGS_SECTIONS = new Set<SettingsSectionId>([]);

export function isSettingsSectionAvailable(
  section: SettingsSectionId,
  isDesktop: boolean,
): boolean {
  return isDesktop || !DESKTOP_ONLY_SETTINGS_SECTIONS.has(section);
}
