# pi-conversation-ui

Pi 1.5.2+ 对话生态前端组件（严格只读/外挂增强，绝不替换 ZCode 原生 `ToolCallBlocks` 与 `ConversationTimeline`）：

- 严格限定 24 条 Pi 原生 `/` 斜杠命令 + 动态 `get_commands`（绝不混入旧 ZCode 非 Pi 命令）。
- `/btw` 侧边问答浮层（不污染主会话历史）。
- `/export` 离线 HTML 导出。
- 会话分支树（`getTree`）、分叉（`fork`）与安全就地回退（`rewindTo`）弹窗。
