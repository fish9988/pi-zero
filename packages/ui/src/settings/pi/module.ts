/**
 * pi-settings-ui 模块清单（architecture-governance managed 模块）。
 * 层：contract, ui。修改 requires 时同步更新 architecture-policy.yaml。
 */
export const piSettingsUiModule = {
  id: "pi-settings-ui",
  requires: ["pi-config-protocol", "provider", "services", "shared", "ui"],
  provides: ["pi-settings-ui"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
