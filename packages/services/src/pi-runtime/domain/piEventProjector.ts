/**
 * Pi RPC 流式事件 -> ZCode V4 ConversationSnapshot / ConversationDelta 纯投影器（domain 层）。
 * 严禁引入任何 Node IO、网络或计时器依赖；所有时间戳均由调用方显式传入 `nowMs`。
 */
import type { ModelSelection } from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  type ConversationDelta,
  type ConversationSnapshot,
  type QueueState,
  type SessionConfigState,
  type SessionErrorInfo,
  type StatePatch,
  type TurnHeaderRow,
  type WireConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { PiRpcEvent } from "#src/pi-runtime/domain/piRpcTypes.js";
import {
  clearQueueItems,
  enqueueQueueText,
  pauseQueueWithReason,
} from "#src/pi-runtime/domain/piQueueProjector.js";
import {
  appendGuidedWorkSegment,
  buildPhaseTransitionPatch,
  buildTurnHeaderRow,
  buildUserInputRow,
} from "#src/pi-runtime/domain/piRowBuilders.js";
import {
  computeInputRouting,
  computeSessionAvailability,
  computeSessionControl,
  createInitialConversationSnapshot,
  deriveSessionTitle,
  isSessionRunningPhase,
} from "#src/pi-runtime/domain/piSnapshotFactory.js";
import { reducePiStreamEvent } from "#src/pi-runtime/domain/piStreamEventReducer.js";
import {
  buildTurnSettlementDeltas,
  type PiProjectorRuntimeState,
} from "#src/pi-runtime/domain/piTurnSettlement.js";

export interface ProjectionCommit {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly deltas: readonly ConversationDelta[];
}

export interface BeginUserTurnInput {
  readonly commandId: string;
  readonly clientId: string;
  readonly text: string;
  readonly nowMs: number;
  readonly modelSelection?: ModelSelection | undefined;
  readonly inputOrigin?: "desktop" | "mobile" | undefined;
  readonly recordEchoExpectation?: boolean | undefined;
}

export interface RecordGuidedInputParams {
  readonly commandId: string;
  readonly clientId: string;
  readonly text: string;
  readonly nowMs: number;
  readonly modelSelection?: ModelSelection | undefined;
  readonly inputOrigin?: "desktop" | "mobile" | undefined;
}

export class PiEventProjector {
  private readonly allRows: WireConversationRow[] = [];
  private readonly rowIndexById = new Map<number, number>();
  private readonly state: PiProjectorRuntimeState;

  constructor(input: {
    sessionId: string;
    logEpoch: string;
    attemptId: string;
    config: SessionConfigState;
    contextWindowMax?: number | undefined;
    title?: string | undefined;
    titleSource?: "default" | "generated" | "custom" | undefined;
  }) {
    const initialSnapshot = createInitialConversationSnapshot(input);
    this.state = {
      snapshot: initialSnapshot,
      nextRowId: 0,
      turnCounter: 0,
      responseCounter: 0,
      segmentCounter: 0,
      admissionCounter: 0,
      agentLifecycleSeq: 0,
      contextWindowMax: input.contextWindowMax ?? 0,
      lastAssistantPreview: undefined,
      activeTurnId: null,
      activeTurnHeaderRowId: null,
      activeTurnStartedAt: 0,
      activeWorkSegments: undefined,
      currentResponseId: undefined,
      activeReasoningRowId: null,
      activeReasoningStartedAt: 0,
      activeTextRowId: null,
      emittedTextInCurrentAssistantMsg: false,
      turnOutputTokens: 0,
      turnAborted: false,
      turnFailedError: null,
      stoppingRequested: false,
      activeCompactionRowId: null,
      activeCompactionOrigin: "auto",
      pendingUserEchoes: [],
      getRowById: (rowId) => this.getRowById(rowId),
    };
  }

  getSnapshot(): ConversationSnapshot {
    return this.state.snapshot;
  }

  getAllRows(): readonly WireConversationRow[] {
    return this.allRows;
  }

  getSeq(): number {
    return this.state.snapshot.seq;
  }

  getRevision(): number {
    return this.state.snapshot.revision;
  }

  getLogEpoch(): string {
    return this.state.snapshot.logEpoch;
  }

