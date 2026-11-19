/**
 * V4 Topic 帧物理编码辅助（wireVersion: 3 + measureTopicNotificationEnvelopeBytes）。
 */
import {
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  type ConversationDelta,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
  type SessionsIndexSnapshot,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type SessionSummary,
  type TopicFrameDeliveryKind,
  type TopicWireFrame,
  type WorkspaceConfigSnapshot,
  type WorkspaceConfigState,
  type WorkspaceConfigTopicFrame,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";

export interface TopicSubscriptionState {
  readonly subscriptionId: string;
  readonly topic: string;
  logicalFrameOrdinal: number;
}

export function encodeV4TopicFrames<F>(
  frame: F,
  subscription: TopicSubscriptionState,
  deliveryKind: TopicFrameDeliveryKind,
): TopicWireFrame<F>[] {
  subscription.logicalFrameOrdinal += 1;
  const ordinal = subscription.logicalFrameOrdinal;
  return encodeTopicWireFrames(frame, {
    deliveryKind,
    topic: subscription.topic,
    subscriptionId: subscription.subscriptionId,
    logicalFrameId: `${subscription.subscriptionId}:${ordinal}`,
    logicalFrameOrdinal: ordinal,
    measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
  });
}

export function emitConversationSnapshotFrames(
  sub: TopicSubscriptionState,
  snapshot: ConversationSnapshot,
  deliveryKind: "initial" | "recovery",
  emit: (wire: ConversationTopicWireCandidate) => void,
): void {
  const logicalFrame: ConversationTopicFrame = {
    topic: sub.topic,
    subscriptionId: sub.subscriptionId,
    fromSeq: 0,
    toSeq: snapshot.seq,
    sentAt: Date.now(),
    payload: { kind: "snapshot", snapshot },
  };
  for (const wire of encodeV4TopicFrames(logicalFrame, sub, deliveryKind)) {
    emit(wire);
  }
}

export function emitConversationDeltaFrames(
  subscriptions: Iterable<TopicSubscriptionState>,
  commit: { fromSeq: number; toSeq: number; deltas: readonly ConversationDelta[] },
  sentAt: number,
  emit: (wire: ConversationTopicWireCandidate) => void,
): void {
  for (const sub of subscriptions) {
    const logicalFrame: ConversationTopicFrame = {
      topic: sub.topic,
      subscriptionId: sub.subscriptionId,
      fromSeq: commit.fromSeq,
      toSeq: commit.toSeq,
      sentAt,
      payload: { kind: "deltas", deltas: [...commit.deltas] },
    };
    for (const wire of encodeV4TopicFrames(logicalFrame, sub, "online")) {
      emit(wire);
    }
  }
}

export type PiSessionsIndexDeltaItem =
  | { op: "session.upserted"; session: SessionSummary }
  | { op: "session.removed"; sessionId: string };

export function emitSessionsIndexSnapshotFrames(
  sub: TopicSubscriptionState,
  snapshot: SessionsIndexSnapshot,
  toSeq: number,
  deliveryKind: "initial" | "recovery",
  emit: (wire: SessionsIndexTopicWireCandidate) => void,
): void {
  const logicalFrame: SessionsIndexTopicFrame = {
    topic: sub.topic,
    subscriptionId: sub.subscriptionId,
    fromSeq: 0,
    toSeq,
    sentAt: Date.now(),
    payload: { kind: "snapshot", snapshot },
  };
  for (const wire of encodeV4TopicFrames(logicalFrame, sub, deliveryKind)) {
    emit(wire);
  }
}

export function emitSessionsIndexDeltaFrames(
  subscriptions: Iterable<TopicSubscriptionState>,
  commit: { fromSeq: number; toSeq: number; deltas: readonly PiSessionsIndexDeltaItem[] },
  sentAt: number,
  emit: (wire: SessionsIndexTopicWireCandidate) => void,
): void {
  for (const sub of subscriptions) {
    const logicalFrame: SessionsIndexTopicFrame = {
      topic: sub.topic,
      subscriptionId: sub.subscriptionId,
      fromSeq: commit.fromSeq,
      toSeq: commit.toSeq,
      sentAt,
      payload: { kind: "deltas", deltas: [...commit.deltas] },
    };
    for (const wire of encodeV4TopicFrames(logicalFrame, sub, "online")) {
      emit(wire);
    }
  }
}

export function emitWorkspaceConfigSnapshotFrames(
  sub: TopicSubscriptionState,
  snapshot: WorkspaceConfigSnapshot,
  toSeq: number,
  deliveryKind: "initial" | "recovery",
  emit: (wire: WorkspaceConfigTopicWireCandidate) => void,
): void {
  const logicalFrame: WorkspaceConfigTopicFrame = {
    topic: sub.topic,
    subscriptionId: sub.subscriptionId,
    fromSeq: 0,
    toSeq,
    sentAt: Date.now(),
    payload: { kind: "snapshot", snapshot },
  };
  for (const wire of encodeV4TopicFrames(logicalFrame, sub, deliveryKind)) {
    emit(wire);
  }
}

export function emitWorkspaceConfigDeltaFrames(
  subscriptions: Iterable<TopicSubscriptionState>,
  commit: { fromSeq: number; toSeq: number; config: WorkspaceConfigState },
  sentAt: number,
  emit: (wire: WorkspaceConfigTopicWireCandidate) => void,
): void {
  for (const sub of subscriptions) {
    const logicalFrame: WorkspaceConfigTopicFrame = {
      topic: sub.topic,
      subscriptionId: sub.subscriptionId,
      fromSeq: commit.fromSeq,
      toSeq: commit.toSeq,
      sentAt,
      payload: { kind: "deltas", deltas: [{ op: "config.updated", config: commit.config }] },
    };
    for (const wire of encodeV4TopicFrames(logicalFrame, sub, "online")) {
      emit(wire);
    }
  }
}
