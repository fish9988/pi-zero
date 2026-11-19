/**
 * pi-runtime 模块清单（architecture-governance managed 模块）。
 * 层：domain（纯协议类型、模型能力映射、V4 快照与增量投影器，无 IO/定时器）-> adapters（发现、进程托管、LF JSONL RPC 客户端、IZCodeAgentService V4 适配器）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const piRuntimeModule = {
  id: "pi-runtime",
  requires: [
    "agent-crash-diagnostic",
    "pi-config-protocol",
    "provider",
    "rpc",
    "services",
    "shared",
    "windows-runtime-host",
  ],
  provides: ["pi-runtime"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
