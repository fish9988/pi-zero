/**
 * Pi Skills 与 Prompts 模板存储（adapters 层）：
 * - Skills 扫描、启停（`settings.json` `skills`）、文件夹导入与边界内安全删除；
 * - Prompts 模板（`prompts/*.md`）列表、原子保存与删除。
 */
import { cp, mkdir, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PiConfigScope, PiPromptTemplate, PiSkillEntry } from "@zcode/shared/pi-config";
import { deleteNestedValue, hasControlChars, stripBom } from "../domain/piConfigHelpers.js";
import {
  atomicWritePiFile,
  isEnoent,
  readPiJsonObject,
  readPiTextIfExists,
} from "./piAtomicFile.js";
import { mutatePiSettingsJson, resolvePiSettingsFilePath } from "./piSettingsStore.js";

const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isInsideDir(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function stringArray(obj: Record<string, unknown>, key: string): string[] {
  const raw = obj[key];
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((item): item is string => typeof item === "string");
}

function parseSimpleFrontmatter(raw: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const clean = stripBom(raw);
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(clean);
  if (!match) return { body: clean };
  const fm = match[1] ?? "";
  const body = clean.slice(match[0].length);
  let name: string | undefined;
  let description: string | undefined;
  for (const line of fm.split(/\r?\n/)) {
    const m = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const val = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (m[1] === "name" && val) name = val;
    if (m[1] === "description" && val) description = val;
  }
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), body };
}

async function scanSkillsDir(
  rootDir: string,
  scope: PiConfigScope,
  provider: "pi" | "agents",
): Promise<Omit<PiSkillEntry, "enabled">[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    return [];
  }
  const out: Omit<PiSkillEntry, "enabled">[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(rootDir, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      isDir = await stat(full)
        .then((s) => s.isDirectory())
        .catch(() => false);
    }
    if (!isDir) continue;
    const skillMd = path.join(full, "SKILL.md");
    const raw = await readPiTextIfExists(skillMd);
    if (raw === null) continue;
    const fm = parseSimpleFrontmatter(raw);
    const fallbackDesc =
      fm.body
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#")) ?? "";
    out.push({
      name: fm.name || entry.name,
      description: fm.description || fallbackDesc,
      scope,
      provider,
      filePath: skillMd,
      folderPath: full,
      removable: provider === "pi",
    });
  }
  return out;
}

