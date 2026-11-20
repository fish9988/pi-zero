/**
 * Pi V4 会话队列纯状态变更辅助（domain 层，无 IO/计时器）。
 * 负责队列项编号、编辑锁校验、增删改重排与暂停状态计算。
 */
import type { ModelSelection } from "@zcode/shared";
import type { QueueItem, QueueState } from "@zcode/shared/zcode-protocol-v4";
import { createQueueItem } from "#src/pi-runtime/domain/piSnapshotFactory.js";

export type QueueMutationOutcome =
  | { ok: true; queue: QueueState; changed: boolean }
  | { ok: false; status: "rejected" | "noop"; reasonCode: string; message?: string };

function reindexQueueItems(items: readonly QueueItem[]): QueueItem[] {
  return items.map((item, index) => ({
    ...item,
    order: {
      admissionSeq: item.order.admissionSeq,
      queuePosition: index,
    },
  }));
}

export function enqueueQueueText(
  queue: QueueState,
  input: {
    sourceCommandId: string;
    queueItemId: string;
    clientId: string;
    text: string;
    attachments?: QueueItem["attachments"] | undefined;
    admissionSeq: number;
    admittedAt: number;
    requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
    modelSelection?: ModelSelection | undefined;
    inputOrigin?: "desktop" | "mobile" | undefined;
  },
): QueueState {
  const nextItem = createQueueItem({
    ...input,
    queuePosition: queue.items.length,
  });
  return {
    ...queue,
    items: reindexQueueItems([...queue.items, nextItem]),
  };
}

export function dequeueMatchingQueueItem(
  queue: QueueState,
  text: string,
): { queue: QueueState; item: QueueItem | null } {
  if (queue.items.length === 0) return { queue, item: null };
  const exactIndex = queue.items.findIndex((item) => item.text === text);
  const targetIndex = exactIndex >= 0 ? exactIndex : 0;
  const item = queue.items[targetIndex] ?? null;
  if (!item) return { queue, item: null };
  const remaining = queue.items.filter((_, index) => index !== targetIndex);
  return {
    item,
    queue: {
      ...queue,
      items: reindexQueueItems(remaining),
    },
  };
}

export function removeQueueItemById(queue: QueueState, queueItemId: string): QueueMutationOutcome {
  const target = queue.items.find((item) => item.queueItemId === queueItemId);
  if (!target) {
    return { ok: false, status: "noop", reasonCode: "proto.queueItemNotFound" };
  }
  if (target.editLock) {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.queue.editLocked",
      message: "Queue item is currently being edited",
    };
  }
  const remaining = reindexQueueItems(
    queue.items.filter((item) => item.queueItemId !== queueItemId),
  );
  return {
    ok: true,
    changed: true,
    queue: {
      ...queue,
      items: remaining,
    },
  };
}

export function editQueueItemById(
  queue: QueueState,
  input: {
    queueItemId: string;
    newText: string;
    editorId?: string | undefined;
    modelSelection?: ModelSelection | undefined;
  },
): QueueMutationOutcome {
  const index = queue.items.findIndex((item) => item.queueItemId === input.queueItemId);
  if (index === -1) {
    return { ok: false, status: "noop", reasonCode: "proto.queueItemNotFound" };
  }
  const existing = queue.items[index]!;
  if (existing.editLock && input.editorId && existing.editLock.editorId !== input.editorId) {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.queue.editLockMismatch",
      message: "Queue item is locked by another editor",
    };
  }
  const updated: QueueItem = {
    ...existing,
    text: input.newText,
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
  };
  delete updated.editLock;
  const nextItems = [...queue.items];
  nextItems[index] = updated;
  return {
    ok: true,
    changed: true,
    queue: {
      ...queue,
      items: reindexQueueItems(nextItems),
    },
  };
}

export function reorderQueueItems(
  queue: QueueState,
  queueItemId: string,
  beforeQueueItemId: string | null,
): QueueMutationOutcome {
  const sourceIndex = queue.items.findIndex((item) => item.queueItemId === queueItemId);
  if (sourceIndex === -1) {
    return { ok: false, status: "noop", reasonCode: "proto.queueItemNotFound" };
  }
  const target = queue.items[sourceIndex]!;
  if (target.editLock) {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.queue.editLocked",
      message: "Queue item is currently being edited",
    };
  }
  const withoutSource = queue.items.filter((item) => item.queueItemId !== queueItemId);
  let insertIndex = withoutSource.length;
  if (beforeQueueItemId !== null) {
    const foundBefore = withoutSource.findIndex((item) => item.queueItemId === beforeQueueItemId);
    if (foundBefore === -1) {
      return { ok: false, status: "noop", reasonCode: "proto.queueItemNotFound" };
    }
    insertIndex = foundBefore;
  }
  const nextItems = [
    ...withoutSource.slice(0, insertIndex),
    target,
    ...withoutSource.slice(insertIndex),
  ];
  return {
    ok: true,
    changed: true,
    queue: {
      ...queue,
      items: reindexQueueItems(nextItems),
    },
  };
}

export function lockQueueItemForEdit(
  queue: QueueState,
  input: {
    queueItemId: string;
    editorId: string;
    clientId: string;
    inputOrigin?: "desktop" | "mobile" | undefined;
  },
): QueueMutationOutcome {
  const index = queue.items.findIndex((item) => item.queueItemId === input.queueItemId);
  if (index === -1) {
    return { ok: false, status: "noop", reasonCode: "proto.queueItemNotFound" };
  }
  const existing = queue.items[index]!;
  if (existing.editLock && existing.editLock.editorId !== input.editorId) {
    return {
      ok: false,
      status: "rejected",
      reasonCode: "guard.queue.editLocked",
      message: "Queue item is already locked",
    };
  }
  const nextItems = [...queue.items];
  nextItems[index] = {
    ...existing,
    editLock: {
      editorId: input.editorId,
      clientId: input.clientId,
      ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
    },
  };
  return {
    ok: true,
    changed: true,
    queue: {
      ...queue,
      items: nextItems,
    },
  };
}

export function releaseQueueItemLock(queue: QueueState, queueItemId: string): QueueMutationOutcome {
  const index = queue.items.findIndex((item) => item.queueItemId === queueItemId);
  if (index === -1) {
    return { ok: false, status: "noop", reasonCode: "proto.queueItemNotFound" };
  }
  const existing = queue.items[index]!;
  if (!existing.editLock) {
    return { ok: true, changed: false, queue };
  }
  const updated: QueueItem = { ...existing };
  delete updated.editLock;
  const nextItems = [...queue.items];
  nextItems[index] = updated;
  return {
    ok: true,
    changed: true,
    queue: {
      ...queue,
      items: nextItems,
    },
  };
}

export function setQueueAutoDrainState(queue: QueueState, autoDrain: boolean): QueueState {
  if (autoDrain) {
    const next: QueueState = {
      items: queue.items,
      autoDrain: true,
    };
    return next;
  }
  return {
    items: queue.items,
    autoDrain: false,
    pauseReason: queue.pauseReason ?? "manual",
  };
}

export function pauseQueueWithReason(
  queue: QueueState,
  reason: "stopped" | "manual" | "error",
): QueueState {
  return {
    items: queue.items,
    autoDrain: false,
    pauseReason: reason,
  };
}

export function clearQueueItems(queue: QueueState, autoDrain = true): QueueState {
  return autoDrain
    ? { items: [], autoDrain: true }
    : { items: [], autoDrain: false, pauseReason: queue.pauseReason ?? "stopped" };
}
