import type { PiBranchTreeDialogProps, PiBtwPopoverProps } from "./contract.js";

export const piBtwPopoverExample: PiBtwPopoverProps = {
  open: true,
  workspacePath: "/workspace/demo",
  sessionId: "session-1",
  initialQuestion: "Explain this error briefly",
  onClose: () => {},
};

export const piBranchTreeDialogExample: PiBranchTreeDialogProps = {
  open: true,
  workspacePath: "/workspace/demo",
  sessionId: "session-1",
  onClose: () => {},
};