export async function listPiSkills(
  agentDir: string,
  workspacePath?: string | null,
  homeDir = os.homedir(),
): Promise<PiSkillEntry[]> {
  const [globalPi, globalAgents, projPi, projAgents, globalSettings, projSettings] =
    await Promise.all([
      scanSkillsDir(path.join(agentDir, "skills"), "global", "pi"),
      scanSkillsDir(path.join(homeDir, ".agents", "skills"), "global", "agents"),
      workspacePath?.trim()
        ? scanSkillsDir(path.join(workspacePath, ".pi", "skills"), "project", "pi")
        : Promise.resolve([]),
      workspacePath?.trim()
        ? scanSkillsDir(path.join(workspacePath, ".agents", "skills"), "project", "agents")
        : Promise.resolve([]),
      readPiJsonObject(resolvePiSettingsFilePath(agentDir, "global"), false),
      workspacePath?.trim()
        ? readPiJsonObject(resolvePiSettingsFilePath(agentDir, "project", workspacePath), false)
        : Promise.resolve(null),
    ]);

  const patterns = [
    ...stringArray(globalSettings.data, "skills"),
    ...(projSettings ? stringArray(projSettings.data, "skills") : []),
  ];

  const all = [...globalPi, ...globalAgents, ...projPi, ...projAgents];
  return all
    .map((skill) => {
      let enabled = true;
      const folderName = path.basename(skill.folderPath);
      const posixFolder = toPosix(skill.folderPath);
      for (const raw of patterns) {
        const t = raw.trim();
        const isDisable = t.startsWith("-") || t.startsWith("!");
        const isEnable = t.startsWith("+");
        const pat = isDisable || isEnable ? t.slice(1).trim() : "";
        if (!pat) continue;
        if (
          pat === skill.name ||
          pat === folderName ||
          pat === `skills/${folderName}` ||
          toPosix(pat) === posixFolder
        ) {
          enabled = isEnable;
        }
      }
      return { ...skill, enabled };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function setPiSkillEnabled(input: {
  agentDir: string;
  skillNameOrPath: string;
  enabled: boolean;
  scope?: PiConfigScope | undefined;
  workspacePath?: string | undefined;
}): Promise<PiSkillEntry[]> {
  const token = input.skillNameOrPath.trim();
  if (!token || hasControlChars(token)) throw new Error("Invalid skill identifier");
  const scope = input.scope ?? "global";
  await mutatePiSettingsJson(input.agentDir, scope, input.workspacePath, (data) => {
    const filtered = stringArray(data, "skills").filter((e) => {
      const t = e.trim();
      return t !== `-${token}` && t !== `!${token}` && t !== `+${token}` && t !== token;
    });
    if (!input.enabled) filtered.push(`-${token}`);
    else if (scope === "project") filtered.push(`+${token}`);
    if (filtered.length === 0) deleteNestedValue(data, "skills");
    else data["skills"] = filtered;
    return { write: true, result: undefined };
  });
  return listPiSkills(input.agentDir, input.workspacePath);
}

export async function importPiSkillFolder(input: {
  agentDir: string;
  sourceDir: string;
  scope?: PiConfigScope | undefined;
  workspacePath?: string | undefined;
}): Promise<PiSkillEntry[]> {
  const src = path.resolve(input.sourceDir.trim());
  const srcStat = await stat(src);
  if (!srcStat.isDirectory()) throw new Error("Skill source must be a directory");
  const skillMd = await readPiTextIfExists(path.join(src, "SKILL.md"));
  if (skillMd === null) throw new Error("Selected folder does not contain SKILL.md");
  const folderName = path.basename(src);
  if (!SAFE_NAME_RE.test(folderName)) throw new Error(`Invalid skill folder name: "${folderName}"`);
  const targetRoot =
    input.scope === "project" && input.workspacePath?.trim()
      ? path.join(input.workspacePath, ".pi", "skills")
      : path.join(input.agentDir, "skills");
  await mkdir(targetRoot, { recursive: true });
  const dest = path.join(targetRoot, folderName);
  if (!isInsideDir(dest, targetRoot)) throw new Error("Invalid skill destination path");
  await cp(src, dest, { recursive: true, force: true });
  return listPiSkills(input.agentDir, input.workspacePath);
}

export async function deletePiSkillFolder(input: {
  agentDir: string;
  folderPath: string;
  workspacePath?: string | undefined;
}): Promise<PiSkillEntry[]> {
  const target = path.resolve(input.folderPath.trim());
  const allowedRoots = [path.join(input.agentDir, "skills")];
  if (input.workspacePath?.trim()) {
    allowedRoots.push(path.join(input.workspacePath, ".pi", "skills"));
  }
  if (!allowedRoots.some((root) => isInsideDir(target, root))) {
    throw new Error("Refusing to delete path outside managed Pi skills directories");
  }
  await rm(target, { recursive: true, force: true });
  return listPiSkills(input.agentDir, input.workspacePath);
}

async function scanPromptsDir(dir: string, scope: PiConfigScope): Promise<PiPromptTemplate[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    return [];
  }
  const out: PiPromptTemplate[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.name.endsWith(".md") || !entry.isFile()) continue;
    const raw = await readFile(path.join(dir, entry.name), "utf8").catch(() => null);
    if (raw === null) continue;
    const fm = parseSimpleFrontmatter(raw);
    const firstLine =
      fm.body
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean) ?? "";
    const description =
      fm.description || (firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine);
    out.push({
      name: entry.name.slice(0, -3),
      scope,
      description,
      fileName: entry.name,
      content: stripBom(raw),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listPiPromptTemplates(
  agentDir: string,
  workspacePath?: string | null,
): Promise<PiPromptTemplate[]> {
  const [globalList, projectList] = await Promise.all([
    scanPromptsDir(path.join(agentDir, "prompts"), "global"),
    workspacePath?.trim()
      ? scanPromptsDir(path.join(workspacePath, ".pi", "prompts"), "project")
      : Promise.resolve([]),
  ]);
  return [...globalList, ...projectList];
}

export async function savePiPromptTemplate(input: {
  agentDir: string;
  name: string;
  content: string;
  scope?: PiConfigScope | undefined;
  workspacePath?: string | undefined;
}): Promise<PiPromptTemplate[]> {
  const cleanName = input.name.trim().replace(/\.md$/i, "");
  if (!SAFE_NAME_RE.test(cleanName)) {
    throw new Error(`Invalid prompt template name: "${input.name}"`);
  }
  const dir =
    input.scope === "project" && input.workspacePath?.trim()
      ? path.join(input.workspacePath, ".pi", "prompts")
      : path.join(input.agentDir, "prompts");
  const filePath = path.join(dir, `${cleanName}.md`);
  if (!isInsideDir(filePath, dir)) throw new Error("Invalid prompt path");
  await atomicWritePiFile(filePath, input.content, { backup: true, tag: "pi-prompt" });
  return listPiPromptTemplates(input.agentDir, input.workspacePath);
}

export async function deletePiPromptTemplate(input: {
  agentDir: string;
  fileName: string;
  scope?: PiConfigScope | undefined;
  workspacePath?: string | undefined;
}): Promise<PiPromptTemplate[]> {
  const rawName = input.fileName.trim();
  const base = path.basename(rawName);
  if (
    rawName !== base ||
    rawName.includes("/") ||
    rawName.includes("\\") ||
    !base.endsWith(".md") ||
    !SAFE_NAME_RE.test(base.slice(0, -3))
  ) {
    throw new Error(`Invalid prompt file name: "${input.fileName}"`);
  }
  const dir =
    input.scope === "project" && input.workspacePath?.trim()
      ? path.join(input.workspacePath, ".pi", "prompts")
      : path.join(input.agentDir, "prompts");
  const filePath = path.join(dir, base);
  if (!isInsideDir(filePath, dir)) throw new Error("Invalid prompt path");
  await unlink(filePath).catch((err: unknown) => {
    if (!isEnoent(err)) throw err;
  });
  return listPiPromptTemplates(input.agentDir, input.workspacePath);
}
