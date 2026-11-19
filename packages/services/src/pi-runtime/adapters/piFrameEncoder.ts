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
  type TopicFrameDeliveryKind,
  type TopicWireFrame,
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
