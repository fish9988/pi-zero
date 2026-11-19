import type {
  PiKeybindingsNetworkSectionProps,
  PiUsageAboutSectionProps,
  PiWorkspaceScopedSectionProps,
} from "./contract.js";

export const piWorkspaceSectionExample: PiWorkspaceScopedSectionProps = {
  workspacePath: "/workspace/demo",
};

export const piKeybindingsNetworkExample: PiKeybindingsNetworkSectionProps = {
  isDesktop: true,
  workspacePath: "/workspace/demo",
};

export const piUsageAboutExample: PiUsageAboutSectionProps = {
  isDesktop: true,
  receivePreviewUpdates: false,
  autoDownloadAndInstallUpdates: true,
  onReceivePreviewUpdatesChange: async () => {},
  onAutoDownloadAndInstallUpdatesChange: async () => {},
};
