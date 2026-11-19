/**
 * Pi MCP 服务器配置存储（adapters 层）：读写全局 `<agentDir>/mcp.json` 与项目 `<cwd>/.pi/mcp.json`。
 * 严禁向渲染层返回明文 `env`/`headers` 值；更新时默认保留未显式覆盖的既有密钥，`0o600` 原子写入。
 */
import path from "node:path";
import {
  PI_MCP_EXPOSURES,
  type PiConfigScope,
  type PiMcpExposure,
  type PiMcpServerItem,
  type PiMcpServerSaveInput,
} from "@zcode/shared/pi-config";
import { hasControlChars, isPlainRecord } from "../domain/piConfigHelpers.js";
import { atomicWritePiFile, enqueuePiFileWrite, readPiJsonObject } from "./piAtomicFile.js";

const MCP_EXPOSURE_SET = new Set<string>(PI_MCP_EXPOSURES);

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function mcpFilePath(
  agentDir: string,
  scope: PiConfigScope,
  workspacePath?: string | null,
): string {
  if (scope === "project") {
    if (!workspacePath?.trim()) throw new Error("workspacePath is required for project mcp.json");
    return path.join(workspacePath, ".pi", "mcp.json");
  }
  return path.join(agentDir, "mcp.json");
}

function normalizeExposure(raw: unknown): PiMcpExposure {
  if (raw === "codemode-deferred") return "codemode";
  if (typeof raw === "string" && MCP_EXPOSURE_SET.has(raw)) return raw as PiMcpExposure;
  return "codemode";
}

function parseMcpItem(
  name: string,
  scope: PiConfigScope,
  raw: Record<string, unknown>,
): PiMcpServerItem {
  const url = nonEmpty(raw["url"]);
  const rawType = nonEmpty(raw["type"]);
  const transport: "stdio" | "http" =
    url !== null || rawType === "http" || rawType === "streamable-http" ? "http" : "stdio";
  const command = nonEmpty(raw["command"]);
  const args = Array.isArray(raw["args"])
    ? (raw["args"] as unknown[]).filter((a): a is string => typeof a === "string")
    : undefined;
  const cwd = nonEmpty(raw["cwd"]);
  const envKeys = isPlainRecord(raw["env"]) ? Object.keys(raw["env"]) : [];
  const headerKeys = isPlainRecord(raw["headers"]) ? Object.keys(raw["headers"]) : [];
  const enabled = raw["enabled"] !== false;
  const exposure = normalizeExposure(raw["exposure"]);
  const timeout =
    typeof raw["timeout"] === "number" && Number.isFinite(raw["timeout"]) && raw["timeout"] > 0
      ? raw["timeout"]
      : undefined;
  const description = nonEmpty(raw["description"]);
  return {
    name,
    scope,
    transport,
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    envKeys,
    ...(cwd ? { cwd } : {}),
    ...(url ? { url } : {}),
    headerKeys,
    enabled,
    exposure,
    ...(timeout !== undefined ? { timeout } : {}),
    ...(description ? { description } : {}),
  };
}

export async function listPiMcpServers(
  agentDir: string,
  workspacePath?: string | null,
): Promise<PiMcpServerItem[]> {
  const [{ data: globalRoot }, projectRes] = await Promise.all([
    readPiJsonObject(mcpFilePath(agentDir, "global"), false),
    workspacePath?.trim()
      ? readPiJsonObject(mcpFilePath(agentDir, "project", workspacePath), false)
      : Promise.resolve(null),
  ]);
  const out: PiMcpServerItem[] = [];
  const collect = (root: Record<string, unknown>, scope: PiConfigScope) => {
    if (!isPlainRecord(root["mcpServers"])) return;
    for (const [name, raw] of Object.entries(root["mcpServers"])) {
      if (isPlainRecord(raw)) out.push(parseMcpItem(name, scope, raw));
    }
  };
  collect(globalRoot, "global");
  if (projectRes) collect(projectRes.data, "project");
  return out;
}

function mergeSecretMap(
  existingRaw: unknown,
  incoming: Readonly<Record<string, string>> | undefined,
  clear: boolean | undefined,
): Record<string, string> | undefined {
  const acc: Record<string, string> = {};
  if (!clear && isPlainRecord(existingRaw)) {
    for (const [k, v] of Object.entries(existingRaw)) {
      if (typeof v === "string") acc[k] = v;
    }
  }
  if (incoming) {
    for (const [k, v] of Object.entries(incoming)) {
      const tk = k.trim();
      if (tk && !hasControlChars(tk)) acc[tk] = v;
    }
  }
  return Object.keys(acc).length > 0 ? acc : undefined;
}

