# pi-settings-ui

Pi 1.5.2+ 桌面设置中心 UI 模块（Section 2–9），通过 `useServices().piConfigService`（`IPiConfigService`）与 Host RPC 交互。

## 边界与不变量

- 只通过 `useServices().piConfigService` 读写 Pi 原生配置（`~/.pi/agent/` 与 `<cwd>/.pi/`），禁止直接访问文件系统或 Node API。
- API Key、OAuth 凭据与 `.env` 密钥严格只进不出：界面仅展示脱敏状态或已配置标记，绝不展示或日志输出明文密钥。
- 模型与思考页保留 ZCode 原生 `ModelProviderSection`（第三方 `/models` 批量导入与多档思考可视化编辑器），通过 `PiModelsSyncBridge` 同步写入 `~/.pi/agent/models.json` 与 `settings.json`。
- 严格遵循 `DESIGN.md` 字体 token（`text-ui-*`）与语义色 token。
