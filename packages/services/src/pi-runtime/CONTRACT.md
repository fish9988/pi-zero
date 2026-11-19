# pi-runtime

原生 Pi（`@earendil-works/pi-coding-agent` v1.5.2+）运行时的 CLI 发现、严格 LF 切帧 JSONL RPC 传输、V4 会话适配器（Route A `IZCodeAgentService`）、模型目录增强与进程树生命周期边界。

## 公开入口

- `packages/services/src/pi-runtime/index.ts`
- `packages/services/src/pi-runtime/contract.ts`

## 层划分

- `domain/`：纯 TypeScript 的 Pi v1.5.2 RPC 协议类型、模型思考档位能力计算、V4 快照/ACK/队列工厂与流式事件投影器（`PiEventProjector`）；严格禁止任何 Node IO、网络或计时器依赖。
- `adapters/`：跨平台 `pi` CLI 发现、Windows `.cmd` shim 直连 `node <cli.js>` 解析、Windows Job Object / 进程树回收、`PiRpcClient`、模型目录缓存与 `IModelSelectionService` 包装、单会话控制器（`PiSessionController`）与 `IZCodeAgentService` 适配器（`createPiAgentService`）。

## 不变量

1. **禁止 `shell: true`**：所有 `spawn` / `execFile` 调用一律传参数数组并设置 `windowsHide: true`。Windows 上的 `pi.cmd` 解析为 `node <cli.js>`（`ELECTRON_RUN_AS_NODE=1`）直接启动，绝不经过 `cmd.exe`。
2. **严格 LF（`\n`）切帧**：`PiRpcClient` 使用 `StringDecoder("utf8")` 按 `\n` 手动切帧（剥离可选末尾 `\r`），严禁使用 `readline`，防止正文中的 `U+2028` / `U+2029` 截断 JSON 帧。
3. **凭据只进不出与脱敏**：所有 stderr 尾部、版本探测错误与诊断日志统一经 `redactAgentDiagnosticSecrets` 脱敏；Pi 模型目录投影到 `ModelSelectionView` 时绝不暴露明文 API Key / OAuth Token。
4. **零孤儿进程**：Windows 优先通过 `windows-runtime-host`（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）托管，缺失 helper 或 POSIX 环境回退为独立进程组 + `terminateProcessTreeAndWait`；空草稿会话（`phase: "draft"`）不拉起子进程，所有活跃 `PiRpcClient` 在 `disposeServiceResourcesAndWait` 中统一回收。
5. **V4 协议与并发竞态不变量**：
   - `fromSeq` 与上一帧 `toSeq` 严格连续无跳号，`rowId` 会话内单调递增不复用，`UserInputRow` / `TurnHeaderRow` 携带 `sourceCommandId`；
   - 通过单调 `agentLifecycleSeq` 防护 POSIX 管道合帧竞态（`response(prompt)` + `agent_start` + `agent_end` 同 chunk 到达时不得把已归空闲的状态机倒回 `running`）；
   - `agent_end` 携带 `willRetry === true` 时不翻转为空闲，以 `agent_settled` 为准；
   - `stop` 一律先 `clear_queue` 再 `abort`，并将队列置为 `autoDrain = false, pauseReason = "stopped"`。
6. **测试目录隔离**：非打包环境支持 `ZCODE_TEST_PI`（兼容 `STUDIO_TEST_PI`）覆盖；绝不在模块内向用户真实 `~/.pi/agent/` 静默写入测试数据。
