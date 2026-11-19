/**
 * Pi v3 `.jsonl` 会话分支树构建、安全就地回退（rewindTo）、分叉（fork）与离线 HTML 导出（纯 domain 层，0 IO）。
 */
import type { PiSessionTreeNode, PiSessionTreeSnapshot } from "@zcode/shared/pi-config";
import { isPlainRecord } from "./piConfigHelpers.js";

interface RawJsonlLine {
  readonly text: string;
  readonly parsed: Record<string, unknown> | null;
  readonly id: string | null;
  readonly parentId: string | null;
  readonly type: string;
}

function parseRawJsonlLines(rawContent: string): {
  headerLine: string | null;
  headerObj: Record<string, unknown> | null;
  lines: RawJsonlLine[];
} {
  let headerLine: string | null = null;
  let headerObj: Record<string, unknown> | null = null;
  const lines: RawJsonlLine[] = [];
  for (const raw of rawContent.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      lines.push({ text: line, parsed: null, id: null, parentId: null, type: "invalid" });
      continue;
    }
    if (!isPlainRecord(parsed) || typeof parsed["type"] !== "string") {
      lines.push({ text: line, parsed: null, id: null, parentId: null, type: "invalid" });
      continue;
    }
    if (parsed["type"] === "session" && headerLine === null) {
      headerLine = line;
      headerObj = parsed;
      continue;
    }
    lines.push({
      text: line,
      parsed,
      id: typeof parsed["id"] === "string" && parsed["id"].trim() !== "" ? parsed["id"] : null,
      parentId:
        typeof parsed["parentId"] === "string" && parsed["parentId"].trim() !== ""
          ? parsed["parentId"]
          : null,
      type: parsed["type"],
    });
  }
  return { headerLine, headerObj, lines };
}

function parseTs(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return fallback;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isPlainRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    } else if (block["type"] === "toolCall" && typeof block["name"] === "string") {
      parts.push(`[Tool: ${block["name"]}]`);
    }
  }
  return parts.join(" ").trim();
}

function trimPreview(text: string, maxLen = 120): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= maxLen) return single;
  return `${single.slice(0, maxLen - 1)}…`;
}

/** 从 Pi v3 `.jsonl` 文本构建完整分支树快照（标出活动分支、叶子节点与可回退用户节点）。 */
export function buildPiSessionTreeSnapshot(input: {
  sessionId: string;
  sessionFile: string | null;
  rawContent: string;
}): PiSessionTreeSnapshot {
  const { lines } = parseRawJsonlLines(input.rawContent);
  const byId = new Map<string, RawJsonlLine>();
  const labelsByTarget = new Map<string, string>();
  let leafId: string | null = null;

  for (const line of lines) {
    if (line.id) {
      byId.set(line.id, line);
      leafId = line.id;
    }
    if (
      line.type === "label" &&
      line.parsed &&
      typeof line.parsed["targetId"] === "string" &&
      typeof line.parsed["label"] === "string"
    ) {
      labelsByTarget.set(line.parsed["targetId"], line.parsed["label"]);
    }
  }

  const activeIds = new Set<string>();
  let cursor = leafId;
  while (cursor && !activeIds.has(cursor)) {
    activeIds.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    cursor = node.parentId;
  }

  const nodes: PiSessionTreeNode[] = [];
  for (const line of lines) {
    if (!line.id || !line.parsed) continue;
    if (line.type === "label" || line.type === "usage") continue;
    let role: string | undefined;
    let preview = "";
    let model: string | undefined;
    let canRewind = false;

    if (line.type === "message" && isPlainRecord(line.parsed["message"])) {
      const msg = line.parsed["message"];
      role = typeof msg["role"] === "string" ? msg["role"] : undefined;
      if (role === "system" || role === "toolResult") continue;
      if (role === "user") {
        preview = trimPreview(extractTextFromContent(msg["content"]) || "(empty prompt)");
        canRewind = true;
      } else if (role === "assistant") {
        preview = trimPreview(extractTextFromContent(msg["content"]) || "(assistant turn)");
        if (typeof msg["model"] === "string") model = msg["model"];
      } else if (role === "bashExecution") {
        const cmd = typeof msg["command"] === "string" ? msg["command"] : "";
        preview = trimPreview(`$ ${cmd}`);
      } else {
        preview = trimPreview(role ?? "message");
      }
    } else if (line.type === "compaction") {
      preview = trimPreview(
        typeof line.parsed["summary"] === "string"
          ? `Compaction: ${line.parsed["summary"]}`
          : "Context compacted",
      );
    } else if (line.type === "model_change") {
      const prov = typeof line.parsed["provider"] === "string" ? line.parsed["provider"] : "";
      const mod = typeof line.parsed["modelId"] === "string" ? line.parsed["modelId"] : "";
      model = prov && mod ? `${prov}/${mod}` : mod || undefined;
      preview = `Switched model -> ${model ?? "unknown"}`;
    } else if (line.type === "session_info" && typeof line.parsed["name"] === "string") {
      preview = `Renamed: ${trimPreview(line.parsed["name"])}`;
    } else {
      continue;
    }

    nodes.push({
      id: line.id,
      parentId: line.parentId,
      type: line.type,
      ...(role ? { role } : {}),
      preview,
      timestamp: parseTs(line.parsed["timestamp"]),
      isActiveBranch: activeIds.has(line.id),
      isLeaf: line.id === leafId,
      ...(labelsByTarget.has(line.id) ? { label: labelsByTarget.get(line.id) } : {}),
      ...(model ? { model } : {}),
      canRewind,
    });
  }

  return {
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    leafId,
    nodes,
  };
}

