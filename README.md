# Pi Zero

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="Pi Zero" width="128" height="128" />
</div>

<p align="center">
  <strong>Modern Electron Desktop Workbench Powered by Native Pi (<code>@earendil-works/pi-coding-agent</code>)</strong>
</p>

**Pi Zero** 是基于开源 ZCode 桌面壳与原生 **Pi（`@earendil-works/pi-coding-agent` v1.5.2+）** 引擎深度融合打造的纯本地桌面 AI 编程工作台——无需登录商业账号、无强制云端升级拦截，开箱即享完整的多窗口工作区、工具调用可视化与原生 Pi 生态能力。

---

## 核心特性

- **原生 Pi 1.5.2+ 运行时直连**：通过 `pi --mode rpc` JSONL 协议驱动本机 Pi 引擎，严格按 `\n` 切帧并具备 Windows 进程树 containment，支持流式输出、`steer` / `followUp` 消息队列、实时思考强度（Thinking Level）与模型目录热切换。
- **100% 保留原生 ToolCallBlocks 体验**：完整保留 ZCode 桌面端丰富的工具调用折叠卡片、Diff 视图、命令输出与文件变更展示，同时兼容离线 Pi JSONL v3 会话历史水合与终端版 `pi` 实时同步。
- **9 大 Pi 设置中心**：完整纳管 `~/.pi/agent/` 与项目级 `.pi/` 生态配置，覆盖通用、Provider 与凭据（密钥只进不出、绝不回传明文）、模型与思考、会话与 Context、扩展 / 包与 Skill、工具与系统提示词、网络与高级、快捷键与关于。
- **现代化双模式主题**：内置 4 套精调双模式视觉主题，极简克制的桌面工作台布局。
- **纯本地免登录工作台**：移除旧商业账号登录与云端强更拦截，内置 PowerShell 7 侧边终端面板与右侧多模式工作台（文件 / 变更 / 浏览器）。
- **独立并排安装安全**：采用独立应用标识（`dev.pizero.app`）、独立安装目录（`Pi Zero`）、独立 Electron 数据目录（`%APPDATA%\Pi Zero`）、独立协议（`pizero://`）与独立 Windows 右键菜单（`PiZero.OpenInPiZero`），可与原有 ZCode 客户端 100% 并排安装运行，互不覆盖。

---

## 快速开始

### 环境要求

- **Node.js** `>= 24.0.0`
- **pnpm** `10.33.2`
- 本机已安装原生 **Pi CLI**（`@earendil-works/pi-coding-agent` `v1.5.2+`，在 `PATH` 中可执行 `pi`）

### 安装与开发

```bash
# 安装依赖
pnpm install

# 启动桌面端开发环境
pnpm dev:desktop
```

### 质量门禁与打包

```bash
# 静态类型检查与代码规范
pnpm typecheck
pnpm lint
pnpm architecture:check -- --changed
pnpm test:architecture

# 构建桌面端产物（跳过旧版运行时下载）
pnpm --filter @zcode/desktop build:no-runtime-assets

# 打包 Windows x64 安装包（产出 packages/desktop/dist/PiZero-<version>-win-x64.exe）
pnpm --filter @zcode/desktop run bundle -- --os win --arch x64 --skip-prepare --skip-build
```

---

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `packages/desktop` | Electron Main、Host、Preload、Renderer 与桌面端打包配置 |
| `packages/ui` | 共享 React UI 组件、现代化主题与 Pi 设置中心 |
| `packages/services` | Pi RPC 运行时适配器、会话历史水合与本地配置持久化 |
| `packages/shared` / `packages/rpc` / `packages/client` | 共享协议类型、IPC 通道与客户端抽象 |
| `packages/provider` / `packages/provider-node` | 模型与 Provider 元数据定义 |
| `scripts` / `config` / `third-party` | 构建与架构治理脚本、默认配置与第三方声明材料 |

---

## 开源许可与致谢

本项目采用 **Apache-2.0** 开源许可，基于 ZCode 桌面框架演进并由原生 `@earendil-works/pi-coding-agent` 驱动。完整的版权声明与第三方开源组件许可详见：

- [LICENSE](LICENSE)
- [NOTICE.md](NOTICE.md)
- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