export async function savePiMcpServer(
  agentDir: string,
  input: PiMcpServerSaveInput,
): Promise<PiMcpServerItem> {
  const name = input.name.trim();
  if (!name || name.length > 128 || hasControlChars(name)) {
    throw new Error(`Invalid MCP server name: "${input.name}"`);
  }
  if (!MCP_EXPOSURE_SET.has(input.exposure)) {
    throw new Error(`Invalid MCP exposure: "${input.exposure}"`);
  }
  if (input.transport === "stdio") {
    const cmd = input.command?.trim() ?? "";
    if (!cmd || hasControlChars(cmd)) throw new Error("MCP stdio server requires command");
  } else {
    const url = input.url?.trim() ?? "";
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("MCP HTTP server requires http(s) URL");
    }
  }

  const filePath = mcpFilePath(agentDir, input.scope, input.workspacePath);
  return enqueuePiFileWrite(filePath, async () => {
    const { data: root } = await readPiJsonObject(filePath, true);
    const servers: Record<string, unknown> = isPlainRecord(root["mcpServers"])
      ? { ...root["mcpServers"] }
      : {};
    const prevName = input.previousName?.trim();
    const isRename = Boolean(prevName && prevName !== name);
    if (isRename && name in servers) throw new Error(`MCP server "${name}" already exists`);

    const baseRaw = isRename && prevName ? (servers[prevName] ?? servers[name]) : servers[name];
    const entry: Record<string, unknown> = isPlainRecord(baseRaw) ? { ...baseRaw } : {};

    if (input.transport === "stdio") {
      entry["command"] = input.command!.trim();
      if (input.args && input.args.length > 0) entry["args"] = [...input.args];
      else delete entry["args"];
      if (input.cwd?.trim()) entry["cwd"] = input.cwd.trim();
      else delete entry["cwd"];
      delete entry["url"];
    } else {
      entry["url"] = input.url!.trim();
      delete entry["command"];
      delete entry["args"];
      delete entry["cwd"];
    }

    const env = mergeSecretMap(entry["env"], input.env, input.clearEnv);
    if (env) entry["env"] = env;
    else delete entry["env"];
    const headers = mergeSecretMap(entry["headers"], input.headers, input.clearHeaders);
    if (headers) entry["headers"] = headers;
    else delete entry["headers"];

    if (input.enabled) delete entry["enabled"];
    else entry["enabled"] = false;
    entry["exposure"] = input.exposure;
    if (typeof input.timeout === "number" && input.timeout > 0) entry["timeout"] = input.timeout;
    else if (input.timeout !== undefined) delete entry["timeout"];
    if (input.description !== undefined) {
      if (input.description.trim()) entry["description"] = input.description.trim();
      else delete entry["description"];
    }

    if (isRename && prevName) delete servers[prevName];
    servers[name] = entry;
    root["mcpServers"] = servers;
    await atomicWritePiFile(filePath, `${JSON.stringify(root, null, 2)}\n`, {
      mode: 0o600,
      backup: true,
      tag: "pi-mcp",
    });
    return parseMcpItem(name, input.scope, entry);
  });
}

export async function deletePiMcpServer(
  agentDir: string,
  scope: PiConfigScope,
  name: string,
  workspacePath?: string | null,
): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const filePath = mcpFilePath(agentDir, scope, workspacePath);
  return enqueuePiFileWrite(filePath, async () => {
    const { exists, data: root } = await readPiJsonObject(filePath, true);
    if (!exists || !isPlainRecord(root["mcpServers"]) || !(trimmed in root["mcpServers"])) {
      return false;
    }
    const servers: Record<string, unknown> = { ...root["mcpServers"] };
    delete servers[trimmed];
    root["mcpServers"] = servers;
    await atomicWritePiFile(filePath, `${JSON.stringify(root, null, 2)}\n`, {
      mode: 0o600,
      backup: true,
      tag: "pi-mcp",
    });
    return true;
  });
}

export async function setPiMcpServerEnabled(
  agentDir: string,
  scope: PiConfigScope,
  name: string,
  enabled: boolean,
  workspacePath?: string | null,
): Promise<PiMcpServerItem> {
  const trimmed = name.trim();
  const filePath = mcpFilePath(agentDir, scope, workspacePath);
  return enqueuePiFileWrite(filePath, async () => {
    const { data: root } = await readPiJsonObject(filePath, true);
    if (!isPlainRecord(root["mcpServers"]) || !isPlainRecord(root["mcpServers"][trimmed])) {
      throw new Error(`MCP server "${trimmed}" not found`);
    }
    const servers: Record<string, unknown> = { ...root["mcpServers"] };
    const entry: Record<string, unknown> = { ...root["mcpServers"][trimmed] };
    if (enabled) delete entry["enabled"];
    else entry["enabled"] = false;
    servers[trimmed] = entry;
    root["mcpServers"] = servers;
    await atomicWritePiFile(filePath, `${JSON.stringify(root, null, 2)}\n`, {
      mode: 0o600,
      backup: true,
      tag: "pi-mcp",
    });
    return parseMcpItem(trimmed, scope, entry);
  });
}