/**
 * 纯函数计算就地回退结果（移植自 pi-studio `pi-session-rewind.ts`）：
 * 移除 `entryId` 及其所有后代和后续坏行，并将父节点置为末尾叶子行；原行文本逐字节保留。
 */
export function computePiRewindJsonl(
  rawContent: string,
  entryId: string,
): {
  readonly nextText: string;
  readonly backupText: string;
  readonly droppedLines: number;
  readonly leafId: string | null;
} {
  const { headerLine, lines } = parseRawJsonlLines(rawContent);
  const target = lines.find((line) => line.id === entryId);
  if (!target) throw new Error(`Entry "${entryId}" not found in session file`);

  const byId = new Map<string, RawJsonlLine>();
  for (const line of lines) {
    if (line.id) byId.set(line.id, line);
  }
  const rewound = new Set<RawJsonlLine>([target]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const line of lines) {
      if (rewound.has(line) || !line.parentId) continue;
      const parent = byId.get(line.parentId);
      if (parent && rewound.has(parent)) {
        rewound.add(line);
        grew = true;
      }
    }
  }

  const targetIndex = lines.indexOf(target);
  const kept: RawJsonlLine[] = [];
  const removed: RawJsonlLine[] = [];
  lines.forEach((line, index) => {
    if (rewound.has(line) || (line.id === null && index > targetIndex)) removed.push(line);
    else kept.push(line);
  });

  const leafId = target.parentId;
  let cutLine: RawJsonlLine | null = null;
  if (leafId !== null) {
    cutLine = kept.find((line) => line.id === leafId) ?? null;
    if (!cutLine) {
      throw new Error(`Parent entry "${leafId}" missing from session file`);
    }
  }
  const ordered = cutLine === null ? [] : [...kept.filter((line) => line !== cutLine), cutLine];
  const bodyLines = ordered.map((line) => line.text);
  const nextText = `${(headerLine ? [headerLine, ...bodyLines] : bodyLines).join("\n")}\n`;
  const backupText = removed.length > 0 ? `${removed.map((line) => line.text).join("\n")}\n` : "";

  return {
    nextText,
    backupText,
    droppedLines: removed.length,
    leafId,
  };
}

