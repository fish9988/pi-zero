/**
 * Pi 离线水合快照与旧版 ZCode 只读历史存档快照纯构造器（domain 层，无 IO/计时器）。
 */
import {
  PROTOCOL_V4_LIMITS,
  type ConversationSnapshot,
  type QueueState,
  type SessionConfigState,
  type SessionPhase,
  type WireConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  computeInputRouting,
  computeSessionAvailability,
  computeSessionControl,
  createInitialConversationSnapshot,
  createInitialSessionConfig,
} from "#src/pi-runtime/domain/piSnapshotFactory.js";

const LEGACY_READ_ONLY_REASON = "guard.legacySessionReadOnly";
const DEFAULT_LEGACY_ARCHIVE_NOTICE =
  "此会话来自旧版 ZCode 历史存档，当前以只读模式展示；请新建会话以使用 Pi 运行时继续对话。";

/** 构造离线水合后的 Pi 会话快照（0 子进程启动，保留尾窗与完整分页基线）。 */
export function createHydratedConversationSnapshot(input: {
  sessionId: string;
  logEpoch: string;
  attemptId: string;
  phase: SessionPhase;
  config: SessionConfigState;
  title: string;
  titleSource: "default" | "generated" | "custom";
  usage: ConversationSnapshot["usage"];
  rows: readonly WireConversationRow[];
}): ConversationSnapshot {
  const queue: QueueState = { items: [], autoDrain: true };
  const tailCap = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
  const window =
    input.rows.length > tailCap ? input.rows.slice(input.rows.length - tailCap) : [...input.rows];
  return {
    ...createInitialConversationSnapshot({
      sessionId: input.sessionId,
      logEpoch: input.logEpoch,
      attemptId: input.attemptId,
      config: input.config,
      title: input.title,
      titleSource: input.titleSource,
    }),
    seq: input.rows.length,
    revision: 1,
    control: computeSessionControl({
      phase: input.phase,
      stopState: "idle",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    }),
    availability: computeSessionAvailability(input.phase, queue),
    inputRouting: computeInputRouting(input.phase, input.config.followupMode, queue),
    usage: input.usage,
    rows: {
      window,
      totalCount: input.rows.length,
      firstRowId: input.rows[0]?.rowId ?? null,
    },
  };
}

/**
 * 构造旧版 ZCode 历史会话的只读存档快照（严格通过 `conversationSnapshotSchema` 校验）：
 * - `inputRouting = { mode: "reject", reasonCode: "guard.legacySessionReadOnly" }`；
 * - 所有动作 `availability` 均置为 `{ allowed: false, reasonCode: "guard.legacySessionReadOnly" }`；
 * - 携带可选的已提取历史消息行与清晰的只读存档提示行。
 */
export function createLegacyReadOnlyConversationSnapshot(input: {
  sessionId: string;
  logEpoch: string;
  attemptId: string;
  nowMs: number;
  title?: string | undefined;
  recoveredRows?: readonly WireConversationRow[] | undefined;
  noticeText?: string | undefined;
}): { readonly snapshot: ConversationSnapshot; readonly rows: WireConversationRow[] } {
  const rows: WireConversationRow[] = [...(input.recoveredRows ?? [])];
  const lastRowId = rows.reduce((max, row) => Math.max(max, row.rowId), 0);
  const noticeTurnId = "turn_legacy_archive";
  const headerRowId = lastRowId + 1;
  const noticeRowId = lastRowId + 2;
  const noticeText = input.noticeText?.trim() || DEFAULT_LEGACY_ARCHIVE_NOTICE;
  rows.push(
    {
      kind: "turnHeader",
      rowId: headerRowId,
      turnId: noticeTurnId,
      entityId: noticeTurnId,
      productTurnId: noticeTurnId,
      visibility: "visible",
      createdAt: input.nowMs,
      createdAtSeq: headerRowId,
      origin: "userInput",
      executionKind: "controlOnly",
      state: "completedSuccess",
      startedAt: input.nowMs,
      endedAt: input.nowMs,
      activeMs: 1,
    },
    {
      kind: "assistantText",
      rowId: noticeRowId,
      turnId: noticeTurnId,
      entityId: `text_${noticeRowId}`,
      productTurnId: noticeTurnId,
      visibility: "visible",
      createdAt: input.nowMs,
      createdAtSeq: noticeRowId,
      text: noticeText,
      state: "complete",
    },
  );

  const disallowed = { allowed: false as const, reasonCode: LEGACY_READ_ONLY_REASON };
  const tailCap = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
  const window = rows.length > tailCap ? rows.slice(rows.length - tailCap) : [...rows];
  const snapshot: ConversationSnapshot = {
    ...createInitialConversationSnapshot({
      sessionId: input.sessionId,
      logEpoch: input.logEpoch,
      attemptId: input.attemptId,
      config: createInitialSessionConfig({}),
      title: input.title?.trim() || "",
      titleSource: "default",
    }),
    seq: rows.length,
    revision: 1,
    control: computeSessionControl({
      phase: "completedSuccess",
      stopState: "idle",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    }),
    availability: {
      fork: disallowed,
      compact: disallowed,
      switchModelConfig: disallowed,
      setFollowupMode: disallowed,
      queueEdit: disallowed,
      sendQueuedNow: disallowed,
      pauseGoal: disallowed,
      resumeGoal: disallowed,
      rewindFiles: disallowed,
    },
    inputRouting: { mode: "reject", reasonCode: LEGACY_READ_ONLY_REASON },
    rows: {
      window,
      totalCount: rows.length,
      firstRowId: rows[0]?.rowId ?? null,
    },
  };
  return { snapshot, rows };
}
