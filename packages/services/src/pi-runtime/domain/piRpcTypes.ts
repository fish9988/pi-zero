/**
 * Pi（@earendil-works/pi-coding-agent v1.5.2+）RPC 协议与 v3 JSONL 会话纯类型定义。
 * 属于 domain 层：严格保持纯 TypeScript，不引入任何 Node IO、网络或计时器依赖。
 */

export function isPiRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type PiBuiltinToolName =
  | "read"
  | "edit"
  | "write"
  | "bash"
  | "powershell"
  | "grep"
  | "find"
  | "ls";

export type PiPromptDisposition = "started" | "queued" | "handled";

export type PiQueueDisposition = "handled" | "queued";

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiTextContent {
  type: "text";
  text: string;
  textSignature?: string | undefined;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string | undefined;
  redacted?: boolean | undefined;
}

export interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string | undefined;
}

export type PiContentBlock = PiTextContent | PiThinkingContent | PiToolCallContent | PiImageContent;

export interface PiUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 若存在，已包含在 output 中，不可重复叠加。 */
  reasoning?: number | undefined;
  totalTokens?: number | undefined;
  cost?: PiUsageCost | undefined;
}

export interface PiSystemMessage {
  role: "system";
  content?: string | readonly PiTextContent[] | undefined;
  sections?: readonly Record<string, unknown>[] | undefined;
  toolsAdded?: readonly string[] | undefined;
  toolsRemoved?: readonly string[] | undefined;
  timestamp?: number | undefined;
}

export interface PiUserMessage {
  role: "user";
  content: string | (PiTextContent | PiImageContent)[];
  timestamp?: number | undefined;
}

export type PiAssistantStopReason =
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred"
  | "pending"
  | (string & {});

export interface PiAssistantMessage {
  role: "assistant";
  content: (PiTextContent | PiThinkingContent | PiToolCallContent)[];
  api?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: string | undefined;
  responseId?: string | undefined;
  usage?: PiUsage | undefined;
  stopReason?: PiAssistantStopReason | undefined;
  errorMessage?: string | undefined;
  timestamp?: number | undefined;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (PiTextContent | PiImageContent)[];
  details?: Record<string, unknown> | undefined;
  usage?: PiUsage | undefined;
  nestedCalls?: readonly Record<string, unknown>[] | undefined;
  isError?: boolean | undefined;
  timestamp?: number | undefined;
}

export interface PiBashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number | null | undefined;
  cancelled?: boolean | undefined;
  truncated?: boolean | undefined;
  fullOutputPath?: string | undefined;
  timestamp?: number | undefined;
  excludeFromContext?: boolean | undefined;
}

export interface PiCustomAgentMessage {
  role: "custom" | "branchSummary" | "compactionSummary";
  customType?: string | undefined;
  content?: string | (PiTextContent | PiImageContent)[] | undefined;
  summary?: string | undefined;
  fromId?: string | undefined;
  tokensBefore?: number | undefined;
  display?: boolean | undefined;
  details?: unknown;
  timestamp?: number | undefined;
}

export type PiAgentMessage =
  | PiSystemMessage
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiBashExecutionMessage
  | PiCustomAgentMessage;

export interface PiEditToolItem {
  oldText: string;
  newText: string;
}

/** Pi v1.5.2 原生 edit 参数使用 edits[]，同时兼容旧版/测试替身扁平字段。 */
export interface PiEditToolArgs {
  path: string;
  edits?: readonly PiEditToolItem[] | undefined;
  oldText?: string | undefined;
  newText?: string | undefined;
  old_str?: string | undefined;
  new_str?: string | undefined;
}

export interface PiEditToolResultDetails {
  diff?: string | undefined;
  patch?: string | undefined;
  firstChangedLine?: number | undefined;
}

export interface PiModelInfo {
  id: string;
  name: string;
  api?: string | undefined;
  provider: string;
  baseUrl?: string | undefined;
  reasoning?: boolean | undefined;
  /** Pi 档位 -> 上游值；null 表示明确不支持该档位。 */
  thinkingLevelMap?: Record<string, string | null | undefined> | undefined;
  input?: ("text" | "image")[] | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  cost?:
    | {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      }
    | undefined;
}

