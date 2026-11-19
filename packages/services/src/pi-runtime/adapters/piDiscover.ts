/**
 * 跨平台 `pi` CLI 发现、Windows `.cmd` shim 直连解析与版本探针。
 * 严格禁止 `shell: true`；所有诊断与错误文本统一脱敏后再记录或返回。
 */
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { redactAgentDiagnosticSecrets } from "@zcode/shared/agent-crash-diagnostic";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  PiDiscoverOptions,
  PiLaunch,
  PiVersionProbeResult,
} from "#src/pi-runtime/contract.js";

const execFileAsync = promisify(execFile);
const logger = createServiceLogger("pi-runtime");

const DEFAULT_VERSION_TIMEOUT_MS = 15_000;
const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const JS_SCRIPT_EXT_PATTERN = /\.(?:m?js|cjs|ts)$/i;

const KNOWN_CLI_REL_PATHS = [
  ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"],
  ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"],
  ["node_modules", "@mariozechner", "pi-coding-agent", "dist", "bundle", "cli.js"],
  ["node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"],
] as const;

let testPiOverride: string | null = null;

export function formatRedactedPiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactAgentDiagnosticSecrets(raw);
}

/** 测试钩子：在不污染全局 PATH 的情况下覆盖 `pi` 发现目标。 */
export function setTestPiOverride(override: string | null): void {
  testPiOverride = override;
}

export function getTestPiOverride(): string | null {
  return testPiOverride;
}

/** 解析 Pi 配置根目录：优先 `PI_CODING_AGENT_DIR`，否则 `~/.pi/agent`。只计算路径不落盘。 */
export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["PI_CODING_AGENT_DIR"]?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const configDir = env["PI_CONFIG_DIR"]?.trim() || ".pi";
  const home = env["HOME"]?.trim() || env["USERPROFILE"]?.trim() || os.homedir();
  return path.join(home, configDir, "agent");
}

function isPackagedAppRuntime(): boolean {
  const proc = process as NodeJS.Process & { defaultApp?: boolean; resourcesPath?: string };
  if (proc.defaultApp === true) {
    return false;
  }
  const resourcesPath = proc.resourcesPath;
  if (typeof resourcesPath !== "string" || resourcesPath.length === 0) {
    return false;
  }
  // 仅依据不可伪造的运行时特征区分打包态：开发/测试 Electron 的 resourcesPath 在 node_modules 下，
  // 而打包后的 Main 与 UtilityProcess 均无 defaultApp 且位于安装目录 resources 下。
  return !resourcesPath.includes("node_modules");
}

