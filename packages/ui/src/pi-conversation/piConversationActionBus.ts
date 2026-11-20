export type PiConversationActionEventDetail = {
  readonly kind: "btw" | "tree" | "export";
  readonly workspacePath?: string | undefined;
  readonly sessionId?: string | null | undefined;
};

const PI_CONVERSATION_ACTION_EVENT = "pi-zero:conversation-action";

export function dispatchPiConversationAction(detail: PiConversationActionEventDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<PiConversationActionEventDetail>(PI_CONVERSATION_ACTION_EVENT, { detail }),
  );
}

export function subscribePiConversationAction(
  listener: (detail: PiConversationActionEventDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handleEvent = (event: Event) => {
    const detail = (event as CustomEvent<PiConversationActionEventDetail>).detail;
    if (detail?.kind) {
      listener(detail);
    }
  };
  window.addEventListener(PI_CONVERSATION_ACTION_EVENT, handleEvent);
  return () => {
    window.removeEventListener(PI_CONVERSATION_ACTION_EVENT, handleEvent);
  };
}