export interface PiStateData {
  model?: PiModelInfo | undefined;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string | undefined;
  sessionId: string;
  sessionName?: string | undefined;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface PiCommandInfo {
  name: string;
  description?: string | undefined;
  source: "extension" | "prompt" | "skill" | (string & {});
  sourceInfo?:
    | {
        path: string;
        source: string;
        scope: "user" | "project" | "temporary" | (string & {});
        origin: string;
        baseDir?: string | undefined;
      }
    | undefined;
}

export interface PiSessionStats {
  sessionFile?: string | undefined;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?:
    | {
        tokens: number | null;
        contextWindow: number;
        percent: number | null;
      }
    | undefined;
}

export interface PiCompactResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number | undefined;
  usage?: PiUsage | undefined;
  details?: Record<string, unknown> | undefined;
}

export interface PiTreeNode {
  entry: Record<string, unknown>;
  children: PiTreeNode[];
  label?: string | undefined;
  labelTimestamp?: string | undefined;
}

export type PiRpcCommandType =
  | "get_state"
  | "get_messages"
  | "get_available_models"
  | "get_available_thinking_levels"
  | "get_commands"
  | "get_session_stats"
  | "prompt"
  | "steer"
  | "follow_up"
  | "clear_queue"
  | "abort"
  | "new_session"
  | "switch_session"
  | "set_model"
  | "cycle_model"
  | "set_thinking_level"
  | "cycle_thinking_level"
  | "compact"
  | "export_html"
  | "fork"
  | "clone"
  | "get_fork_messages"
  | "get_tree"
  | "get_entries"
  | "get_last_assistant_text"
  | "set_session_name"
  | "set_steering_mode"
  | "set_follow_up_mode"
  | "set_auto_compaction"
  | "set_auto_retry"
  | "abort_retry"
  | "bash"
  | "abort_bash";

export interface PiRpcResponseSuccess<T = unknown> {
  type: "response";
  id?: string | undefined;
  command: string;
  success: true;
  data?: T | undefined;
}

export interface PiRpcResponseFailure {
  type: "response";
  id?: string | undefined;
  command: string;
  success: false;
  error: string;
}

export type PiRpcResponse<T = unknown> = PiRpcResponseSuccess<T> | PiRpcResponseFailure;

export type PiAssistantMessageEvent =
  | { type: "start"; partial?: PiAssistantMessage | undefined }
  | { type: "text_start"; contentIndex: number; partial?: PiAssistantMessage | undefined }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial?: PiAssistantMessage | undefined;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content: string;
      partial?: PiAssistantMessage | undefined;
    }
  | { type: "thinking_start"; contentIndex: number; partial?: PiAssistantMessage | undefined }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      partial?: PiAssistantMessage | undefined;
    }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: string;
      partial?: PiAssistantMessage | undefined;
    }
  | {
      type: "toolcall_start";
      contentIndex: number;
      id?: string | undefined;
      toolName?: string | undefined;
      partial?: PiAssistantMessage | undefined;
    }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial?: PiAssistantMessage | undefined;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: PiToolCallContent;
      partial?: PiAssistantMessage | undefined;
    }
  | { type: "done"; reason?: string | undefined; message?: PiAssistantMessage | undefined }
  | { type: "error"; reason?: string | undefined; error?: PiAssistantMessage | undefined };

export interface PiExtensionUiRequestEvent {
  type: "extension_ui_request";
  id: string;
  method:
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | "set_editor_text"
    | (string & {});
  title?: string | undefined;
  message?: string | undefined;
  options?: string[] | undefined;
  placeholder?: string | undefined;
  prefill?: string | undefined;
  timeout?: number | undefined;
  notifyType?: "info" | "warning" | "error" | undefined;
  statusKey?: string | undefined;
  statusText?: string | undefined;
  widgetKey?: string | undefined;
  widgetLines?: string[] | undefined;
  widgetPlacement?: "aboveEditor" | "belowEditor" | undefined;
  text?: string | undefined;
}

export type PiExtensionUiResponsePayload =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

export type PiCompactionReason = "manual" | "threshold" | "overflow" | (string & {});

