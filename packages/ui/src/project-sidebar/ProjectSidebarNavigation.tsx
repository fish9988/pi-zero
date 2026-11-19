import { memo } from "react";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";
import { WebRemoteControlDeviceHeader } from "@/web-remote-control/WebRemoteControlDeviceHeader.js";

/** 顶部导航只保留新建任务入口，移除已弃用的自动化与商业插件市场入口。 */
export const ProjectSidebarNavigation = memo(function ProjectSidebarNavigation({
  props,
  onCreate,
}: {
  props: Pick<
    ProjectSidebarProps,
    | "isWebRemoteControl"
    | "onOpenAutomations"
    | "automationsActive"
    | "onOpenPluginStore"
    | "pluginStoreActive"
    | "webRemoteControlWorkspaceSwitcher"
    | "navPrimarySlot"
    | "workspacePath"
    | "workspaceIdentity"
    | "workspaceRemoteSessionId"
  >;
  onCreate(): void;
}) {
  const deviceNavigation = props.webRemoteControlWorkspaceSwitcher?.deviceNavigation;
  return (
    <div
      data-testid="sidebar-primary-navigation"
      className={`flex flex-col gap-1 px-2 py-3 ${props.isWebRemoteControl && !deviceNavigation ? "max-md:pt-11" : ""}`}
    >
      {deviceNavigation ? <WebRemoteControlDeviceHeader navigation={deviceNavigation} /> : null}
      <NewTaskButtonGroup onCreateTask={onCreate} />
    </div>
  );
});
