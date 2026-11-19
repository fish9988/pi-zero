/**
 * Pi 工作区级 V4 Topic 注册表与帧下发枢纽（sessions-index / workspace-config / commandAckCache）。
 */
import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import {
  resolveWorkspaceKey,
  type ModelSelection,
  type SessionLifecycleSnapshot,
} from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  sessionsIndexTopic,
  workspaceConfigTopic,
  type CommandAck,
  type ConversationTopicWireCandidate,
  type SessionSummary,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type SubscribeAck,
  type WorkspaceConfigTopicFrame,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentWorkspaceTarget,
} from "#src/zcode-agent/zcodeAgent.js";
import { buildWorkspaceConfigStateFromPiModels } from "#src/pi-runtime/domain/piModelCapability.js";
import {
  createSessionsIndexSnapshot,
  createWorkspaceConfigSnapshot,
} from "#src/pi-runtime/domain/piSnapshotFactory.js";
import {
  encodeV4TopicFrames,
  type TopicSubscriptionState,
} from "#src/pi-runtime/adapters/piFrameEncoder.js";
import type { PiModelCatalog } from "#src/pi-runtime/adapters/piModelCatalog.js";
import { PiSessionController } from "#src/pi-runtime/adapters/piSessionController.js";

export interface PiWorkspaceBucket {
  readonly workspaceKey: string;
  readonly workspacePath: string;
  readonly workspaceIdentity: string | undefined;
  readonly generation: number;
  readonly identity: string;
  readonly sessions: Map<string, PiSessionController>;
  readonly conversationFrameEmitter: Emitter<ConversationTopicWireCandidate>;
  readonly sessionsIndexFrameEmitter: Emitter<SessionsIndexTopicWireCandidate>;
  readonly workspaceConfigFrameEmitter: Emitter<WorkspaceConfigTopicWireCandidate>;
  readonly sessionLifecycleEmitter: Emitter<SessionLifecycleSnapshot>;
  readonly sessionsIndexLogEpoch: string;
  sessionsIndexSeq: number;
  readonly sessionsIndexSubs: Map<string, TopicSubscriptionState>;
  readonly workspaceConfigLogEpoch: string;
  workspaceConfigSeq: number;
  readonly workspaceConfigSubs: Map<string, TopicSubscriptionState>;
  readonly commandAckCache: Map<string, CommandAck>;
}

export function commandCacheKey(sessionId: string | null, commandId: string): string {
  return `${sessionId ?? "__global__"}\0${commandId}`;
}

export class PiWorkspaceHub {
  private readonly workspaces = new Map<string, PiWorkspaceBucket>();
  private readonly generationByWorkspaceKey = new Map<string, number>();
  private readonly catalog: PiModelCatalog;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly platform: NodeJS.Platform | undefined;
  private readonly managedRuntimeDir: string | undefined;
  private readonly onRuntimeLifecycle:
    | ((event: ZCodeAgentRuntimeLifecycleEvent) => void)
    | undefined;
  private subscriptionSeq = 0;

  constructor(options: {
    catalog: PiModelCatalog;
    env?: NodeJS.ProcessEnv | undefined;
    platform?: NodeJS.Platform | undefined;
    managedRuntimeDir?: string | undefined;
    onRuntimeLifecycle?: ((event: ZCodeAgentRuntimeLifecycleEvent) => void) | undefined;
  }) {
    this.catalog = options.catalog;
    this.env = options.env;
    this.platform = options.platform;
    this.managedRuntimeDir = options.managedRuntimeDir;
    this.onRuntimeLifecycle = options.onRuntimeLifecycle;
  }

  nextSubscriptionId(prefix: string): string {
    this.subscriptionSeq += 1;
    return `${prefix}_${this.subscriptionSeq}`;
  }

  getWorkspace(target: ZCodeAgentWorkspaceTarget): PiWorkspaceBucket | undefined {
    return this.workspaces.get(resolveWorkspaceKey(target));
  }

