/**
 * V4 Topic 帧物理编码辅助（wireVersion: 3 + measureTopicNotificationEnvelopeBytes）。
 */
import {
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
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
