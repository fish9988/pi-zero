import { useEffect, useMemo, useState } from "react";
import type { ZCodeSlashCommand } from "@zcode/shared";
import { PI_NATIVE_SLASH_COMMANDS, type PiSlashCommandDef } from "@zcode/shared/pi-config";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

function toZCodeSlashCommand(def: PiSlashCommandDef, isZh: boolean): ZCodeSlashCommand {
  const description = isZh ? def.descriptionZh : def.descriptionEn;
  const inputHint = def.argsHint ? `/${def.name} ${def.argsHint}` : `/${def.name}`;
  return {
    name: def.name,
    description,
    inputHint,
    source: def.source === "builtin" ? "builtin" : "custom",
  };
}

/**
 * 严格返回 Pi 1.5.2 原生 24 条斜杠命令 + 实时 `get_commands`（扩展/Prompt/Skill）。
 * 绝不合并任何旧 ZCode 非 Pi 命令（如 `/goal`、`/vibe`、`/plan`、`/side`）。
 */
export function usePiSlashCommands(workspacePath: string | null | undefined): ZCodeSlashCommand[] {
  const services = useOptionalServices();
  const piService = services?.piConfigService;
  const { locale } = useZCodeIntl();
  const isZh = locale.toLowerCase().startsWith("zh");
  const [liveDefs, setLiveDefs] = useState<readonly PiSlashCommandDef[]>(PI_NATIVE_SLASH_COMMANDS);

  useEffect(() => {
    if (!piService) {
      setLiveDefs(PI_NATIVE_SLASH_COMMANDS);
      return;
    }
    let cancelled = false;
    const load = () => {
      void piService
        .listSlashCommands(workspacePath ? { workspacePath } : undefined)
        .then((defs) => {
          if (!cancelled && defs.length > 0) {
            setLiveDefs(defs);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLiveDefs(PI_NATIVE_SLASH_COMMANDS);
          }
        });
    };
    load();
    const disposable = piService.onDidChange((event) => {
      if (event.area === "resources" || event.area === "settings") {
        load();
      }
    });
    return () => {
      cancelled = true;
      disposable.dispose();
    };
  }, [piService, workspacePath]);

  return useMemo(() => liveDefs.map((def) => toZCodeSlashCommand(def, isZh)), [isZh, liveDefs]);
}

export type PiLocalSlashDispatch =
  | { readonly kind: "btw"; readonly question: string }
  | { readonly kind: "export" }
  | { readonly kind: "tree" }
  | { readonly kind: "fork" }
  | {
      readonly kind: "settings";
      readonly section?:
        | "general"
        | "pi-credentials"
        | "pi-mcp-tools"
        | "pi-keybindings-network"
        | "usage";
    }
  | { readonly kind: "reload" };

/** 解析由前端 Pi 生态直接承接的斜杠命令（不含 attachments）。 */
export function parsePiLocalSlashCommand(
  content: string,
  hasAttachments = false,
): PiLocalSlashDispatch | null {
  if (hasAttachments) return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const name = (match[1] ?? "").toLowerCase();
  const args = (match[2] ?? "").trim();

  switch (name) {
    case "btw":
      return { kind: "btw", question: args };
    case "export":
      return { kind: "export" };
    case "tree":
      return { kind: "tree" };
    case "fork":
      return { kind: "fork" };
    case "settings":
      return { kind: "settings", section: "general" };
    case "login":
    case "logout":
      return { kind: "settings", section: "pi-credentials" };
    case "mcp":
      return { kind: "settings", section: "pi-mcp-tools" };
    case "hotkeys":
      return { kind: "settings", section: "pi-keybindings-network" };
    case "usage":
    case "changelog":
      return { kind: "settings", section: "usage" };
    case "reload":
      return { kind: "reload" };
    default:
      return null;
  }
}