  getOrCreateWorkspace(target: ZCodeAgentWorkspaceTarget): PiWorkspaceBucket {
    const key = resolveWorkspaceKey(target);
    const existing = this.workspaces.get(key);
    if (existing) return existing;
    const generation = (this.generationByWorkspaceKey.get(key) ?? 0) + 1;
    this.generationByWorkspaceKey.set(key, generation);
    const bucket: PiWorkspaceBucket = {
      workspaceKey: key,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      generation,
      identity: `pi-ws-${randomUUID()}`,
      sessions: new Map(),
      conversationFrameEmitter: new Emitter(),
      sessionsIndexFrameEmitter: new Emitter(),
      workspaceConfigFrameEmitter: new Emitter(),
      sessionLifecycleEmitter: new Emitter(),
      sessionsIndexLogEpoch: `pi-idx-${randomUUID()}`,
      sessionsIndexSeq: 0,
      sessionsIndexSubs: new Map(),
      workspaceConfigLogEpoch: `pi-cfg-${randomUUID()}`,
      workspaceConfigSeq: 0,
      workspaceConfigSubs: new Map(),
      commandAckCache: new Map(),
    };
    this.workspaces.set(key, bucket);
    // 必须在写入 Map 之后再广播 available：syncer 监听到后可能同步重入订阅 topic。
    this.emitRuntimeLifecycle(bucket, "available");
    return bucket;
  }

  createSessionController(
    bucket: PiWorkspaceBucket,
    input: {
      sessionId: string;
      cwd?: string | undefined;
      parentSessionId?: string | undefined;
      modelSelection?: ModelSelection | undefined;
      thoughtLevel?: string | undefined;
    },
  ): PiSessionController {
    const controller = new PiSessionController({
      sessionId: input.sessionId,
      workspaceId: bucket.workspaceKey,
      workspacePath: bucket.workspacePath,
      workspaceIdentity: bucket.workspaceIdentity,
      cwd: input.cwd?.trim() || bucket.workspacePath,
      parentSessionId: input.parentSessionId,
      modelSelection: input.modelSelection,
      thoughtLevel: input.thoughtLevel,
      catalog: this.catalog,
      env: this.env,
      platform: this.platform,
      managedRuntimeDir: this.managedRuntimeDir,
      callbacks: {
        emitConversationFrame: (frame) => bucket.conversationFrameEmitter.fire(frame),
        onSessionPublishedOrUpdated: (summary) => {
          this.emitSessionsIndexDelta(bucket, { op: "session.upserted", session: summary });
        },
        onSessionLifecycleChanged: (snapshot) => bucket.sessionLifecycleEmitter.fire(snapshot),
        onSessionDeleted: (deletedSessionId) => {
          bucket.sessions.delete(deletedSessionId);
          this.emitSessionsIndexDelta(bucket, {
            op: "session.removed",
            sessionId: deletedSessionId,
          });
        },
      },
    });
    bucket.sessions.set(input.sessionId, controller);
    return controller;
  }

  rememberCommandAck(
    bucket: PiWorkspaceBucket,
    sessionId: string | null,
    commandId: string,
    ack: CommandAck,
  ): void {
    bucket.commandAckCache.set(commandCacheKey(sessionId, commandId), ack);
    const cap = PROTOCOL_V4_LIMITS.idempotencyTablePerSession * 4;
    if (bucket.commandAckCache.size > cap) {
      const oldest = bucket.commandAckCache.keys().next().value;
      if (oldest !== undefined) bucket.commandAckCache.delete(oldest);
    }
  }

  subscribeSessionsIndex(target: ZCodeAgentWorkspaceTarget): SubscribeAck {
    const bucket = this.getOrCreateWorkspace(target);
    const subscriptionId = this.nextSubscriptionId("pi_idx");
    const sub: TopicSubscriptionState = {
      subscriptionId,
      topic: sessionsIndexTopic(bucket.workspaceKey),
      logicalFrameOrdinal: 0,
    };
    bucket.sessionsIndexSubs.set(subscriptionId, sub);
    this.emitSessionsIndexSnapshot(bucket, sub, "initial");
    return { subscriptionId, mode: "snapshot", logEpoch: bucket.sessionsIndexLogEpoch };
  }

