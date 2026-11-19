/**
 * Pi 配置文件纯辅助逻辑（domain 层，0 Node IO / 0 计时器）：
 * - BOM / JSONC 剥离；
 * - 嵌套点分键安全读写与删除（防御原型污染）；
 * - settings.json 值校验与代理凭据脱敏；
 * - `.env` 键存在性解析与安全行修改（绝不回传明文值）；
 * - `pi install/remove/update` 严格包名校验（防御 `-` 选项注入与控制字符）；
 * - `keybindings.json` 默认键位合并。
 */
import {
  findPiSettingSchema,
  type PiConfigScope,
  type PiKeybindingEntry,
  type PiPackageAction,
  type PiSettingSchemaEntry,
} from "@zcode/shared/pi-config";

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STRING_ARRAY_KEYS = new Set([
  "enabledModels",
  "defaultTools",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "npmCommand",
  "selfUpdateCommand",
]);
const SHELL_META_RE = /[;&|`$<>!{}[\]\r\n]/;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** 剥除 JSONC 行注释与块注释（保留字符串字面量原样）。 */
export function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n" && input[i] !== "\r") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function splitDotKey(key: string): string[] {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("Setting key must not be empty");
  const segments = trimmed.split(".");
  for (const segment of segments) {
    if (!segment || FORBIDDEN_SEGMENTS.has(segment)) {
      throw new Error(`Invalid setting key: "${key}"`);
    }
  }
  return segments;
}

export function getNestedValue(root: Record<string, unknown>, key: string): unknown {
  const segments = splitDotKey(key);
  let cursor: unknown = root;
  for (const segment of segments) {
    if (!isPlainRecord(cursor) || !(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

export function setNestedValue(root: Record<string, unknown>, key: string, value: unknown): void {
  const segments = splitDotKey(key);
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    const existing = cursor[seg];
    const next: Record<string, unknown> = isPlainRecord(existing) ? { ...existing } : {};
    cursor[seg] = next;
    cursor = next;
  }
  cursor[segments[segments.length - 1]!] = value;
}

export function deleteNestedValue(root: Record<string, unknown>, key: string): boolean {
  const segments = splitDotKey(key);
  const chain: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let cursor: unknown = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    if (!isPlainRecord(cursor) || !(seg in cursor)) return false;
    const child = cursor[seg];
    if (!isPlainRecord(child)) return false;
    const copy: Record<string, unknown> = { ...child };
    cursor[seg] = copy;
    chain.push({ parent: cursor, key: seg });
    cursor = copy;
  }
  if (!isPlainRecord(cursor)) return false;
  const leaf = segments[segments.length - 1]!;
  if (!(leaf in cursor)) return false;
  delete cursor[leaf];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const link = chain[i]!;
    const obj = link.parent[link.key];
    if (isPlainRecord(obj) && Object.keys(obj).length === 0) delete link.parent[link.key];
    else break;
  }
  return true;
}

export function maskSettingValue(
  key: string,
  value: unknown,
): { value: unknown; redacted: boolean } {
  if (key === "httpProxy" && typeof value === "string" && value.includes("@")) {
    if (value.includes("://")) {
      try {
        const parsed = new URL(value);
        if (parsed.password || parsed.username) {
          if (parsed.password) parsed.password = "***";
          return { value: parsed.toString(), redacted: true };
        }
      } catch {
        // 回退至正则脱敏，避免畸形代理串泄漏凭据。
      }
    }
    const schemeless = value.replace(
      /^((?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?[^:@/\s]+):([^@\s]+)@/,
      "$1:***@",
    );
    if (schemeless !== value) {
      return { value: schemeless, redacted: true };
    }
    const atIdx = value.indexOf("@");
    if (atIdx > 0) {
      return { value: `***@${value.slice(atIdx + 1)}`, redacted: true };
    }
  }
  return { value: value === undefined ? null : structuredClone(value), redacted: false };
}

export function validateSettingAgainstSchema(entry: PiSettingSchemaEntry, value: unknown): void {
  switch (entry.type) {
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`Setting "${entry.key}" expects a boolean`);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`Setting "${entry.key}" expects a non-negative finite number`);
      }
      return;
    case "string":
      if (typeof value !== "string") throw new Error(`Setting "${entry.key}" expects a string`);
      return;
    case "enum":
      if (typeof value !== "string" || !entry.options?.includes(value)) {
        throw new Error(
          `Setting "${entry.key}" expects one of: ${(entry.options ?? []).join(", ")}`,
        );
      }
      return;
    case "array":
      if (!Array.isArray(value)) throw new Error(`Setting "${entry.key}" expects an array`);
      if (STRING_ARRAY_KEYS.has(entry.key) && !value.every((item) => typeof item === "string")) {
        throw new Error(`Setting "${entry.key}" expects an array of strings`);
      }
      return;
    case "record":
      if (!isPlainRecord(value)) throw new Error(`Setting "${entry.key}" expects a JSON object`);
      return;
  }
}

export function validateSettingWrite(key: string, value: unknown, scope: PiConfigScope): void {
  splitDotKey(key);
  const schema = findPiSettingSchema(key);
  if (!schema) return;
  if (schema.globalOnly && scope === "project") {
    throw new Error(`Setting "${key}" can only be configured in global settings.json`);
  }
  validateSettingAgainstSchema(schema, value);
}

/** 构造安全的 `pi install` / `remove` / `update` 参数数组，严格拦截 `-` 选项注入与非法字符。 */
export function buildSafePiPackageArgs(
  op: PiPackageAction,
  source: string | null | undefined,
  scope: PiConfigScope,
): string[] {
  const trimmed = typeof source === "string" ? source.trim() : "";
  if (trimmed) {
    if (
      trimmed.startsWith("-") ||
      trimmed.length > 512 ||
      hasControlChars(trimmed) ||
      /\s/.test(trimmed) ||
      SHELL_META_RE.test(trimmed)
    ) {
      throw new Error(`Invalid package source: "${source ?? ""}"`);
    }
  }
  if (op === "install" || op === "remove") {
    if (!trimmed) throw new Error(`Package source is required for "pi ${op}"`);
    return [op, trimmed, ...(scope === "project" ? ["-l", "--approve"] : [])];
  }
  if (trimmed) {
    return ["update", trimmed, ...(scope === "project" ? ["--approve"] : [])];
  }
  return ["update", "--extensions", ...(scope === "project" ? ["--approve"] : [])];
}

// ── .env 只写辅助（绝不返回变量值）──

export function isValidEnvVarName(name: string): boolean {
  return ENV_NAME_RE.test(name.trim());
}

export function parseConfiguredEnvKeys(envText: string | null): Set<string> {
  const keys = new Set<string>();
  if (!envText) return keys;
  for (const rawLine of stripBom(envText).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    const val = line.slice(eq + 1).trim();
    if (ENV_NAME_RE.test(name) && val !== "" && val !== '""' && val !== "''") {
      keys.add(name);
    }
  }
  return keys;
}

function formatDotEnvValue(value: string): string {
  if (/[\s#"']/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

export function upsertDotEnvText(envText: string | null, name: string, value: string): string {
  const key = name.trim();
  if (!ENV_NAME_RE.test(key)) throw new Error(`Invalid environment variable name: "${name}"`);
  if (hasControlChars(value)) throw new Error(`Invalid value for environment variable "${key}"`);
  const eol = envText?.includes("\r\n") ? "\r\n" : "\n";
  const lines = envText ? stripBom(envText).split(/\r?\n/) : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const rendered = `${key}=${formatDotEnvValue(value)}`;
  let replaced = false;
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return line;
    const existing = trimmed
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    if (existing === key) {
      replaced = true;
      return rendered;
    }
    return line;
  });
  if (!replaced) out.push(rendered);
  return `${out.join(eol)}${eol}`;
}

export function removeDotEnvText(
  envText: string | null,
  name: string,
): { changed: boolean; text: string } {
  const key = name.trim();
  if (!envText || !ENV_NAME_RE.test(key)) return { changed: false, text: envText ?? "" };
  const eol = envText.includes("\r\n") ? "\r\n" : "\n";
  const lines = stripBom(envText).split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept: string[] = [];
  let changed = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf("=");
    const existing =
      trimmed && !trimmed.startsWith("#") && eq > 0
        ? trimmed
            .slice(0, eq)
            .replace(/^export\s+/, "")
            .trim()
        : null;
    if (existing === key) {
      changed = true;
      continue;
    }
    kept.push(line);
  }
  return { changed, text: kept.length > 0 ? `${kept.join(eol)}${eol}` : "" };
}

// ── Pi keybindings.json ──

interface DefaultKeyActionDef {
  readonly action: string;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly defaults: readonly string[];
  readonly win32Defaults?: readonly string[];
}

const PI_KEY_ACTIONS: readonly DefaultKeyActionDef[] = [
  {
    action: "app.thinking.cycle",
    labelZh: "轮换思考强度",
    labelEn: "Cycle Thinking Level",
    defaults: ["shift+tab"],
  },
  {
    action: "app.thinking.toggle",
    labelZh: "开关思考块",
    labelEn: "Toggle Thinking",
    defaults: ["ctrl+t"],
  },
  {
    action: "app.model.cycleForward",
    labelZh: "下一个模型",
    labelEn: "Next Model",
    defaults: ["ctrl+p"],
  },
  {
    action: "app.model.cycleBackward",
    labelZh: "上一个模型",
    labelEn: "Previous Model",
    defaults: ["shift+ctrl+p"],
    win32Defaults: ["shift+ctrl+p", "alt+p"],
  },
  {
    action: "app.model.select",
    labelZh: "选择模型",
    labelEn: "Select Model",
    defaults: ["ctrl+l"],
  },
  {
    action: "app.tools.expand",
    labelZh: "展开工具详情",
    labelEn: "Expand Tools",
    defaults: ["ctrl+o"],
  },
  {
    action: "app.editor.external",
    labelZh: "外部编辑器",
    labelEn: "External Editor",
    defaults: ["ctrl+g"],
  },
  {
    action: "app.message.followUp",
    labelZh: "排队跟进消息",
    labelEn: "Queue Follow-Up",
    defaults: ["alt+enter"],
    win32Defaults: ["alt+enter", "ctrl+q"],
  },
  {
    action: "app.message.dequeue",
    labelZh: "取出排队消息",
    labelEn: "Dequeue Message",
    defaults: ["alt+up"],
    win32Defaults: ["alt+up", "alt+q"],
  },
];

function validChordList(value: unknown): string[] | null {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) {
    return (value as string[]).map((item) => item.trim());
  }
  return null;
}

export function resolvePiKeybindingsEntries(
  userObj: unknown,
  platform: string,
): PiKeybindingEntry[] {
  const record = isPlainRecord(userObj) ? userObj : {};
  const handled = new Set<string>();
  const out: PiKeybindingEntry[] = [];
  for (const def of PI_KEY_ACTIONS) {
    handled.add(def.action);
    const defaultChords =
      platform === "win32" && def.win32Defaults ? [...def.win32Defaults] : [...def.defaults];
    const custom = validChordList(record[def.action]);
    out.push({
      action: def.action,
      labelZh: def.labelZh,
      labelEn: def.labelEn,
      chords: custom ?? defaultChords,
      defaultChords,
      customized: custom !== null,
    });
  }
  for (const [action, raw] of Object.entries(record)) {
    if (handled.has(action) || !action.startsWith("app.")) continue;
    const custom = validChordList(raw);
    if (!custom) continue;
    out.push({
      action,
      labelZh: action,
      labelEn: action,
      chords: custom,
      defaultChords: [],
      customized: true,
    });
  }
  return out;
}