function makeNodeScriptLaunch(scriptPath: string, displayPath = scriptPath): PiLaunch {
  return {
    command: process.execPath,
    prefixArgs: [scriptPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    displayPath,
  };
}

function makeNativeLaunch(binPath: string): PiLaunch {
  return {
    command: binPath,
    prefixArgs: [],
    env: {},
    displayPath: binPath,
  };
}

function launchFromOverride(rawOverride: string): PiLaunch {
  const trimmed = rawOverride.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { command?: unknown; args?: unknown };
      if (typeof parsed.command === "string" && parsed.command.trim() !== "") {
        const rawArgs = Array.isArray(parsed.args)
          ? parsed.args.filter((arg): arg is string => typeof arg === "string")
          : [];
        const firstArg = rawArgs[0];
        const needsElectronAsNode =
          parsed.command === process.execPath ||
          (firstArg !== undefined && JS_SCRIPT_EXT_PATTERN.test(firstArg));
        return {
          command: parsed.command,
          prefixArgs: rawArgs,
          env: needsElectronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {},
          displayPath: firstArg ?? parsed.command,
        };
      }
    } catch {
      // 非 JSON 或格式不完整时回退为路径解析。
    }
  }
  if (JS_SCRIPT_EXT_PATTERN.test(trimmed)) {
    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed);
    return makeNodeScriptLaunch(resolved, resolved);
  }
  return makeNativeLaunch(trimmed);
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function isExecutableFile(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    if (platform === "win32") return true;
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 Windows npm `.cmd` shim（如 `pi.cmd`），提取底层 `.js/.mjs/.cjs` 入口。
 * 将 `%dp0%` 和 `%~dp0` 按 `path.win32.dirname(cmdPath)` 展开，彻底绕开 `cmd.exe`。
 */
export function parsePiCmdShim(cmdPath: string, content: string): string | null {
  const baseDir = path.win32.dirname(cmdPath);
  const tokenPattern = /"([^"\r\n]+?\.(?:m?js|cjs))"|([^\s"\r\n]+?\.(?:m?js|cjs))/gi;
  const candidates: string[] = [];
  for (const match of content.matchAll(tokenPattern)) {
    const raw = match[1] ?? match[2];
    if (raw === undefined || raw === "") continue;
    candidates.push(raw);
  }

  candidates.sort((a, b) => {
    const score = (entry: string): number => {
      const lower = entry.toLowerCase();
      if (lower.includes("pi-coding-agent")) return 0;
      if (lower.endsWith("cli.js") || lower.endsWith("cli.mjs")) return 1;
      return 2;
    };
    return score(a) - score(b);
  });

  const first = candidates[0];
  if (first === undefined) return null;

  const expanded = first
    .replace(/%~dp0[\\/]?/gi, `${baseDir}\\`)
    .replace(/%dp0%[\\/]?/gi, `${baseDir}\\`);

  if (path.win32.isAbsolute(expanded)) {
    return path.win32.normalize(expanded);
  }
  return path.win32.resolve(baseDir, expanded);
}

function collectSearchDirs(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  managedRuntimeDir?: string,
): string[] {
  const pathVar = env["PATH"] ?? env["Path"] ?? env["path"] ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const dirs: string[] = [];

  const pushDir = (raw: string | undefined): void => {
    if (raw === undefined) return;
    const cleaned = raw
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    if (cleaned === "") return;
    const key = platform === "win32" ? cleaned.toLowerCase() : cleaned;
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push(cleaned);
  };

  for (const entry of pathVar.split(delimiter)) {
    pushDir(entry);
  }

  const home = env["HOME"] ?? env["USERPROFILE"] ?? os.homedir();
  if (platform === "win32") {
    const appData =
      env["APPDATA"] ?? (home ? path.win32.join(home, "AppData", "Roaming") : undefined);
    const localAppData =
      env["LOCALAPPDATA"] ?? (home ? path.win32.join(home, "AppData", "Local") : undefined);
    if (appData !== undefined) pushDir(path.win32.join(appData, "npm"));
    if (localAppData !== undefined) {
      pushDir(path.win32.join(localAppData, "npm"));
      pushDir(path.win32.join(localAppData, "pnpm"));
      pushDir(path.win32.join(localAppData, "Volta", "bin"));
      pushDir(path.win32.join(localAppData, "Programs", "nodejs"));
    }
    if (home) {
      pushDir(path.win32.join(home, ".local", "bin"));
      pushDir(path.win32.join(home, ".bun", "bin"));
      pushDir(path.win32.join(home, "scoop", "shims"));
    }
  } else {
    if (env["NVM_BIN"] !== undefined) pushDir(env["NVM_BIN"]);
    if (home) {
      pushDir(path.posix.join(home, ".local", "bin"));
      pushDir(path.posix.join(home, ".npm-global", "bin"));
      pushDir(path.posix.join(home, ".volta", "bin"));
      pushDir(path.posix.join(home, ".bun", "bin"));
    }
    pushDir("/opt/homebrew/bin");
    pushDir("/usr/local/bin");
  }

  const extraRuntimeDir = managedRuntimeDir ?? env["ZCODE_PI_RUNTIME_DIR"];
  if (extraRuntimeDir) {
    pushDir(extraRuntimeDir);
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    pushDir(pathApi.join(extraRuntimeDir, "node_modules", ".bin"));
  }

  return dirs;
}