  resyncSessionsIndex(target: ZCodeAgentWorkspaceTarget, subscriptionId: string): SubscribeAck {
    const bucket = this.getOrCreateWorkspace(target);
    const sub = bucket.sessionsIndexSubs.get(subscriptionId);
    if (!sub) throw new Error("fault.subscription.notOwned");
    this.emitSessionsIndexSnapshot(bucket, sub, "recovery");
    return {
      subscriptionId: sub.subscriptionId,
      mode: "snapshot",
      logEpoch: bucket.sessionsIndexLogEpoch,
    };
  }

  subscribeWorkspaceConfig(target: ZCodeAgentWorkspaceTarget): SubscribeAck {
    const bucket = this.getOrCreateWorkspace(target);
    const subscriptionId = this.nextSubscriptionId("pi_cfg");
    const sub: TopicSubscriptionState = {
      subscriptionId,
      topic: workspaceConfigTopic(bucket.workspaceKey),
      logicalFrameOrdinal: 0,
    };
    bucket.workspaceConfigSubs.set(subscriptionId, sub);
    this.emitWorkspaceConfigSnapshot(bucket, sub, "initial");
    return { subscriptionId, mode: "snapshot", logEpoch: bucket.workspaceConfigLogEpoch };
  }

  resyncWorkspaceConfig(target: ZCodeAgentWorkspaceTarget, subscriptionId: string): SubscribeAck {
    const bucket = this.getOrCreateWorkspace(target);
    const sub = bucket.workspaceConfigSubs.get(subscriptionId);
    if (!sub) throw new Error("fault.subscription.notOwned");
    this.emitWorkspaceConfigSnapshot(bucket, sub, "recovery");
    return {
      subscriptionId: sub.subscriptionId,
      mode: "snapshot",
      logEpoch: bucket.workspaceConfigLogEpoch,
    };
  }

  broadcastCatalogConfigUpdate(): void {
    const config = this.buildCurrentWorkspaceConfig();
    const sentAt = Date.now();
    for (const bucket of this.workspaces.values()) {
      if (bucket.workspaceConfigSubs.size === 0) continue;
      const fromSeq = bucket.workspaceConfigSeq;
      bucket.workspaceConfigSeq += 1;
      const toSeq = bucket.workspaceConfigSeq;
      for (const sub of bucket.workspaceConfigSubs.values()) {
        const logicalFrame: WorkspaceConfigTopicFrame = {
          topic: sub.topic,
          subscriptionId: sub.subscriptionId,
          fromSeq,
          toSeq,
          sentAt,
          payload: { kind: "deltas", deltas: [{ op: "config.updated", config }] },
        };
        for (const wire of encodeV4TopicFrames(logicalFrame, sub, "online")) {
          bucket.workspaceConfigFrameEmitter.fire(wire);
        }
      }
    }
  }

  async disposeWorkspace(target: ZCodeAgentWorkspaceTarget): Promise<void> {
    const key = resolveWorkspaceKey(target);
    const bucket = this.workspaces.get(key);
    if (!bucket) return;
    this.workspaces.delete(key);
    await this.disposeBucket(bucket);
  }

  async disposeAllAndWait(): Promise<void> {
    const allBuckets = [...this.workspaces.values()];
    this.workspaces.clear();
    await Promise.all(allBuckets.map((bucket) => this.disposeBucket(bucket)));
  }

