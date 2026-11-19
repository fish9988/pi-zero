# pi-config-protocol

Pi 1.5.2+（`@earendil-works/pi-coding-agent`）共享配置、凭据状态、资源管理、本地用量与会话生态契约（浏览器安全，零 Node IO 依赖）。

## 对外契约

- 仅通过 `index.ts` 与 `contract.ts`（`@zcode/shared/pi-config`）暴露纯数据类型、Pi 1.5.2 设置 Schema、内置 Provider 元信息及 24 条原生 `/` 斜杠命令表。
- **凭据只写不回传**：所有 auth/env/mcp/models 读模型均禁止携带明文 API Key、OAuth Token、环境变量值或 HTTP Header 密钥值。
- **零旧命令混入**：`PI_NATIVE_SLASH_COMMANDS` 严格对应 Pi 1.5.2 原生 24 条斜杠命令，禁止混入旧版 ZCode/OMP 非 Pi 命令。
