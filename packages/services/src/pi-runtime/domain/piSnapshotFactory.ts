/**
 * Pi -> ZCode V4 Snapshot / ACK / Queue / SessionSummary / Legacy Snapshot 纯构造工厂。
 * 属于 domain 层：严格保持纯 TypeScript，不引入任何 Node IO、网络或计时器依赖。
 */
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  resolveWorkspaceKey,
  type ModelSelection,
  type ZCodeSessionInfo,
  type ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import type {
  ActiveWorkSummary,
  ApiRetryState,
  CommandAck,
  CommandResult,
  ConversationSnapshot,
  InputRouting,
  QueueItem,
  QueueState,
  SessionActionAvailability,
  SessionConfigState,
  SessionControl,
  SessionErrorInfo,
  SessionPhase,
  SessionSummary,
  SessionsIndexSnapshot,
  StopTargetKind,
  WireConversationRow,
  WorkspaceConfigSnapshot,
  WorkspaceConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import type { PiModelInfo } from "#src/pi-runtime/domain/piRpcTypes.js";
import {
  clampPiThinkingLevel,
  getSupportedThinkingLevels,
  pickDefaultThinkingLevel,
} from "#src/pi-runtime/domain/piModelCapability.js";

const MAX_TITLE_CHARS = 80;
const MAX_ASSISTANT_PREVIEW_CHARS = 120;

export function deriveSessionTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  const collapsed = firstLine.replace(/\s+/gu, " ");
  if (collapsed.length <= MAX_TITLE_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

export function deriveAssistantPreview(text: string): string | undefined {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (!collapsed) return undefined;
  if (collapsed.length <= MAX_ASSISTANT_PREVIEW_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_ASSISTANT_PREVIEW_CHARS - 1)}…`;
}

export function isSessionRunningPhase(phase: SessionPhase): boolean {
  return phase === "running" || phase === "prewarming";
}

export function isSessionTerminalPhase(phase: SessionPhase): boolean {
  return phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error";
}

export function computeSessionControl(input: {
  phase: SessionPhase;
  stopState: "idle" | "stoppable" | "stopping";
  stopTargetKind?: StopTargetKind;
  activeWorks: readonly ActiveWorkSummary[];
  lastError: SessionErrorInfo | null;
  apiRetry: ApiRetryState | null;
}): SessionControl {
  const running = isSessionRunningPhase(input.phase);
  const canStop = running && input.stopState !== "stopping";
  return {
    phase: input.phase,
    sessionEnded: isSessionTerminalPhase(input.phase),
    canStop,
    stopState: running ? input.stopState : "idle",
    stopTargetKind: running ? (input.stopTargetKind ?? "assistant") : "unknown",
    activeWorks: [...input.activeWorks],
    lastError: input.lastError,
    apiRetry: input.apiRetry,
  };
}

export function computeSessionAvailability(
  phase: SessionPhase,
  queue: QueueState,
): SessionActionAvailability {
  const running = isSessionRunningPhase(phase);
  const hasQueued = queue.items.length > 0;
  return {
    fork: { allowed: false, reasonCode: "guard.pi.forkNotYetAvailable" },
    compact: running ? { allowed: false, reasonCode: "guard.session.busy" } : { allowed: true },
    switchModelConfig: { allowed: true },
    setFollowupMode: { allowed: true },
    queueEdit: hasQueued ? { allowed: true } : { allowed: false, reasonCode: "guard.queue.empty" },
    sendQueuedNow:
      !running && hasQueued
        ? { allowed: true }
        : { allowed: false, reasonCode: running ? "guard.session.busy" : "guard.queue.empty" },
    pauseGoal: { allowed: false, reasonCode: "guard.goal.none" },
    resumeGoal: { allowed: false, reasonCode: "guard.goal.none" },
    rewindFiles: { allowed: false, reasonCode: "guard.pi.rewindNotYetAvailable" },
  };
}

export function computeInputRouting(
  phase: SessionPhase,
  followupMode: "queue" | "guide",
  queue: QueueState,
): InputRouting {
  if (isSessionRunningPhase(phase)) {
    return { mode: followupMode === "guide" ? "guide" : "enqueue" };
  }
  if (isSessionTerminalPhase(phase) && queue.items.length > 0 && !queue.autoDrain) {
    return { mode: "choice" };
  }
  return { mode: "startNow" };
}

export interface CreateSessionConfigInput {
  modelSelection?: ModelSelection | undefined;
  catalogModels?: readonly PiModelInfo[] | undefined;
  defaultModel?: PiModelInfo | undefined;
  defaultThinkingLevel?: string | undefined;
  followupMode?: "queue" | "guide" | undefined;
  mode?: string | undefined;
}

export function createInitialSessionConfig(input: CreateSessionConfigInput): SessionConfigState {
  const models = input.catalogModels ?? [];
  const requested = input.modelSelection;
  const matchedModel = requested
    ? models.find(
        (candidate) =>
          candidate.provider === requested.providerId && candidate.id === requested.modelId,
      )
    : (input.defaultModel ?? models[0]);

  const provider = requested?.providerId ?? matchedModel?.provider ?? "";
  const model = requested?.modelId ?? matchedModel?.id ?? "";
  const thoughtLevels = matchedModel
    ? getSupportedThinkingLevels(matchedModel)
    : requested?.options?.reasoningLevel
      ? [requested.options.reasoningLevel]
      : ["off", "minimal", "low", "medium", "high"];
  const thought = matchedModel
    ? pickDefaultThinkingLevel(
        matchedModel,
        requested?.options?.reasoningLevel ?? input.defaultThinkingLevel,
      )
    : clampPiThinkingLevel(
        requested?.options?.reasoningLevel ?? input.defaultThinkingLevel,
        thoughtLevels,
      );

  const modelSelection: ModelSelection | undefined =
    provider && model
      ? {
          providerId: provider,
          modelId: model,
          ...(thought ? { options: { reasoningLevel: thought } } : {}),
        }
      : undefined;

  return {
    ...(modelSelection ? { modelSelection } : {}),
    provider,
    model,
    thought,
    thoughtLevels,
    followupMode: input.followupMode ?? "queue",
    mode: input.mode ?? "build",
  };
}

export interface CreateInitialSnapshotInput {
  sessionId: string;
  logEpoch: string;
  attemptId: string;
  config: SessionConfigState;
  title?: string | undefined;
  titleSource?: "default" | "generated" | "custom" | undefined;
}

export function createInitialConversationSnapshot(
  input: CreateInitialSnapshotInput,
): ConversationSnapshot {
  const queue: QueueState = { items: [], autoDrain: true };
  return {
    runtimeInitialization: { status: "ready", attemptId: input.attemptId },
    protocolVersion: 1,
    sessionId: input.sessionId,
    logEpoch: input.logEpoch,
    seq: 0,
    revision: 0,
    control: computeSessionControl({
      phase: "draft",
      stopState: "idle",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    }),
    availability: computeSessionAvailability("draft", queue),
    inputRouting: computeInputRouting("draft", input.config.followupMode, queue),
    meta: {
      title: input.title ?? "",
      titleSource: input.titleSource ?? "default",
    },
    config: input.config,
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue,
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: {
      revision: 0,
      childSessionIds: [],
      running: [],
      endedTotal: 0,
    },
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    workspaceMcpAdmission: null,
    rows: {
      window: [],
      totalCount: 0,
      firstRowId: null,
    },
  };
}

export interface CreateQueueItemInput {
  sourceCommandId: string;
  queueItemId: string;
  clientId: string;
  kind?: "sendText" | "sendGoalCommand" | "compact";
  text: string;
  attachments?: QueueItem["attachments"] | undefined;
  admissionSeq: number;
  queuePosition: number;
  admittedAt: number;
  requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
  modelSelection?: ModelSelection | undefined;
  inputOrigin?: "desktop" | "mobile" | undefined;
}

export function createQueueItem(input: CreateQueueItemInput): QueueItem {
  return {
    ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
    sourceCommandId: input.sourceCommandId,
    queueItemId: input.queueItemId,
    clientId: input.clientId,
    kind: input.kind ?? "sendText",
    text: input.text,
    attachments: input.attachments ? [...input.attachments] : [],
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    delivery: {
      requested: input.requestedDelivery ?? "queue",
      admitted: "queue",
    },
    order: {
      admissionSeq: input.admissionSeq,
      queuePosition: input.queuePosition,
    },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: input.admittedAt,
  };
}

export function createCommandAck(input: {
  commandId: string;
  status: CommandAck["status"];
  revisionAtDecision: number;
  reasonCode?: string | undefined;
  message?: string | undefined;
  result?: CommandResult | undefined;
}): CommandAck {
  return {
    commandId: input.commandId,
    status: input.status,
    revisionAtDecision: input.revisionAtDecision,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(input.result ? { result: input.result } : {}),
  };
}

export interface SessionSummaryBuildInput {
  workspaceId: string;
  parentSessionId?: string | undefined;
  createdAt: number;
  lastActivityAt: number;
  lastAssistantPreview?: string | undefined;
}

export function buildSessionSummary(
  snapshot: ConversationSnapshot,
  meta: SessionSummaryBuildInput,
): SessionSummary {
  const phase = snapshot.control.phase;
  const lastOutcome: SessionSummary["lastOutcome"] =
    phase === "completedSuccess"
      ? "completed"
      : phase === "completedInterrupted"
        ? "interrupted"
        : phase === "error"
          ? "error"
          : undefined;
  return {
    sessionId: snapshot.sessionId,
    workspaceId: meta.workspaceId,
    ...(meta.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
    title: snapshot.meta.title,
    titleSource: snapshot.meta.titleSource,
    ...(lastOutcome ? { lastOutcome } : {}),
    phase,
    sessionEnded: snapshot.control.sessionEnded,
    hasBackgroundWork: snapshot.backgroundWorks.some((work) => work.status === "running"),
    lastActivityAt: meta.lastActivityAt,
    ...(meta.lastAssistantPreview ? { lastAssistantPreview: meta.lastAssistantPreview } : {}),
    createdAt: meta.createdAt,
  };
}

export function createSessionsIndexSnapshot(input: {
  workspaceId: string;
  logEpoch: string;
  sessions: readonly SessionSummary[];
}): SessionsIndexSnapshot {
  return {
    protocolVersion: 1,
    workspaceId: input.workspaceId,
    logEpoch: input.logEpoch,
    sessions: [...input.sessions],
  };
}

export function createWorkspaceConfigSnapshot(input: {
  workspaceId: string;
  logEpoch: string;
  config: WorkspaceConfigState;
}): WorkspaceConfigSnapshot {
  return {
    protocolVersion: 1,
    workspaceId: input.workspaceId,
    logEpoch: input.logEpoch,
    config: input.config,
  };
}

function mapPhaseToLegacyStatus(phase: SessionPhase): ZCodeSessionInfo["status"] {
  switch (phase) {
    case "draft":
      return "idle";
    case "prewarming":
    case "running":
      return "running";
    case "completedSuccess":
    case "completedInterrupted":
      return "completed";
    case "error":
      return "error";
  }
}

export function buildLegacySessionInfo(
  snapshot: ConversationSnapshot,
  meta: {
    workspacePath: string;
    workspaceIdentity?: string | undefined;
    parentSessionId?: string | undefined;
    createdAt: number;
    updatedAt: number;
  },
): ZCodeSessionInfo {
  return {
    sessionId: snapshot.sessionId,
    workspace: {
      workspacePath: meta.workspacePath,
      workspaceKey: resolveWorkspaceKey({
        workspacePath: meta.workspacePath,
        ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
      }),
      ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
    },
    ...(meta.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
    sessionKind: "interactive",
    title: snapshot.meta.title,
    titleSource: snapshot.meta.titleSource,
    mode: "build",
    status: mapPhaseToLegacyStatus(snapshot.control.phase),
    ...(snapshot.config.modelSelection ? { model: snapshot.config.modelSelection } : {}),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

export function buildLegacySessionStateSnapshot(
  snapshot: ConversationSnapshot,
  allRows: readonly WireConversationRow[],
  meta: {
    workspacePath: string;
    workspaceIdentity?: string | undefined;
    parentSessionId?: string | undefined;
    createdAt: number;
    updatedAt: number;
  },
): ZCodeSessionStateSnapshot {
  const info = buildLegacySessionInfo(snapshot, meta);
  const turnCount = allRows.filter((row) => row.kind === "turnHeader").length;
  const totalTokenCount =
    snapshot.usage.cumulative.inputTokens + snapshot.usage.cumulative.outputTokens;
  const contextUsed = snapshot.usage.contextWindow?.usedTokens ?? 0;
  const contextWindow = snapshot.usage.contextWindow?.maxTokens ?? 0;
  return {
    protocol: {
      name: ZCODE_PROTOCOL_NAME,
      version: ZCODE_PROTOCOL_VERSION,
    },
    session: info,
    settings: {
      model: {
        ...(snapshot.config.modelSelection ? { current: snapshot.config.modelSelection } : {}),
        available: [],
      },
      thoughtLevel: {
        enabled: snapshot.config.thought !== "off",
        ...(snapshot.config.thought ? { current: snapshot.config.thought } : {}),
        available: snapshot.config.thoughtLevels.map((level) => ({
          value: level,
          label: level,
        })),
      },
      mode: {
        current: "build",
      },
    },
    projection: {
      sessionId: snapshot.sessionId,
      status: info.status,
      mode: "build",
      turnCount,
      totalTokenCount,
      contextUsed,
      contextWindow,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: {
      eventSeq: snapshot.seq,
      stateRevision: snapshot.revision,
      pendingRequestIds: [],
    },
    messages: [],
  };
}
