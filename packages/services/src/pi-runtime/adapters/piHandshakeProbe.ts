/**
 * Pi RPC 握手探针：发现 CLI -> 验证版本 -> 拉起 `pi --mode rpc --no-session`
 * -> 执行 `get_state` 与 `get_available_models` -> 完整回收子进程树。
 */
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { PiHandshakeProbeOptions, PiHandshakeProbeResult } from "#src/pi-runtime/contract.js";
import { formatRedactedPiError, probePiVersion } from "#src/pi-runtime/adapters/piDiscover.js";
import { PiRpcClient } from "#src/pi-runtime/adapters/piRpcClient.js";

const logger = createServiceLogger("pi-runtime");

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;

export async function probePiRpcHandshake(
  options: PiHandshakeProbeOptions,
): Promise<PiHandshakeProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const childEnv: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    ...(options.agentDir !== undefined && options.agentDir.trim() !== ""
      ? { PI_CODING_AGENT_DIR: options.agentDir }
      : {}),
  };

  const versionProbe = await probePiVersion({
    env: childEnv,
    platform: options.platform,
    managedRuntimeDir: options.managedRuntimeDir,
    timeoutMs,
    traceId: options.traceId,
  });

  if (!versionProbe.ok) {
    return {
      ok: false,
      stage: versionProbe.launch === null ? "discover" : "version",
      message: versionProbe.message,
      durationMs: Date.now() - startedAt,
    };
  }

  let client: PiRpcClient | null = null;
  try {
    client = await PiRpcClient.spawn({
      launch: versionProbe.launch,
      cwd: options.cwd,
      noSession: true,
      env: childEnv,
      defaultTimeoutMs: timeoutMs,
      traceId: options.traceId,
    });
  } catch (error) {
    const message = `Failed to spawn Pi RPC process: ${formatRedactedPiError(error)}`;
    logger.warn(options.traceId, "Pi RPC handshake spawn failed", { message });
    return {
      ok: false,
      stage: "spawn",
      message,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const [state, modelsResult] = await Promise.all([
      client.getState(),
      client.getAvailableModels(),
    ]);
    const durationMs = Date.now() - startedAt;
    logger.info(options.traceId, "Pi RPC handshake succeeded", {
      version: versionProbe.version,
      containment: client.containment,
      modelCount: modelsResult.models.length,
      durationMs,
    });
    return {
      ok: true,
      version: versionProbe.version,
      launchPath: versionProbe.launch.displayPath,
      containment: client.containment,
      state,
      models: modelsResult.models,
      durationMs,
    };
  } catch (error) {
    const message = `Pi RPC handshake command failed: ${formatRedactedPiError(error)}`;
    logger.warn(options.traceId, "Pi RPC handshake failed", { message });
    return {
      ok: false,
      stage: "handshake",
      message,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await client.closeAndWait();
  }
}
