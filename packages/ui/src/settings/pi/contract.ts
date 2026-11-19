/**
 * pi-settings-ui 公开契约：Pi 9 大设置分区的组件 Props 与服务端口类型。
 */
import type { IServiceAccessor } from "@zcode/services";

export type PiConfigServicePort = NonNullable<IServiceAccessor["piConfigService"]>;

export interface PiWorkspaceScopedSectionProps {
  readonly workspacePath?: string | null | undefined;
}

export interface PiKeybindingsNetworkSectionProps extends PiWorkspaceScopedSectionProps {
  readonly isDesktop?: boolean | undefined;
  readonly workspaceIdentity?: string | undefined;
}

export interface PiUsageAboutSectionProps {
  readonly isDesktop?: boolean | undefined;
  readonly receivePreviewUpdates: boolean;
  readonly autoDownloadAndInstallUpdates: boolean;
  readonly onReceivePreviewUpdatesChange: (enabled: boolean) => Promise<void>;
  readonly onAutoDownloadAndInstallUpdatesChange: (enabled: boolean) => Promise<void>;
}