/** 从指定节点（或当前活动叶节点）复制活动分支生成全新 Pi v3 `.jsonl` 会话内容。 */
export function computePiForkJsonl(input: {
  rawContent: string;
  newSessionId: string;
  fallbackCwd: string;
  nowIso: string;
  parentSession?: string | undefined;
  entryId?: string | null | undefined;
  title?: string | undefined;
}): { readonly content: string; readonly title: string; readonly cwd: string } {
  const { headerObj, lines } = parseRawJsonlLines(input.rawContent);
  const byId = new Map<string, RawJsonlLine>();
  let latestId: string | null = null;
  for (const line of lines) {
    if (line.id) {
      byId.set(line.id, line);
      latestId = line.id;
    }
  }
  const targetLeaf = input.entryId?.trim() || latestId;
  if (targetLeaf && !byId.has(targetLeaf)) {
    throw new Error(`Fork target entry "${targetLeaf}" not found in session file`);
  }

  const branch: RawJsonlLine[] = [];
  const seen = new Set<string>();
  let cursor = targetLeaf;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    branch.push(node);
    cursor = node.parentId;
  }
  branch.reverse();

  const cwd =
    headerObj && typeof headerObj["cwd"] === "string" && headerObj["cwd"].trim()
      ? headerObj["cwd"].trim()
      : input.fallbackCwd;
  const resolvedTitle = input.title?.trim() || "Forked Session";
  const newHeader = {
    type: "session",
    version: 3,
    id: input.newSessionId,
    timestamp: input.nowIso,
    cwd,
    ...(input.parentSession?.trim() ? { parentSession: input.parentSession.trim() } : {}),
  };
  const outLines = [JSON.stringify(newHeader), ...branch.map((line) => line.text)];
  const infoId = `fork_info_${input.newSessionId.slice(0, 8)}`;
  outLines.push(
    JSON.stringify({
      type: "session_info",
      id: infoId,
      parentId: branch[branch.length - 1]?.id ?? null,
      timestamp: input.nowIso,
      name: resolvedTitle,
    }),
  );
  return {
    content: `${outLines.join("\n")}\n`,
    title: resolvedTitle,
    cwd,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 将 Pi `.jsonl` 活动分支离线渲染为独立、XSS 安全、零外链的 HTML 归档页。 */
export function renderPiSessionToHtml(input: {
  rawContent: string;
  sessionId: string;
  exportedAtIso: string;
}): { readonly html: string; readonly title: string; readonly messageCount: number } {
  const { lines } = parseRawJsonlLines(input.rawContent);
  const byId = new Map<string, RawJsonlLine>();
  let leafId: string | null = null;
  for (const line of lines) {
    if (line.id) {
      byId.set(line.id, line);
      leafId = line.id;
    }
  }
  const active: RawJsonlLine[] = [];
  if (leafId) {
    const seen = new Set<string>();
    let cursor: string | null = leafId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = byId.get(cursor);
      if (!node) break;
      active.push(node);
      cursor = node.parentId;
    }
    active.reverse();
  } else {
    active.push(...lines);
  }

  let title = `Pi Session ${input.sessionId}`;
  let messageCount = 0;
  const blocks: string[] = [];

  for (const line of active) {
    if (!line.parsed) continue;
    if (
      line.type === "session_info" &&
      typeof line.parsed["name"] === "string" &&
      line.parsed["name"].trim()
    ) {
      title = line.parsed["name"].trim();
      continue;
    }
    if (line.type === "compaction") {
      blocks.push(`<div class="marker">Context compacted</div>`);
      continue;
    }
    if (line.type !== "message" || !isPlainRecord(line.parsed["message"])) continue;
    const msg = line.parsed["message"];
    const role = msg["role"];
    if (role === "system" || role === "toolResult") continue;
    if (role === "user") {
      messageCount += 1;
      const body = extractTextFromContent(msg["content"]);
      blocks.push(
        `<article class="msg user"><div class="role">User</div><pre class="body">${escapeHtml(body)}</pre></article>`,
      );
    } else if (role === "assistant") {
      messageCount += 1;
      const content = Array.isArray(msg["content"]) ? msg["content"] : [];
      const parts: string[] = [];
      for (const item of content) {
        if (!isPlainRecord(item)) continue;
        if (item["type"] === "thinking" && typeof item["thinking"] === "string") {
          parts.push(
            `<details class="thinking"><summary>Thinking</summary><pre>${escapeHtml(item["thinking"])}</pre></details>`,
          );
        } else if (item["type"] === "toolCall" && typeof item["name"] === "string") {
          parts.push(`<div class="tool">Tool: <code>${escapeHtml(item["name"])}</code></div>`);
        } else if (item["type"] === "text" && typeof item["text"] === "string") {
          parts.push(`<pre class="body">${escapeHtml(item["text"])}</pre>`);
        }
      }
      blocks.push(
        `<article class="msg assistant"><div class="role">Assistant</div>${parts.join("")}</article>`,
      );
    }
  }

  const safeTitle = escapeHtml(title);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 860px; margin: 32px auto; padding: 0 20px; background: #0f1115; color: #e6e8ec; line-height: 1.6; }
  header { border-bottom: 1px solid #262a34; padding-bottom: 14px; margin-bottom: 24px; }
  header h1 { margin: 0 0 6px; font-size: 20px; }
  header .meta { font-size: 12px; color: #949ba8; }
  .msg { border: 1px solid #262a34; border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; background: #161922; }
  .msg.user { background: #1b2232; border-color: #2c3a57; }
  .role { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #8b95a7; margin-bottom: 8px; font-weight: 600; }
  pre.body { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; }
  details.thinking { margin-bottom: 10px; padding: 8px 10px; border-radius: 6px; background: #11141c; color: #9aa3b2; font-size: 13px; }
  details.thinking pre { white-space: pre-wrap; margin: 6px 0 0; font-family: inherit; }
  .tool { font-size: 12px; color: #9ec5fe; margin: 6px 0; }
  .marker { text-align: center; font-size: 12px; color: #8b95a7; margin: 16px 0; }
</style>
</head>
<body>
<header>
  <h1>${safeTitle}</h1>
  <div class="meta">Session ${escapeHtml(input.sessionId)} · Exported ${escapeHtml(input.exportedAtIso)} · ${messageCount} messages</div>
</header>
<main>${blocks.join("\n")}</main>
</body>
</html>`;

  return { html, title, messageCount };
}
