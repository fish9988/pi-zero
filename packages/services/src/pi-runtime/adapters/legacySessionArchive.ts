/**
 * 旧版 ZCode 历史会话数据库只读回落读取器（adapters 层，严格 `{ readOnly: true }`）。
 *
 * 定位规则与 `packages/services/src/onboarding/localUsageEvidence.ts` 一致：
 * - 优先 `ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB` 环境变量；
 * - 否则回落 `<home>/.zcode/cli/db/db.sqlite`（尊重 `HOME`/`USERPROFILE` 隔离）；
 * - 严禁写入或修改历史库；句柄必须在 `finally` 内确定关闭；库缺失或表结构未知时安全返回 null。
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WireConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildAssistantTextRow,
  buildTurnHeaderRow,
  buildUserInputRow,
} from "#src/pi-runtime/domain/piRowBuilders.js";

const MAX_RECOVERED_MESSAGES = 200;

export interface LegacyArchiveLookupResult {
  readonly title?: string | undefined;
  readonly recoveredRows: WireConversationRow[];
}

function resolveIsolatedHomeDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env["HOME"]?.trim() || env["USERPROFILE"]?.trim();
  return fromEnv || homedir();
}

function resolveLegacySessionDbPath(env: NodeJS.ProcessEnv): string | null {
  let configured: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if ((key === "ZCODE_SESSION_DB_PATH" || key === "ZCODE_SESSION_DB") && value?.trim()) {
      configured = value.trim();
    }
  }
  const home = resolveIsolatedHomeDir(env);
  if (configured) {
    if (configured.startsWith("~/")) return join(home, configured.slice(2));
    return isAbsolute(configured) ? configured : null;
  }
  return join(home, ".zcode", "cli", "db", "db.sqlite");
}

function extractReadableText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const texts = parsed
          .map((item) =>
            typeof item === "object" &&
            item !== null &&
            "text" in item &&
            typeof (item as { text?: unknown }).text === "string"
              ? (item as { text: string }).text
              : "",
          )
          .filter((part) => part.length > 0);
        if (texts.length > 0) return texts.join("\n");
      } else if (
        typeof parsed === "object" &&
        parsed !== null &&
        "text" in parsed &&
        typeof (parsed as { text?: unknown }).text === "string"
      ) {
        return (parsed as { text: string }).text;
      }
    } catch {
      // 普通文本，原样返回。
    }
  }
  return trimmed;
}

function listTableColumns(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  const cols = new Set<string>();
  for (const row of rows) {
    if (typeof row.name === "string") cols.add(row.name);
  }
  return cols;
}

function buildRowsFromLegacyMessages(
  messages: readonly { role: string; text: string; createdAt: number }[],
): WireConversationRow[] {
  const rows: WireConversationRow[] = [];
  let rowId = 0;
  let turnIndex = 0;
  let activeTurnId: string | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      turnIndex += 1;
      activeTurnId = `legacy_turn_${turnIndex}`;
      const headerId = ++rowId;
      const userId = ++rowId;
      rows.push(
        {
          ...buildTurnHeaderRow({
            rowId: headerId,
            turnId: activeTurnId,
            createdAt: msg.createdAt,
            createdAtSeq: headerId,
          }),
          state: "completedSuccess",
          endedAt: msg.createdAt,
          activeMs: 1,
        },
        buildUserInputRow({
          rowId: userId,
          turnId: activeTurnId,
          createdAt: msg.createdAt,
          createdAtSeq: userId,
          text: msg.text,
          commandId: `legacy_${userId}`,
          clientId: "legacy-archive",
        }),
      );
    } else if (msg.role === "assistant") {
      if (!activeTurnId) {
        turnIndex += 1;
        activeTurnId = `legacy_turn_${turnIndex}`;
        const headerId = ++rowId;
        rows.push({
          ...buildTurnHeaderRow({
            rowId: headerId,
            turnId: activeTurnId,
            createdAt: msg.createdAt,
            createdAtSeq: headerId,
          }),
          state: "completedSuccess",
          endedAt: msg.createdAt,
          activeMs: 1,
        });
      }
      const asstId = ++rowId;
      rows.push(
        buildAssistantTextRow({
          rowId: asstId,
          turnId: activeTurnId,
          createdAt: msg.createdAt,
          createdAtSeq: asstId,
          text: msg.text,
          state: "complete",
        }),
      );
    }
  }
  return rows;
}

/**
 * 只读尝试从旧版 ZCode CLI SQLite 库提取指定会话标题与可见文本消息。
 * 库不存在、不可读或模式不匹配时一律返回 null，绝不抛错或阻断只读存档打开。
 */
