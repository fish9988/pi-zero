/**
 * pi-config 模块清单（architecture-governance managed 模块）。
 * 层：domain（纯解析/校验/HTML 导出/树与用量纯计算，无 IO）-> adapters（原子读写、子进程、RPC 服务实现）。
 */
export const piConfigModule = {
  id: "pi-config",
  requires: [
    "pi-config-protocol",
    "pi-runtime",
    "provider",
    "rpc",
    "services",
    "shared",
    "windows-runtime-host",
  ],
  provides: ["pi-config"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
