/**
 * pi-runtime 标准调用示例：演示隔离目录握手探测与桌面退出时统一清理所有 Pi 子进程。
 */
import {
  PiRpcClient,
  discoverPi,
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

  const launch = await discoverPi();
  if (!launch) return;

  const client = await PiRpcClient.spawn({
    launch,
    cwd: workspaceDir,
    noSession: true,
    env: { ...process.env, PI_CODING_AGENT_DIR: isolatedAgentDir },
  });
  try {
    await client.getState();
  } finally {
    await client.closeAndWait();
    await disposeAllPiProcessesAndWait();
  }
}
