/**
 * Pi 1.5.2 原生 24 条斜杠命令静态表与动态 `get_commands` 合并函数（纯浏览器安全）。
 * 严禁混入旧版 ZCode/OMP 非 Pi 命令（如 `/goal`、`/vibe`、`/memory` 等）。
 */
import type { PiSlashCommandDef } from "./contract.js";

export const PI_NATIVE_SLASH_COMMANDS: readonly PiSlashCommandDef[] = [
  {
    name: "settings",
    descriptionZh: "打开 Pi 设置中心",
    descriptionEn: "Open Pi settings",
    category: "config",
    source: "builtin",
    argsHint: "[搜索关键词]",
    supportsDraft: true,
  },
  {
    name: "model",
    descriptionZh: "切换当前会话模型",
    descriptionEn: "Switch active session model",
    category: "model",
    source: "builtin",
    argsHint: "[provider/model]",
    supportsDraft: true,
  },
  {
    name: "thinking",
    aliases: ["effort"],
    descriptionZh: "调整推理思考强度档位",
    descriptionEn: "Set reasoning thinking level",
    category: "model",
    source: "builtin",
    argsHint: "[off|minimal|low|medium|high|xhigh|max]",
    supportsDraft: true,
  },
  {
    name: "scoped-models",
    descriptionZh: "管理启用的模型范围与快捷键轮换",
    descriptionEn: "Configure enabled models list",
    category: "model",
    source: "builtin",
    supportsDraft: true,
  },
  {
    name: "mcp",
    descriptionZh: "管理 Pi MCP 服务器与工具暴露策略",
    descriptionEn: "Manage Pi MCP servers",
    category: "tools",
    source: "builtin",
    supportsDraft: true,
  },
  {
    name: "login",
    descriptionZh: "配置 Provider 凭据或终端 OAuth 登录",
    descriptionEn: "Sign in to a Pi provider",
    category: "config",
    source: "builtin",
    supportsDraft: true,
  },
  {
    name: "logout",
    descriptionZh: "移除已保存的 Provider 登录凭据",
    descriptionEn: "Sign out from a Pi provider",
    category: "config",
    source: "builtin",
    supportsDraft: true,
  },
  {
    name: "new",
    descriptionZh: "在当前工作区新建空白会话",
    descriptionEn: "Start a new session",
    category: "session",
    source: "builtin",
  },
  {
    name: "resume",
    descriptionZh: "切换或恢复历史 Pi 会话",
    descriptionEn: "Resume a previous Pi session",
    category: "session",
    source: "builtin",
    supportsDraft: true,
  },
  {
    name: "name",
    aliases: ["rename"],
    descriptionZh: "重命名当前会话标题",
    descriptionEn: "Rename current session",
    category: "session",
    source: "builtin",
    argsHint: "<新标题>",
  },
  {
    name: "session",
    descriptionZh: "查看当前会话路径、分支与模型统计",
    descriptionEn: "Inspect current session details",
    category: "session",
    source: "builtin",
  },
  {
    name: "usage",
    descriptionZh: "查看本地 Pi 会话 Token 与费用统计",
    descriptionEn: "View local Pi token and cost usage",
    category: "config",
    source: "builtin",
    supportsDraft: true,
  },
  {
    name: "tree",
    descriptionZh: "打开会话分支树并支持就地回退或分叉",
    descriptionEn: "Browse session branch tree",
    category: "session",
    source: "builtin",
  },
  {
    name: "fork",
    descriptionZh: "从当前位置分叉出新的独立会话",
    descriptionEn: "Fork current session into a new branch",
    category: "session",
    source: "builtin",
  },
  {
    name: "clone",
    descriptionZh: "完整克隆当前会话继续探索",
    descriptionEn: "Clone current session",
    category: "session",
    source: "builtin",
  },
  {
    name: "compact",
    descriptionZh: "立即压缩当前会话上下文",
    descriptionEn: "Compact conversation context",
    category: "session",
    source: "builtin",
    argsHint: "[压缩重点提示]",
  },
  {
    name: "copy",
    descriptionZh: "复制上一条助手回复到剪贴板",
    descriptionEn: "Copy last assistant reply",
    category: "session",
    source: "builtin",
  },
  {
    name: "export",
    descriptionZh: "将当前会话离线导出为独立 HTML 文件",
    descriptionEn: "Export session to standalone HTML",
    category: "session",
    source: "builtin",
  },
  {
    name: "reload",
    descriptionZh: "重新加载 Pi 模型目录、扩展与命令",
    descriptionEn: "Reload Pi models, extensions and commands",
    category: "tools",
    source: "builtin",
    supportsDraft: true,
  },
  {
    name: "btw",
    descriptionZh: "发起一次性侧边问答（不污染当前会话上下文）",
    descriptionEn: "Ask a side question without modifying session history",
    category: "session",
    source: "builtin",
    argsHint: "<问题>",
    supportsDraft: true,
  },
  {
    name: "git",
    descriptionZh: "打开侧边栏 Git 变更面板",
    descriptionEn: "Open Git changes pane",
    category: "tools",
    source: "builtin",
  },
  {
    name: "hotkeys",
    descriptionZh: "查看并编辑 ZCode 与 Pi 快捷键",
    descriptionEn: "Configure keyboard shortcuts",
    category: "config",
    source: "builtin",
    supportsDraft: true,
  },
  {
    name: "changelog",
    descriptionZh: "查看版本信息与更新日志",
    descriptionEn: "View version and changelog",
    category: "config",
    source: "builtin",
    supportsDraft: true,
  },
  {
    name: "delete",
    descriptionZh: "删除当前会话",
    descriptionEn: "Delete current session",
    category: "session",
    source: "builtin",
  },
];

/** 合并 24 条 Pi 原生内置命令与实时 `get_commands`（扩展/Prompt/Skill），按名称去重（内置优先）。 */
export function mergePiSlashCommands(
  dynamicCommands: readonly {
    readonly name: string;
    readonly description?: string | undefined;
    readonly source: "extension" | "prompt" | "skill";
  }[],
): PiSlashCommandDef[] {
  const seen = new Set<string>();
  const out: PiSlashCommandDef[] = [];
  for (const cmd of PI_NATIVE_SLASH_COMMANDS) {
    seen.add(cmd.name.toLowerCase());
    for (const alias of cmd.aliases ?? []) {
      seen.add(alias.toLowerCase());
    }
    out.push(cmd);
  }
  for (const dyn of dynamicCommands) {
    const cleanName = dyn.name.trim().replace(/^\/+/, "");
    if (!cleanName) continue;
    const key = cleanName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const desc = dyn.description?.trim() || `${dyn.source} command`;
    out.push({
      name: cleanName,
      descriptionZh: desc,
      descriptionEn: desc,
      category: "custom",
      source: dyn.source,
      supportsDraft: true,
    });
  }
  return out;
}
