/**
 * Pi 流式 `row.delta` 合帧器（~24ms 窗口，40 FPS 上限）：
 * - 将高频 token 级 `row.delta`（thinking_delta / text_delta / toolcall_delta）按 `(rowId, path)` 合并拼接，
 *   大幅降低 Electron IPC 序列化与渲染进程 React commit 频率；
 * - 遇到任意结构性变更（`bumpRevision`、`row.appended`、`row.upserted`、`state.updated`、停止/订阅/重同步）
 *   立即同步 flush，严格保持 `seq` 连续性与零顺序错乱。
 */
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import type { ProjectionCommit } from "#src/pi-runtime/domain/piEventProjector.js";

const DEFAULT_COALESCE_WINDOW_MS = 24;

export function isCoalesceableDeltaCommit(commit: ProjectionCommit): boolean {
  if (commit.deltas.length === 0) return false;
  return commit.deltas.every((delta) => delta.op === "row.delta");
}

/** 仅结构性状态/阶段/用量或新用户消息变更才需要通知侧栏索引与 SQLite，避免流式增量风暴。 */
export function shouldNotifySessionIndexForCommit(commit: ProjectionCommit): boolean {
  return commit.deltas.some(
    (delta) =>
      delta.op === "state.updated" ||
      (delta.op === "row.appended" && delta.row.kind === "userInput"),
  );
}

function mergeRowDeltas(target: ConversationDelta[], incoming: readonly ConversationDelta[]): void {
  for (const delta of incoming) {
    const last = target[target.length - 1];
    if (
      last &&
      last.op === "row.delta" &&
      delta.op === "row.delta" &&
      last.rowId === delta.rowId &&
      last.path === delta.path
    ) {
      target[target.length - 1] = {
        op: "row.delta",
        rowId: last.rowId,
        path: last.path,
        append: last.append + delta.append,
      };
    } else {
      target.push(delta);
    }
  }
}

export class PiDeltaCoalescer {
  private readonly windowMs: number;
  private readonly onFlush: (commit: ProjectionCommit) => void;
  private pending: ProjectionCommit | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(onFlush: (commit: ProjectionCommit) => void, windowMs = DEFAULT_COALESCE_WINDOW_MS) {
    this.onFlush = onFlush;
    this.windowMs = windowMs;
  }

  enqueue(commit: ProjectionCommit): void {
    if (!isCoalesceableDeltaCommit(commit)) {
      this.flushNow();
      this.onFlush(commit);
      return;
    }

    if (!this.pending) {
      this.pending = {
        fromSeq: commit.fromSeq,
        toSeq: commit.toSeq,
        deltas: [...commit.deltas],
      };
    } else if (this.pending.toSeq + 1 === commit.fromSeq) {
      const mergedDeltas = [...this.pending.deltas];
      mergeRowDeltas(mergedDeltas, commit.deltas);
      this.pending = {
        fromSeq: this.pending.fromSeq,
        toSeq: commit.toSeq,
        deltas: mergedDeltas,
      };
    } else {
      // seq 出现非连续跳变（如恢复帧）时先刷出旧缓冲再缓存新批次。
      this.flushNow();
      this.pending = {
        fromSeq: commit.fromSeq,
        toSeq: commit.toSeq,
        deltas: [...commit.deltas],
      };
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flushNow();
      }, this.windowMs);
      this.timer.unref?.();
    }
  }

  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    this.pending = null;
    if (batch && batch.deltas.length > 0) {
      this.onFlush(batch);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }
}
