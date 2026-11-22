/**
 * Pi 运行时探测、受管隔离安装（`managedRuntimeDir`）与本地 `.jsonl` 用量聚合（adapters 层）。
 * 严禁 `shell: true`；绝不修改用户 PATH 上已安装的全局 `pi`；所有子进程登记至 `piProcessRegistry`。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PiLocalUsageSummary,
  PiRuntimeInstallResult,
  PiRuntimeStatus,
} from "@zcode/shared/pi-config";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { terminateProcessTreeAndWait } from "#src/process/processTreeTerminator.js";
import {
  discoverPi,
  formatRedactedPiError,
  getTestPiOverride,
  probePiRpcHandshake,
  probePiVersion,
  registerActivePiProcess,
  resolvePiAgentDir,
  unregisterActivePiProcess,
  type DisposablePiProcess,
} from "#src/pi-runtime/index.js";
import {
  accumulatePiJsonlUsage,
  createLocalUsageAccumulator,
  finalizeLocalUsageSummary,
} from "../domain/piLocalUsageAggregator.js";
import { isEnoent } from "./piAtomicFile.js";

const logger = createServiceLogger("pi-runtime-manager");
const USAGE_SCAN_CONCURRENCY = 12;

export function resolveDefaultManagedRuntimeDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"]?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "zcode-pi-runtime");
  }
  const home = env["HOME"]?.trim() || os.homedir();
  return path.join(home, ".pi-zero", "pi-runtime");
}

/** 检测本机/受管 Pi CLI 状态；`checkHealth` 为 true 时额外执行一次真实 RPC 握手探针。 */
export async function inspectPiRuntimeStatus(options: {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  managedRuntimeDir: string;
  checkHealth?: boolean | undefined;
}): Promise<PiRuntimeStatus> {
  const agentDir = resolvePiAgentDir(options.env);
  const launch = await discoverPi({
    env: options.env,
    platform: options.platform,
    managedRuntimeDir: options.managedRuntimeDir,
  });
  if (!launch) {
    return {
      found: false,
      source: "none",
      command: null,
      cliPath: null,
      version: null,
      agentDir,
      managedRuntimeDir: options.managedRuntimeDir,
      healthy: false,
      error: "Pi CLI (pi) not found on PATH or managed runtime directory",
    };
  }
  const env = options.env ?? process.env;
  const hasTestOverride = Boolean(
    getTestPiOverride()?.trim() || env["ZCODE_TEST_PI"]?.trim() || env["STUDIO_TEST_PI"]?.trim(),
  );
  const managedPrefix = path.resolve(options.managedRuntimeDir).toLowerCase();
  const resolvedDisplay = path.resolve(launch.displayPath).toLowerCase();
  const source: PiRuntimeStatus["source"] = hasTestOverride
    ? "test"
    : resolvedDisplay === managedPrefix || resolvedDisplay.startsWith(`${managedPrefix}${path.sep}`)
      ? "managed"
      : "path";

  const versionProbe = await probePiVersion({
    env: options.env,
    platform: options.platform,
    managedRuntimeDir: options.managedRuntimeDir,
  }).catch((err: unknown) => ({
    ok: false as const,
    message: formatRedactedPiError(err),
    launch,
  }));
  let healthy = versionProbe.ok;
  let error = versionProbe.ok ? undefined : versionProbe.message;
  if (options.checkHealth && versionProbe.ok) {
    const handshake = await probePiRpcHandshake({
      cwd: os.tmpdir(),
      agentDir,
      env: options.env,
      platform: options.platform,
      managedRuntimeDir: options.managedRuntimeDir,
    }).catch((err: unknown) => ({
      ok: false as const,
      stage: "handshake" as const,
      message: formatRedactedPiError(err),
      durationMs: 0,
    }));
    healthy = handshake.ok;
    if (!handshake.ok) error = handshake.message;
  }
  return {
    found: true,
    source,
    command: launch.command,
    cliPath: launch.displayPath,
    version: versionProbe.ok ? versionProbe.version : null,
    agentDir,
    managedRuntimeDir: options.managedRuntimeDir,
    healthy,
    ...(error ? { error } : {}),
  };
}

/**
 * Windows 下避免 `shell: true` 且兼容 nvm / volta / scoop / fnm：
 * 依次查找 Electron 同级目录、ProgramFiles\nodejs 以及 `PATH` 中 `npm.cmd` 同级 `node_modules\npm\bin\npm-cli.js`。
 */
