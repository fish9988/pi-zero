/**
 * 新会话首轮对话完成后的自动智能重命名 Hook（需用户在设置中手动开启）。
 */
import { useEffect, useRef } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import { runSmartRenamePiSession } from "./piSessionActions.js";
import { usePiSmartRenamePreferences } from "./piSmartRenamePreferences.js";

const autoRenamedSessionIds = new Set<string>();

export function usePiAutoSmartRename(params: {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string | undefined;
  readonly sessionId: string | null;
  readonly snapshot: ConversationSnapshot | null;
}): void {
  const { workspacePath, workspaceIdentity, sessionId, snapshot } = params;
  const services = useServices();
  const { autoRenameOnFirstTurn } = usePiSmartRenamePreferences();
  const prevPhaseRef = useRef<string | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      prevPhaseRef.current = snapshot?.control.phase ?? null;
      return;
    }

    const phase = snapshot?.control.phase ?? null;
    const prevPhase = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    if (!autoRenameOnFirstTurn || !sessionId || !snapshot) return;
    if (autoRenamedSessionIds.has(sessionId)) return;

    const wasRunning =
      prevPhase === "running" || prevPhase === "initializing" || prevPhase === "stopping";
    if (!wasRunning || phase !== "completedSuccess") return;

    if (snapshot.meta.titleSource !== "default") return;
    const turnCount = snapshot.rows.window.filter((row) => row.kind === "turnHeader").length;
    if (turnCount !== 1) return;

    autoRenamedSessionIds.add(sessionId);
    void runSmartRenamePiSession({
      services,
      workspacePath,
      workspaceIdentity,
      sessionId,
      currentTitle: snapshot.meta.title,
      silent: true,
    });
  }, [autoRenameOnFirstTurn, services, sessionId, snapshot, workspaceIdentity, workspacePath]);
}