export type PiRpcEvent =
  | { type: "agent_start" }
  | {
      type: "agent_end";
      messages?: PiAgentMessage[] | undefined;
      willRetry?: boolean | undefined;
    }
  | { type: "agent_settled"; aborted: boolean }
  | { type: "turn_start" }
  | {
      type: "turn_end";
      message?: PiAssistantMessage | undefined;
      toolResults?: PiToolResultMessage[] | undefined;
    }
  | { type: "message_start"; message: PiAgentMessage }
  | {
      type: "message_update";
      message?: PiAssistantMessage | undefined;
      usage?: PiUsage | undefined;
      assistantMessageEvent: PiAssistantMessageEvent;
    }
  | { type: "message_end"; message: PiAgentMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult: {
        content?: (PiTextContent | PiImageContent)[] | undefined;
        details?: Record<string, unknown> | undefined;
      };
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: {
        content?: (PiTextContent | PiImageContent)[] | undefined;
        details?: Record<string, unknown> | undefined;
      };
      isError: boolean;
      durationMs?: number | undefined;
    }
  | { type: "compaction_start"; reason: PiCompactionReason }
  | {
      type: "compaction_end";
      reason: PiCompactionReason;
      result?: PiCompactResult | null | undefined;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string | undefined;
    }
  | { type: "auto_compaction_start"; reason?: PiCompactionReason | undefined }
  | {
      type: "auto_compaction_end";
      reason?: PiCompactionReason | undefined;
      result?: PiCompactResult | null | undefined;
      aborted?: boolean | undefined;
      willRetry?: boolean | undefined;
      errorMessage?: string | undefined;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt: number;
      finalError?: string | undefined;
    }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "entry_appended"; entry: Record<string, unknown> }
  | PiExtensionUiRequestEvent
  | { type: "extension_error"; extensionPath: string; event: string; error: string }
  | { type: "session_info_changed"; name?: string | undefined }
  | { type: "thinking_level_changed"; level: string }
  | {
      type: "bash_execution_update";
      id?: string | undefined;
      delta?: string | undefined;
      chunk?: string | undefined;
      fullOutput?: string | undefined;
      truncated?: boolean | undefined;
    }
  | {
      type: "summarization_retry_scheduled";
      source?: string | undefined;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "summarization_retry_attempt_start";
      source: string;
      reason?: string | undefined;
      attempt?: number | undefined;
      maxAttempts?: number | undefined;
    }
  | {
      type: "summarization_retry_finished";
      source?: string | undefined;
      success?: boolean | undefined;
      attempt?: number | undefined;
      aborted?: boolean | undefined;
      finalError?: string | undefined;
    };

export interface PiSessionHeaderEntry {
  type: "session";
  version?: number | undefined;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string | undefined;
  title?: string | undefined;
}

export interface PiSessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export type PiSessionEntry =
  | PiSessionHeaderEntry
  | { type: "title"; title: string }
  | (PiSessionEntryBase & { type: "session_info"; name: string })
  | (PiSessionEntryBase & { type: "message"; message: PiAgentMessage })
  | (PiSessionEntryBase & {
      type: "compaction";
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      systemMessage?: string | undefined;
      usage?: PiUsage | undefined;
      details?: Record<string, unknown> | undefined;
      fromHook?: boolean | undefined;
    })
  | (PiSessionEntryBase & {
      type: "branch_summary";
      fromId?: string | undefined;
      summary: string;
      usage?: PiUsage | undefined;
      details?: Record<string, unknown> | undefined;
      fromHook?: boolean | undefined;
    })
  | (PiSessionEntryBase & {
      type: "model_change";
      provider?: string | undefined;
      modelId?: string | undefined;
      model?: string | undefined;
      role?: string | undefined;
    })
  | (PiSessionEntryBase & { type: "thinking_level_change"; thinkingLevel: string })
  | (PiSessionEntryBase & {
      type: "custom_message";
      customType: string;
      content: string | (PiTextContent | PiImageContent)[];
      display?: boolean | undefined;
      details?: unknown;
    })
  | (PiSessionEntryBase & { type: "custom"; customType: string; data?: unknown })
  | (PiSessionEntryBase & {
      type: "context_edit";
      targetId: string;
      replacement: null | string | readonly PiContentBlock[];
    })
  | (PiSessionEntryBase & {
      type: "usage";
      kind?: string | undefined;
      provider?: string | undefined;
      model?: string | undefined;
      usage: PiUsage;
    })
  | (PiSessionEntryBase & { type: "label"; targetId: string; label?: string | undefined });
