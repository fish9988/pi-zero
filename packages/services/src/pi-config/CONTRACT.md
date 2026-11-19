# pi-config

Pi 1.5.2+（`@earendil-works/pi-coding-agent`）配置、只写凭据、资源包管理、本地用量统计与会话生态（`/btw`、`/export`、分支树 / `fork` / `rewindTo`）服务端托管模块。

## 安全与边界

- **严格只写凭据**：`auth.json`、`.env`、`models.json` 与 `mcp.json` 中的密钥仅写入落盘（`0o600` + 原子写 + `.bak` 语义），永不回传明文、永不写日志。
- **严禁 `shell: true`**：所有 `pi install/remove/update`、受管运行时安装与 `/btw` 子进程均通过参数数组执行，并严格校验包名防参数注入。
- **安全就地回退**：`rewindTo` 写入 `.jsonl` 前必须先关闭对应活跃 `pi` 子进程，避免截断后产生悬挂 `parentId`。
- **目录隔离**：严格尊重 `PI_CODING_AGENT_DIR` / `env`，绝不污染真实 `~/.pi/agent/`。
