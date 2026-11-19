/**
 * pi-runtime 标准调用示例：演示隔离目录握手探测、Route A V4 适配器创建与退出零孤儿清理。
 */
import {
  PiModelCatalog,
  createPiAgentService,
  disposeAllPiProcessesAndWait,
  probePiRpcHandshake,
} from "#src/pi-runtime/index.js";

export async function examplePiRuntimeUsage(
  workspaceDir: string,
  isolatedAgentDir: string,
): Promise<void> {
  const probe = await probePiRpcHandshake({
    cwd: workspaceDir,
    agentDir: isolatedAgentDir,
  });
  if (!probe.ok) {
    throw new Error(`Pi handshake failed at ${probe.stage}: ${probe.message}`);
  }

  const env = { ...process.env, PI_CODING_AGENT_DIR: isolatedAgentDir };
  const catalog = new PiModelCatalog({ env, defaultCwd: workspaceDir });
  const agentService = createPiAgentService({ catalog, env });
  try {
    await agentService.initialize({ workspacePath: workspaceDir });
  } finally {
    await agentService.disposeAllAndWait();
    catalog.dispose();
    await disposeAllPiProcessesAndWait();
  }
}