async function findKnownCliJs(baseDir: string, platform: NodeJS.Platform): Promise<string | null> {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const roots = [baseDir];
  if (platform !== "win32") {
    roots.push(pathApi.resolve(baseDir, "..", "lib"));
  }
  for (const root of roots) {
    for (const rel of KNOWN_CLI_REL_PATHS) {
      const candidate = pathApi.join(root, ...rel);
      if (await isRegularFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * 跨平台发现 `pi` CLI：不触发 shell；Windows 自动将 `pi.cmd` 解析为 `node <cli.js>`。
 */
export async function discoverPi(options?: PiDiscoverOptions): Promise<PiLaunch | null> {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const allowOverride = options?.allowTestOverride ?? !isPackagedAppRuntime();

  if (allowOverride) {
    const override = testPiOverride ?? env["ZCODE_TEST_PI"] ?? env["STUDIO_TEST_PI"];
    if (override !== undefined && override.trim() !== "") {
      return launchFromOverride(override);
    }
  }

  const dirs = collectSearchDirs(env, platform, options?.managedRuntimeDir);
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  for (const dir of dirs) {
    if (platform === "win32") {
      const exePath = pathApi.join(dir, "pi.exe");
      if (await isExecutableFile(exePath, platform)) {
        return makeNativeLaunch(exePath);
      }

      const cmdPath = pathApi.join(dir, "pi.cmd");
      if (await isRegularFile(cmdPath)) {
        try {
          const content = await readFile(cmdPath, "utf8");
          const parsedJs = parsePiCmdShim(cmdPath, content);
          if (parsedJs !== null && (await isRegularFile(parsedJs))) {
            return makeNodeScriptLaunch(parsedJs, parsedJs);
          }
        } catch {
          // 读 shim 失败时继续检查同目录下已知 node_modules 布局。
        }
      }

      const knownJs = await findKnownCliJs(dir, platform);
      if (knownJs !== null) {
        return makeNodeScriptLaunch(knownJs, knownJs);
      }
    } else {
      const binPath = pathApi.join(dir, "pi");
      if (await isExecutableFile(binPath, platform)) {
        return makeNativeLaunch(binPath);
      }

      const knownJs = await findKnownCliJs(dir, platform);
      if (knownJs !== null) {
        return makeNodeScriptLaunch(knownJs, knownJs);
      }
    }
  }

  return null;
}

/**
 * 发现 `pi` 并通过 `execFile`（禁 shell、有超时、输出脱敏）探测版本号。
 */
export async function probePiVersion(
  options?: PiDiscoverOptions & { timeoutMs?: number | undefined; traceId?: string | undefined },
): Promise<PiVersionProbeResult> {
  const env = options?.env ?? process.env;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const launch = await discoverPi(options);

  if (launch === null) {
    const message =
      "pi CLI not found in PATH. Install @earendil-works/pi-coding-agent globally via npm.";
    logger.warn(options?.traceId, "Pi CLI discovery failed", { message });
    return { ok: false, message, launch: null };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      launch.command,
      [...launch.prefixArgs, "--version"],
      {
        env: { ...env, ...launch.env },
        windowsHide: true,
        timeout: timeoutMs,
      },
    );
    const combined = redactAgentDiagnosticSecrets(`${stdout}\n${stderr}`.trim());
    const match = VERSION_PATTERN.exec(combined);
    if (match?.[1] === undefined) {
      const message = `Could not parse pi version from output: ${combined.slice(0, 200)}`;
      logger.warn(options?.traceId, "Pi CLI version parse failed", {
        displayPath: launch.displayPath,
        message,
      });
      return { ok: false, message, launch };
    }
    logger.info(options?.traceId, "Pi CLI discovered", {
      version: match[1],
      displayPath: launch.displayPath,
    });
    return {
      ok: true,
      version: match[1],
      launch,
    };
  } catch (error) {
    const message = `Failed to execute pi (${launch.displayPath}): ${formatRedactedPiError(error)}`;
    logger.warn(options?.traceId, "Pi CLI version probe failed", {
      displayPath: launch.displayPath,
      message,
    });
    return { ok: false, message, launch };
  }
}
