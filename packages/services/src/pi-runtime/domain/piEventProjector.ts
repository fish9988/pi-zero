/**
 * Pi RPC 流式事件 -> ZCode V4 ConversationSnapshot / ConversationDelta 纯投影器（domain 层）。
 * 严禁引入任何 Node IO、网络或计时器依赖；所有时间戳均由调用方显式传入 `nowMs`。
 */
import type { ModelSelection, ZCodeSessionSubagentsResult } from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  type ConversationDelta,
  type ConversationSnapshot,
  type QueueState,
  type SessionConfigState,
  type SessionErrorInfo,
  type StatePatch,
  type TurnHeaderRow,
  type V4ConversationFileChangesResult,
  type WireConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  PiExtensionUiResponsePayload,
  PiRpcEvent,
} from "#src/pi-runtime/domain/piRpcTypes.js";
import {
  drainPendingExtensionUiState,
  resolvePendingExtensionUiState,
  type ResolveInteractionAnswer,
} from "#src/pi-runtime/domain/piExtensionUiBridge.js";
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
import { createHydratedConversationSnapshot } from "#src/pi-runtime/domain/piArchiveSnapshotFactory.js";
import {
  computeInputRouting,
  computeSessionAvailability,
  computeSessionControl,
  createInitialConversationSnapshot,
  deriveAssistantPreview,
  deriveSessionTitle,
  isSessionRunningPhase,
} from "#src/pi-runtime/domain/piSnapshotFactory.js";
import type { HydratedPiSessionResult } from "#src/pi-runtime/domain/piJsonlHydrator.js";
import {
  buildSubagentDirectoryProjection,
  type VirtualSubagentSessionPayload,
} from "#src/pi-runtime/domain/piSubagentProjector.js";
import { reducePiStreamEvent } from "#src/pi-runtime/domain/piStreamEventReducer.js";
import {
  applyHydratedReplacementToState,
  buildModelSwitchDeltas,
  buildTurnSettlementDeltas,
  resetTurnTransientTracking,
  resolveTurnFileChangesResult,
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
  readonly attachments?:
    | import("@zcode/shared/zcode-protocol-v4").UserInputRow["attachments"]
    | undefined;
  readonly conversationQuotes?:
    | import("@zcode/shared/zcode-protocol-v4").UserInputRow["conversationQuotes"]
    | undefined;
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
    workspacePath?: string | undefined;
    logEpoch: string;
    attemptId: string;
    config: SessionConfigState;
    contextWindowMax?: number | undefined;
    title?: string | undefined;
    titleSource?: "default" | "generated" | "custom" | undefined;
    hydrated?: HydratedPiSessionResult | undefined;
    readOnlyArchive?:
      | { readonly snapshot: ConversationSnapshot; readonly rows: readonly WireConversationRow[] }
      | undefined;
  }) {
    const initialRows = input.readOnlyArchive
      ? [...input.readOnlyArchive.rows]
      : input.hydrated
        ? [...input.hydrated.rows]
        : [];
    const initialSnapshot = input.readOnlyArchive
      ? input.readOnlyArchive.snapshot
      : input.hydrated
        ? createHydratedConversationSnapshot({
            sessionId: input.sessionId,
            logEpoch: input.logEpoch,
            attemptId: input.attemptId,
            phase: input.hydrated.phase,
            config: input.hydrated.config,
            title: input.hydrated.title,
            titleSource: input.hydrated.titleSource,
            usage: input.hydrated.usage,
            rows: initialRows,
          })
        : createInitialConversationSnapshot(input);
    for (const row of initialRows) {
      this.rowIndexById.set(row.rowId, this.allRows.length);
      this.allRows.push(row);
    }
    const maxRowId = initialRows.reduce((max, row) => Math.max(max, row.rowId), 0);
    const turnCount = initialRows.filter((row) => row.kind === "turnHeader").length;
    this.state = {
      workspacePath: input.workspacePath ?? "",
      snapshot: initialSnapshot,
      nextRowId: maxRowId,
      turnCounter: turnCount,
      responseCounter: 0,
      segmentCounter: 0,
      admissionCounter: 0,
      agentLifecycleSeq: 0,
      contextWindowMax: input.hydrated?.contextWindowMax ?? input.contextWindowMax ?? 0,
      lastAssistantPreview: input.hydrated?.lastAssistantPreview,
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
      toolCallsByCallId: new Map(),
      toolCallIdByContentIndex: new Map(),
      turnFileChanges: new Map(),
      fileChangesByTurnId: new Map(input.hydrated?.fileChangesByTurnId ?? []),
      pendingExtensionUiById: new Map(),
      subagentRevision: 0,
      subagentRowIdByChildId: new Map(),
      subagentSessionsByChildId: new Map(),
      dirtySubagentChildIds: new Set(),
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
          attachments: input.attachments,
          conversationQuotes: input.conversationQuotes,
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
    resetTurnTransientTracking(this.state);

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

  /**
   * 原子提交模型/思考档位切换：在已有对话历史的会话上切换模型时追加合规 `modelChange` 轻边界分隔行。
   */
  applyModelSwitch(input: {
    provider: string;
    model: string;
    thought: string;
    thoughtLevels: readonly string[];
    nowMs: number;
    sourceCommandId?: string | undefined;
  }): ProjectionCommit | null {
    return this.commitDeltas(buildModelSwitchDeltas(this.state, this.allRows.length, input), true);
  }

  getTurnFileChanges(target: { rowId: number; entityId: string }): V4ConversationFileChangesResult {
    return resolveTurnFileChangesResult(this.state, target);
  }

  resolveExtensionUiInteraction(
    interactionId: string,
    answer: ResolveInteractionAnswer,
  ): {
    readonly response: PiExtensionUiResponsePayload;
    readonly commit: ProjectionCommit | null;
  } | null {
    const res = resolvePendingExtensionUiState(this.state, interactionId, answer);
    if (!res) return null;
    return { response: res.response, commit: this.commitDeltas(res.deltas, true) };
  }

  drainPendingExtensionUiInteractions(): {
    readonly cancelledIds: string[];
    readonly commit: ProjectionCommit | null;
  } {
    const drained = drainPendingExtensionUiState(this.state);
    return {
      cancelledIds: drained.cancelledIds,
      commit: drained.deltas.length > 0 ? this.commitDeltas(drained.deltas, true) : null,
    };
  }

  replaceWithHydratedSession(hydrated: HydratedPiSessionResult, newLogEpoch: string): void {
    applyHydratedReplacementToState(
      this.state,
      this.allRows,
      this.rowIndexById,
      hydrated,
      newLogEpoch,
    );
  }

  /** 查找目标用户消息在所有真实用户消息中的 0-based 序号（用于精准定位 Pi `.jsonl` 中对应的 user entry）。 */
  findUserRowInfo(targetRowId: number): {
    readonly row: Extract<WireConversationRow, { kind: "userInput" }>;
    readonly userOrdinal: number;
  } | null {
    let ordinal = 0;
    for (const row of this.allRows) {
      if (row.kind !== "userInput" || row.guided) continue;
      if (row.rowId === targetRowId) {
        return { row, userOrdinal: ordinal };
      }
      ordinal += 1;
    }
    return null;
  }

  /** 内存兜底回退：移除 `targetRowId` 所在回合及之后所有行，保留之前历史。 */
  rewindInMemoryBeforeRow(targetRowId: number, newLogEpoch: string): void {
    const targetRow = this.getRowById(targetRowId);
    const targetTurnId = targetRow?.turnId;
    const cutIndex = this.allRows.findIndex(
      (row) => row.rowId === targetRowId || (targetTurnId && row.turnId === targetTurnId),
    );
    const keptRows = cutIndex >= 0 ? this.allRows.slice(0, cutIndex) : [...this.allRows];
    const keptTurnIds = new Set(keptRows.map((row) => row.turnId));
    const keptFileChanges = new Map<string, V4ConversationFileChangesResult>();
    for (const [turnId, changes] of this.state.fileChangesByTurnId) {
      if (keptTurnIds.has(turnId)) keptFileChanges.set(turnId, changes);
    }
    let lastPreview: string | undefined;
    for (let i = keptRows.length - 1; i >= 0; i -= 1) {
      const row = keptRows[i];
      if (row && row.kind === "assistantText" && row.text.trim()) {
        lastPreview = deriveAssistantPreview(row.text);
        break;
      }
    }
    applyHydratedReplacementToState(
      this.state,
      this.allRows,
      this.rowIndexById,
      {
        title: this.state.snapshot.meta.title,
        titleSource: this.state.snapshot.meta.titleSource,
        lastAssistantPreview: lastPreview,
        phase: keptRows.length > 0 ? "completedSuccess" : "draft",
        config: this.state.snapshot.config,
        contextWindowMax: this.state.contextWindowMax,
        usage: this.state.snapshot.usage,
        rows: keptRows,
        fileChangesByTurnId: keptFileChanges,
      },
      newLogEpoch,
    );
  }

  applyRename(title: string): ProjectionCommit | null {
    return this.commitDeltas(
      [{ op: "state.updated", patch: { meta: { title: title.trim(), titleSource: "custom" } } }],
      true,
    );
  }

  /** 取出本次流式更新产生或刷新的虚拟子代理会话快照，供宿主同步至右侧 Subagent 面板。 */
  drainDirtyVirtualSubagentSessions(): VirtualSubagentSessionPayload[] {
    if (this.state.dirtySubagentChildIds.size === 0) return [];
    const out: VirtualSubagentSessionPayload[] = [];
    for (const childId of this.state.dirtySubagentChildIds) {
      const payload = this.state.subagentSessionsByChildId.get(childId);
      if (payload) out.push(payload);
    }
    this.state.dirtySubagentChildIds.clear();
    return out;
  }

  getSubagentDirectorySnapshot(): ZCodeSessionSubagentsResult {
    const projected = buildSubagentDirectoryProjection(
      Array.from(this.state.subagentSessionsByChildId.values()),
      this.state.subagentRevision,
    );
    return {
      revision: projected.state.revision,
      childSessionIds: projected.state.childSessionIds,
      running: projected.state.running,
      ended: {
        total: projected.ended.length,
        items: [...projected.ended],
      },
    };
  }

  /** 用最新虚拟子代理快照原位刷新（供只读子代理控制器向右侧 SubagentSessionSidePane 推送实时更新）。 */
  replaceWithVirtualSnapshot(
    snapshot: ConversationSnapshot,
    rows: readonly WireConversationRow[],
  ): void {
    this.allRows.length = 0;
    this.rowIndexById.clear();
    for (const row of rows) {
      this.rowIndexById.set(row.rowId, this.allRows.length);
      this.allRows.push(row);
    }
    this.state.nextRowId = rows.reduce((max, r) => Math.max(max, r.rowId), 0);
    this.state.snapshot = snapshot;
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
        if (idx !== undefined && target) {
          if (
            delta.path === "text" &&
            (target.kind === "assistantText" || target.kind === "reasoning")
          ) {
            this.allRows[idx] = { ...target, text: target.text + delta.append };
          } else if (delta.path === "inputText" && target.kind === "toolCall") {
            this.allRows[idx] = { ...target, inputText: target.inputText + delta.append };
          }
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
