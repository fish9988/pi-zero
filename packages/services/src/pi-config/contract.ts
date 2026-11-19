/**
 * IPiConfigService 服务契约与 RPC 描述符（100% 浏览器安全，<= 12 公开方法）。
 */
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type {
  PiAuthAndProvidersSnapshot,
  PiAuthOrProviderMutation,
  PiConfigChangeEvent,
  PiLocalUsageSummary,
  PiResourceMutation,
  PiResourceMutationResult,
  PiResourcesSnapshot,
  PiRuntimeInstallResult,
  PiRuntimeStatus,
  PiSessionEcosystemAction,
  PiSessionEcosystemResult,
  PiSettingsMutation,
  PiSettingsMutationResult,
  PiSettingsSnapshot,
  PiSlashCommandDef,
} from "@zcode/shared/pi-config";
import { createServiceDescriptor } from "#src/descriptors.js";

/**
 * Pi 1.5.2+ 原生配置、只写凭据、资源管理、本地用量与会话生态服务（Host RPC `pi-config` 频道）。
 * 严禁任何方法返回明文 API Key、OAuth Token 或环境变量密钥值。
 */
export interface IPiConfigService {
  readonly onDidChange: Event<PiConfigChangeEvent>;
  getRuntimeStatus(options?: {
    readonly checkHealth?: boolean | undefined;
  }): Promise<PiRuntimeStatus>;
  installOrUpgradeManagedRuntime(): Promise<PiRuntimeInstallResult>;
  getSettingsSnapshot(params?: {
    readonly workspacePath?: string | undefined;
  }): Promise<PiSettingsSnapshot>;
  mutateSettings(op: PiSettingsMutation): Promise<PiSettingsMutationResult>;
  listAuthAndProviders(): Promise<PiAuthAndProvidersSnapshot>;
  mutateAuthOrProvider(op: PiAuthOrProviderMutation): Promise<PiAuthAndProvidersSnapshot>;
  getResourcesSnapshot(params?: {
    readonly workspacePath?: string | undefined;
  }): Promise<PiResourcesSnapshot>;
  mutateResource(op: PiResourceMutation): Promise<PiResourceMutationResult>;
  getLocalUsageSummary(params?: {
    readonly days?: number | undefined;
  }): Promise<PiLocalUsageSummary>;
  listSlashCommands(params?: {
    readonly workspacePath?: string | undefined;
    readonly refresh?: boolean | undefined;
  }): Promise<PiSlashCommandDef[]>;
  runSessionAction(op: PiSessionEcosystemAction): Promise<PiSessionEcosystemResult>;
}

export const IPiConfigService = createServiceDescriptor<IPiConfigService>(ServiceChannels.PiConfig);