  private emitSessionsIndexDelta(
    bucket: PiWorkspaceBucket,
    delta:
      | { op: "session.upserted"; session: SessionSummary }
      | { op: "session.removed"; sessionId: string },
  ): void {
    const fromSeq = bucket.sessionsIndexSeq;
    bucket.sessionsIndexSeq += 1;
    const toSeq = bucket.sessionsIndexSeq;
    const sentAt = Date.now();
    for (const sub of bucket.sessionsIndexSubs.values()) {
      const logicalFrame: SessionsIndexTopicFrame = {
        topic: sub.topic,
        subscriptionId: sub.subscriptionId,
        fromSeq,
        toSeq,
        sentAt,
        payload: { kind: "deltas", deltas: [delta] },
      };
      for (const wire of encodeV4TopicFrames(logicalFrame, sub, "online")) {
        bucket.sessionsIndexFrameEmitter.fire(wire);
      }
    }
  }

  private emitSessionsIndexSnapshot(
    bucket: PiWorkspaceBucket,
    sub: TopicSubscriptionState,
    deliveryKind: "initial" | "recovery",
  ): void {
    const published: SessionSummary[] = [];
    for (const controller of bucket.sessions.values()) {
      if (controller.isPublishedToIndex()) published.push(controller.getSummary());
    }
    const logicalFrame: SessionsIndexTopicFrame = {
      topic: sub.topic,
      subscriptionId: sub.subscriptionId,
      fromSeq: 0,
      toSeq: bucket.sessionsIndexSeq,
      sentAt: Date.now(),
      payload: {
        kind: "snapshot",
        snapshot: createSessionsIndexSnapshot({
          workspaceId: bucket.workspaceKey,
          logEpoch: bucket.sessionsIndexLogEpoch,
          sessions: published,
        }),
      },
    };
    for (const wire of encodeV4TopicFrames(logicalFrame, sub, deliveryKind)) {
      bucket.sessionsIndexFrameEmitter.fire(wire);
    }
  }

  private buildCurrentWorkspaceConfig() {
    const snap = this.catalog.getSnapshot();
    return buildWorkspaceConfigStateFromPiModels(
      snap.models,
      snap.defaultModel,
      snap.defaultThinkingLevel,
    );
  }

  private emitWorkspaceConfigSnapshot(
    bucket: PiWorkspaceBucket,
    sub: TopicSubscriptionState,
    deliveryKind: "initial" | "recovery",
  ): void {
    const logicalFrame: WorkspaceConfigTopicFrame = {
      topic: sub.topic,
      subscriptionId: sub.subscriptionId,
      fromSeq: 0,
      toSeq: bucket.workspaceConfigSeq,
      sentAt: Date.now(),
      payload: {
        kind: "snapshot",
        snapshot: createWorkspaceConfigSnapshot({
          workspaceId: bucket.workspaceKey,
          logEpoch: bucket.workspaceConfigLogEpoch,
          config: this.buildCurrentWorkspaceConfig(),
        }),
      },
    };
    for (const wire of encodeV4TopicFrames(logicalFrame, sub, deliveryKind)) {
      bucket.workspaceConfigFrameEmitter.fire(wire);
    }
  }

  private emitRuntimeLifecycle(
    bucket: PiWorkspaceBucket,
    state: "available" | "unavailable",
  ): void {
    this.onRuntimeLifecycle?.({
      workspacePath: bucket.workspacePath,
      ...(bucket.workspaceIdentity ? { workspaceIdentity: bucket.workspaceIdentity } : {}),
      workspaceKey: bucket.workspaceKey,
      runtimeIdentity: {
        generation: bucket.generation,
        identity: bucket.identity,
        workspaceKey: bucket.workspaceKey,
      },
      state,
    });
  }

  private async disposeBucket(bucket: PiWorkspaceBucket): Promise<void> {
    const controllers = [...bucket.sessions.values()];
    bucket.sessions.clear();
    bucket.sessionsIndexSubs.clear();
    bucket.workspaceConfigSubs.clear();
    this.emitRuntimeLifecycle(bucket, "unavailable");
    await Promise.all(controllers.map((controller) => controller.disposeAndWait()));
    bucket.conversationFrameEmitter.dispose();
    bucket.sessionsIndexFrameEmitter.dispose();
    bucket.workspaceConfigFrameEmitter.dispose();
    bucket.sessionLifecycleEmitter.dispose();
  }
}