function resolveNpmCliLaunch(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): {
  command: string;
  prefixArgs: string[];
  env: NodeJS.ProcessEnv;
} {
  if (platform === "win32") {
    const candidates: string[] = [
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(
        env["ProgramFiles"] || "C:\\Program Files",
        "nodejs",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
    ];
    const pathVar = env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
    for (const rawDir of pathVar.split(";")) {
      const dir = rawDir
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim();
      if (!dir) continue;
      if (existsSync(path.join(dir, "npm.cmd")) || existsSync(path.join(dir, "npm.exe"))) {
        candidates.push(path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"));
        candidates.push(path.resolve(dir, "..", "node_modules", "npm", "bin", "npm-cli.js"));
      }
    }
    for (const cliJs of candidates) {
      if (existsSync(cliJs)) {
        return {
          command: process.execPath,
          prefixArgs: [cliJs],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        };
      }
    }
  }
  return { command: "npm", prefixArgs: [], env: {} };
}

/** 仅在应用隔离的 `managedRuntimeDir` 中安装或升级 Pi，绝不修改用户 PATH 上的全局 `pi`。 */
export async function installOrUpgradeManagedPiRuntime(options: {
  managedRuntimeDir: string;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
}): Promise<PiRuntimeInstallResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  await mkdir(options.managedRuntimeDir, { recursive: true });
  const npm = resolveNpmCliLaunch(platform, env);
  const args = [
    ...npm.prefixArgs,
    "install",
    "--prefix",
    options.managedRuntimeDir,
    "--no-audit",
    "--no-fund",
    "@earendil-works/pi-coding-agent@latest",
  ];

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(npm.command, args, {
        cwd: options.managedRuntimeDir,
        env: { ...env, ...npm.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const startedAtMs = Date.now();
      let combined = "";
      let settled = false;
      const procHandle: DisposablePiProcess = {
        closeAndWait: async () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          await terminateProcessTreeAndWait(child, {
            ownedProcessStartedAtMs: startedAtMs,
            forceAfterMs: 300,
            waitAfterForceMs: 1_500,
            windowsCleanupDeadlineAtMs: Date.now() + 2_000,
            log: logger,
          });
        },
      };
      registerActivePiProcess(procHandle);
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unregisterActivePiProcess(procHandle);
        fn();
      };
      const timer = setTimeout(() => {
        void procHandle.closeAndWait();
        finish(() => reject(new Error("Managed Pi runtime installation timed out")));
      }, 180_000);
      timer.unref?.();

      child.stdout.setEncoding("utf8").on("data", (d: string) => {
        combined += d;
      });
      child.stderr.setEncoding("utf8").on("data", (d: string) => {
        combined += d;
      });
      child.on("error", (err) => finish(() => reject(err)));
      child.on("close", (code) => {
        if ((code ?? 1) !== 0) {
          finish(() => reject(new Error(combined.trim() || `npm exited with code ${code}`)));
        } else {
          finish(() => resolve(formatRedactedPiError(combined.trim())));
        }
      });
    });

    const status = await inspectPiRuntimeStatus({
      env: options.env,
      platform,
      managedRuntimeDir: options.managedRuntimeDir,
      checkHealth: true,
    });
    return { ok: status.found, status, output };
  } catch (error) {
    const status = await inspectPiRuntimeStatus({
      env: options.env,
      platform,
      managedRuntimeDir: options.managedRuntimeDir,
    });
    const message = formatRedactedPiError(error);
    return { ok: false, status, output: "", error: message };
  }
}

/** 扫描 `<agentDir>/sessions/**\/*.jsonl` 汇总本地 Pi 用量（零子进程）。 */
export async function scanPiLocalUsageSummary(
  agentDir: string,
  days = 90,
): Promise<PiLocalUsageSummary> {
  const now = Date.now();
  const sinceMs = days > 0 ? now - days * 86_400_000 : 0;
  const sessionsRoot = path.join(agentDir, "sessions");
  const files: string[] = [];

  try {
    const entries = await readdir(sessionsRoot, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(sessionsRoot, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      } else if (entry.isDirectory()) {
        const nested = await readdir(full, { withFileTypes: true }).catch(() => []);
        for (const child of nested) {
          if (child.isFile() && child.name.endsWith(".jsonl")) {
            files.push(path.join(full, child.name));
          }
        }
      }
    }
  } catch (err) {
    if (!isEnoent(err)) {
      logger.warn(undefined, `Usage scan failed: ${formatRedactedPiError(err)}`);
    }
  }

  const acc = createLocalUsageAccumulator();
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < files.length) {
      const file = files[cursor++]!;
      try {
        const info = await stat(file);
        if (info.mtimeMs < sinceMs || info.size === 0 || info.size > 64 * 1024 * 1024) continue;
        const raw = await readFile(file, "utf8");
        accumulatePiJsonlUsage({ rawContent: raw, fallbackMtimeMs: info.mtimeMs, sinceMs, acc });
      } catch {
        // 忽略瞬态或已删除文件。
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(USAGE_SCAN_CONCURRENCY, files.length) }, worker));
  return finalizeLocalUsageSummary(acc, Date.now());
}