export async function readLegacyZCodeArchiveSession(
  sessionId: string,
  options?: { readonly env?: NodeJS.ProcessEnv | undefined },
): Promise<LegacyArchiveLookupResult | null> {
  const dbPath = resolveLegacySessionDbPath(options?.env ?? process.env);
  if (!dbPath) return null;
  try {
    await stat(dbPath);
  } catch {
    return null;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 1000");

    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name?: unknown }>;
    const tables = new Set(
      tableRows.map((row) => (typeof row.name === "string" ? row.name : "")).filter(Boolean),
    );

    let title: string | undefined;
    const sessionTable = tables.has("session")
      ? "session"
      : tables.has("sessions")
        ? "sessions"
        : null;
    if (sessionTable) {
      const cols = listTableColumns(db, sessionTable);
      const idCol = cols.has("id") ? "id" : cols.has("session_id") ? "session_id" : null;
      if (idCol && cols.has("title")) {
        const found = db
          .prepare(`SELECT title FROM ${sessionTable} WHERE ${idCol} = ? LIMIT 1`)
          .get(sessionId) as { title?: unknown } | undefined;
        if (typeof found?.title === "string" && found.title.trim()) {
          title = found.title.trim();
        }
      }
    }

    const messageTable = tables.has("message")
      ? "message"
      : tables.has("messages")
        ? "messages"
        : null;
    const recoveredMessages: Array<{ role: string; text: string; createdAt: number }> = [];
    if (messageTable) {
      const cols = listTableColumns(db, messageTable);
      const sidCol = cols.has("session_id")
        ? "session_id"
        : cols.has("sessionId")
          ? "sessionId"
          : null;
      const roleCol = cols.has("role") ? "role" : null;
      const contentCol = cols.has("content")
        ? "content"
        : cols.has("text")
          ? "text"
          : cols.has("data")
            ? "data"
            : null;
      const tsCol = cols.has("created_at")
        ? "created_at"
        : cols.has("timestamp")
          ? "timestamp"
          : null;
      if (sidCol && roleCol && contentCol) {
        const selectTs = tsCol ? `, ${tsCol} AS ts` : "";
        const rawRows = db
          .prepare(
            `SELECT ${roleCol} AS role, ${contentCol} AS content${selectTs} FROM ${messageTable} WHERE ${sidCol} = ? LIMIT ${MAX_RECOVERED_MESSAGES}`,
          )
          .all(sessionId) as Array<{ role?: unknown; content?: unknown; ts?: unknown }>;
        const now = Date.now();
        for (const row of rawRows) {
          const role = typeof row.role === "string" ? row.role.toLowerCase() : "";
          if (role !== "user" && role !== "assistant") continue;
          const text = extractReadableText(row.content);
          if (!text) continue;
          const createdAt =
            typeof row.ts === "number" && Number.isFinite(row.ts) && row.ts > 0
              ? Math.trunc(row.ts)
              : now;
          recoveredMessages.push({ role, text, createdAt });
        }
      }
    }

    if (!title && recoveredMessages.length === 0) return null;
    return {
      title,
      recoveredRows: buildRowsFromLegacyMessages(recoveredMessages),
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // 忽略关闭错误。
    }
  }
}
