/**
 * Pi `.jsonl` 会话文件按 userOrdinal 安全就地截断与重新水合适配器（零循环依赖）。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { computePiJsonlRewindBeforeUserOrdinal } from "#src/pi-runtime/domain/piJsonlBranchParser.js";
import {
  hydratePiJsonlSession,
  type HydratedPiSessionResult,
} from "#src/pi-runtime/domain/piJsonlHydrator.js";
import type { PiModelCatalog } from "#src/pi-runtime/adapters/piModelCatalog.js";

/** 按 userOrdinal 就地原子截断 Pi `.jsonl` 并重新水合（保留 `.rewound-*.bak` 备份）。 */
export async function rewindPiSessionFileBeforeOrdinal(input: {
  readonly filePath: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly userOrdinal: number;
  readonly catalog: PiModelCatalog;
}): Promise<HydratedPiSessionResult | null> {
  if (!existsSync(input.filePath)) return null;
  const raw = await readFile(input.filePath, "utf8");
  const computed = computePiJsonlRewindBeforeUserOrdinal(raw, input.userOrdinal);
  if (!computed) return null;
  const backupPath = `${input.filePath}.rewound-${Date.now()}.bak`;
  await writeFile(backupPath, raw, "utf8").catch(() => {});
  const tmpPath = `${input.filePath}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, computed.nextText, "utf8");
  await rename(tmpPath, input.filePath);
  const snap = input.catalog.getSnapshot();
  return hydratePiJsonlSession({
    rawContent: computed.nextText,
    fallbackSessionId: input.sessionId,
    fallbackCwd: input.cwd,
    fallbackMtimeMs: Date.now(),
    catalogModels: snap.models,
    defaultModel: snap.defaultModel,
    defaultThinkingLevel: snap.defaultThinkingLevel,
  });
}
