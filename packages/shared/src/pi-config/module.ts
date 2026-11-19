/**
 * pi-config-protocol 模块清单（architecture-governance managed 模块）。
 * 浏览器安全共享契约：Pi 1.5.2 设置 Schema、内置 Provider 元数据、24 条原生斜杠命令表与 IPiConfigService 数据模型。
 */
export const piConfigProtocolModule = {
  id: "pi-config-protocol",
  requires: [],
  provides: ["pi-config-protocol"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