  getAgentLifecycleSeq(): number {
    return this.state.agentLifecycleSeq;
  }

  getLastAssistantPreview(): string | undefined {
    return this.state.lastAssistantPreview;
  }

  setContextWindowMax(maxTokens: number | undefined): void {
    if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
      this.state.contextWindowMax = Math.floor(maxTokens);
    }
  }

  getRowsRange(
    beforeRowId: number | undefined,
    limit: number,
  ): { rows: WireConversationRow[]; hasMore: boolean } {
    const bounded = Math.max(1, Math.min(limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit));
    const filtered =
      beforeRowId === undefined
        ? this.allRows
        : this.allRows.filter((row) => row.rowId < beforeRowId);
    const start = Math.max(0, filtered.length - bounded);
    return { rows: filtered.slice(start), hasMore: start > 0 };
  }

  findTurnForCommand(
    commandId: string,
  ): { turnId: string; state: TurnHeaderRow["state"] } | undefined {
    for (let index = this.allRows.length - 1; index >= 0; index -= 1) {
      const row = this.allRows[index];
      if (row && row.kind === "turnHeader" && row.sourceCommandId === commandId) {
        return { turnId: row.turnId, state: row.state };
      }
    }
    return undefined;
  }

  beginUserTurn(input: BeginUserTurnInput): ProjectionCommit | null {
    const baseSeq = this.state.snapshot.seq;
    this.state.turnCounter += 1;
    const turnId = `turn_${this.state.turnCounter}`;
    const headerRowId = ++this.state.nextRowId;
    const userRowId = ++this.state.nextRowId;

    const deltas: ConversationDelta[] = [
      {
        op: "row.appended",
        row: buildTurnHeaderRow({
          rowId: headerRowId,
          turnId,
          createdAt: input.nowMs,
          createdAtSeq: baseSeq + 1,
          sourceCommandId: input.commandId,
        }),
      },
      {
        op: "row.appended",
        row: buildUserInputRow({
          rowId: userRowId,
          turnId,
          createdAt: input.nowMs,
          createdAtSeq: baseSeq + 2,
          text: input.text,
          commandId: input.commandId,
          clientId: input.clientId,
          modelSelection: input.modelSelection ?? this.state.snapshot.config.modelSelection,
          inputOrigin: input.inputOrigin,
        }),
      },
    ];

    this.state.activeTurnId = turnId;
    this.state.activeTurnHeaderRowId = headerRowId;
    this.state.activeTurnStartedAt = input.nowMs;
    this.state.activeWorkSegments = undefined;
    this.state.currentResponseId = undefined;
    this.state.activeReasoningRowId = null;
    this.state.activeTextRowId = null;
    this.state.emittedTextInCurrentAssistantMsg = false;
    this.state.turnOutputTokens = 0;
    this.state.turnAborted = false;
    this.state.turnFailedError = null;
    this.state.stoppingRequested = false;

    if (input.recordEchoExpectation !== false) {
      this.state.pendingUserEchoes.push(input.text);
    }

    const patch = buildPhaseTransitionPatch({
      phase: "running",
      stopState: "stoppable",
      followupMode: this.state.snapshot.config.followupMode,
      queue: this.state.snapshot.queue,
      nowMs: input.nowMs,
      activeTurnId: turnId,
      sourceCommandId: input.commandId,
      lastError: null,
      apiRetry: null,
    });
    if (
      this.state.snapshot.meta.title === "" &&
      this.state.snapshot.meta.titleSource === "default"
    ) {
      const derived = deriveSessionTitle(input.text);
      if (derived) patch.meta = { title: derived, titleSource: "default" };
    }
    deltas.push({ op: "state.updated", patch });
    return this.commitDeltas(deltas, true);
  }

  /** POSIX 管道合帧竞态防护：仅在 agentLifecycleSeq 未推进时才施加乐观 running 态。 */
  applyOptimisticRunningIfUnchanged(seqBefore: number, nowMs: number): ProjectionCommit | null {
    if (this.state.agentLifecycleSeq !== seqBefore) return null;
    if (isSessionRunningPhase(this.state.snapshot.control.phase)) return null;
    const patch = buildPhaseTransitionPatch({
      phase: "running",
      stopState: "stoppable",
      followupMode: this.state.snapshot.config.followupMode,
      queue: this.state.snapshot.queue,
      nowMs,
      activeTurnId: this.state.activeTurnId ?? `turn_${this.state.turnCounter || 1}`,
      lastError: null,
      apiRetry: null,
    });
    return this.commitDeltas([{ op: "state.updated", patch }], true);
  }

  completeHandledPrompt(nowMs: number): ProjectionCommit | null {
    if (!isSessionRunningPhase(this.state.snapshot.control.phase)) return null;
    return this.commitDeltas(buildTurnSettlementDeltas(this.state, nowMs, false, null), true);
  }

  recordGuidedInput(input: RecordGuidedInputParams): ProjectionCommit | null {
    const turnId = this.state.activeTurnId;
    const headerRow =
      this.state.activeTurnHeaderRowId !== null
        ? this.getRowById(this.state.activeTurnHeaderRowId)
        : undefined;
    if (!turnId || !headerRow || headerRow.kind !== "turnHeader") {
      return this.beginUserTurn({ ...input, recordEchoExpectation: true });
    }

    const baseSeq = this.state.snapshot.seq;
    const userRowId = ++this.state.nextRowId;
    this.state.activeWorkSegments = appendGuidedWorkSegment(this.state.activeWorkSegments, {
      turnStartedAt: this.state.activeTurnStartedAt,
      nowMs: input.nowMs,
      triggerEntityId: `user_${userRowId}`,
      allocateSegmentId: () => `seg_${++this.state.segmentCounter}`,
    });

    const deltas: ConversationDelta[] = [
      { op: "row.upserted", row: { ...headerRow, workSegments: this.state.activeWorkSegments } },
      {
        op: "row.appended",
        row: buildUserInputRow({
          rowId: userRowId,
          turnId,
          createdAt: input.nowMs,
          createdAtSeq: baseSeq + 2,
          text: input.text,
          commandId: input.commandId,
          clientId: input.clientId,
          guided: true,
          modelSelection: input.modelSelection ?? this.state.snapshot.config.modelSelection,
          inputOrigin: input.inputOrigin,
        }),
      },
    ];
    this.state.pendingUserEchoes.push(input.text);
    return this.commitDeltas(deltas, false);
  }

  enqueueQueueMessage(input: {
    sourceCommandId: string;
    queueItemId: string;
    clientId: string;
    text: string;
    nowMs: number;
    requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
    modelSelection?: ModelSelection | undefined;
    inputOrigin?: "desktop" | "mobile" | undefined;
  }): ProjectionCommit | null {
    this.state.admissionCounter += 1;
    const nextQueue = enqueueQueueText(this.state.snapshot.queue, {
      ...input,
      admissionSeq: this.state.admissionCounter,
      admittedAt: input.nowMs,
      modelSelection: input.modelSelection ?? this.state.snapshot.config.modelSelection,
    });
    return this.applyQueueState(nextQueue);
  }

  applyQueueState(nextQueue: QueueState): ProjectionCommit | null {
    const phase = this.state.snapshot.control.phase;
    const patch: StatePatch = {
      queue: nextQueue,
      availability: computeSessionAvailability(phase, nextQueue),
      inputRouting: computeInputRouting(phase, this.state.snapshot.config.followupMode, nextQueue),
    };
    return this.commitDeltas([{ op: "state.updated", patch }], true);
  }

  clearQueue(autoDrain = true): ProjectionCommit | null {
    return this.applyQueueState(clearQueueItems(this.state.snapshot.queue, autoDrain));
  }

  markStopping(): ProjectionCommit | null {
    this.state.stoppingRequested = true;
    const nextQueue = pauseQueueWithReason(this.state.snapshot.queue, "stopped");
    const phase = this.state.snapshot.control.phase;
    if (!isSessionRunningPhase(phase)) return this.applyQueueState(nextQueue);
    const patch: StatePatch = {
      control: computeSessionControl({
        phase,
        stopState: "stopping",
        stopTargetKind: this.state.snapshot.control.stopTargetKind,
        activeWorks: this.state.snapshot.control.activeWorks,
        lastError: this.state.snapshot.control.lastError,
        apiRetry: null,
      }),
      queue: nextQueue,
      availability: computeSessionAvailability(phase, nextQueue),
      inputRouting: computeInputRouting(phase, this.state.snapshot.config.followupMode, nextQueue),
    };
    return this.commitDeltas([{ op: "state.updated", patch }], true);
  }

  failActiveTurn(
    message: string,
    nowMs: number,
    source: SessionErrorInfo["source"] = "runtime",
  ): ProjectionCommit | null {
    this.state.agentLifecycleSeq += 1;
    return this.commitDeltas(
      buildTurnSettlementDeltas(this.state, nowMs, false, {
        code: source === "provider" ? "fault.pi.providerError" : "fault.pi.runtimeError",
        message,
        recoverable: true,
        at: nowMs,
        source,
      }),
      true,
    );
  }

  settleAfterStopWithoutProcess(nowMs: number): ProjectionCommit | null {
    if (!isSessionRunningPhase(this.state.snapshot.control.phase)) {
      return this.applyQueueState(pauseQueueWithReason(this.state.snapshot.queue, "stopped"));
    }
    this.state.agentLifecycleSeq += 1;
    return this.commitDeltas(buildTurnSettlementDeltas(this.state, nowMs, true, null), true);
  }

  applyConfigUpdate(nextConfig: SessionConfigState): ProjectionCommit | null {
    const patch: StatePatch = {
      config: nextConfig,
      inputRouting: computeInputRouting(
        this.state.snapshot.control.phase,
        nextConfig.followupMode,
        this.state.snapshot.queue,
      ),
    };
    return this.commitDeltas([{ op: "state.updated", patch }], true);
  }

  applyRename(title: string): ProjectionCommit | null {
    return this.commitDeltas(
      [{ op: "state.updated", patch: { meta: { title: title.trim(), titleSource: "custom" } } }],
      true,
    );
  }

  applyPiEvent(event: PiRpcEvent, nowMs: number): ProjectionCommit | null {
    const reduced = reducePiStreamEvent(this.state, event, nowMs);
    if (!reduced || reduced.deltas.length === 0) return null;
    return this.commitDeltas(reduced.deltas, reduced.bumpRevision);
  }

  private getRowById(rowId: number): WireConversationRow | undefined {
    const index = this.rowIndexById.get(rowId);
    return index === undefined ? undefined : this.allRows[index];
  }

  private commitDeltas(
    deltas: ConversationDelta[],
    bumpRevision: boolean,
  ): ProjectionCommit | null {
    if (deltas.length === 0) return null;
    const fromSeq = this.state.snapshot.seq;
    const toSeq = fromSeq + deltas.length;
    const nextRevision = bumpRevision
      ? this.state.snapshot.revision + 1
      : this.state.snapshot.revision;

    const committedDeltas: ConversationDelta[] = deltas.map((delta) =>
      bumpRevision && delta.op === "state.updated"
        ? { op: "state.updated", patch: { ...delta.patch, revision: nextRevision } }
        : delta,
    );

    let nextSnapshot = this.state.snapshot;
    for (const delta of committedDeltas) {
      if (delta.op === "row.appended") {
        this.rowIndexById.set(delta.row.rowId, this.allRows.length);
        this.allRows.push(delta.row);
      } else if (delta.op === "row.upserted") {
        const idx = this.rowIndexById.get(delta.row.rowId);
        if (idx !== undefined) this.allRows[idx] = delta.row;
      } else if (delta.op === "row.delta") {
        const idx = this.rowIndexById.get(delta.rowId);
        const target = idx === undefined ? undefined : this.allRows[idx];
        if (
          idx !== undefined &&
          target &&
          (target.kind === "assistantText" || target.kind === "reasoning")
        ) {
          this.allRows[idx] = { ...target, text: target.text + delta.append };
        }
      } else if (delta.op === "state.updated") {
        nextSnapshot = { ...nextSnapshot, ...delta.patch };
      }
    }

    const tailCap = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
    const window =
      this.allRows.length > tailCap
        ? this.allRows.slice(this.allRows.length - tailCap)
        : [...this.allRows];
    this.state.snapshot = {
      ...nextSnapshot,
      seq: toSeq,
      revision: nextRevision,
      rows: { window, totalCount: this.allRows.length, firstRowId: this.allRows[0]?.rowId ?? null },
    };
    return { fromSeq, toSeq, deltas: committedDeltas };
  }
}
