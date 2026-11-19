/**
 * pi-conversation-ui 公开契约。
 */
import type { ZCodeSlashCommand } from "@zcode/shared";

export interface PiBtwPopoverProps {
  readonly open: boolean;
  readonly workspacePath: string;
  readonly sessionId?: string | null | undefined;
  readonly initialQuestion?: string | undefined;
  readonly onClose: () => void;
}

export interface PiBranchTreeDialogProps {
  readonly open: boolean;
  readonly workspacePath: string;
  readonly sessionId: string | null;
  readonly onClose: () => void;
  readonly onForked?: (newSessionId: string) => void;
  readonly onRewound?: () => void;
}

export interface PiConversationOverlayProps {
  readonly workspacePath: string;
  readonly sessionId: string | null;
  readonly btwOpen: boolean;
  readonly btwInitialQuestion?: string | undefined;
  readonly onBtwOpenChange: (open: boolean, initialQuestion?: string) => void;
  readonly treeOpen: boolean;
  readonly onTreeOpenChange: (open: boolean) => void;
  readonly onExportHtml: () => void;
  readonly onForked?: (newSessionId: string) => void;
  readonly onRewound?: () => void;
}

export type PiSlashCommandList = readonly ZCodeSlashCommand[];
