# OpenClaw 中文上手与安全验收：从安装到第一条可用消息

> 面向 macOS、Linux、WSL2 与 Windows 用户的最短可验证路径。本文依据 OpenClaw 官方 README、安装文档与贡献指南整理，并于 2026-08-11 核对。

作者：[Aris Li](https://github.com/ArisLiWind)（深圳 / APAC）

## 先理解一件事：OpenClaw 在哪里运行？

OpenClaw 是运行在你自己设备上的个人 AI 助手。核心进程是 **Gateway**：它连接模型、工具、会话和聊天渠道；Control UI、CLI、TUI 以及 WhatsApp、Telegram、Slack、Discord 等渠道都通过 Gateway 工作。

这意味着你首先要验证的不是“界面是否打开”，而是下面这条最小链路：

1. OpenClaw 已安装；
2. 模型访问已配置；
3. Gateway 正常运行；
4. Control UI 能发送一条消息并收到回复；
5. 安全边界符合你的使用场景。

## 1. 安装

### macOS / Linux / WSL2

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Windows PowerShell

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

如果你已经自行管理 Node.js，也可以安装 npm 包：

```bash
npm install -g openclaw@latest
```

当前官方 README 要求受支持的 Node.js 版本为 **22.22.3+、24.15+ 或 25.9+**。如果安装在依赖阶段失败，先确认版本：

```bash
node --version
npm --version
```

## 2. 完成引导并启动 Gateway

```bash
openclaw onboard --install-daemon
openclaw gateway status
openclaw dashboard
```

`onboard` 会验证模型访问、创建工作区并配置 Gateway；`gateway status` 用来确认核心进程状态；`dashboard` 会打开 Control UI。

## 3. 用一条消息完成最小验收

在 Control UI 发送：

```text
请只回复：OPENCLAW_OK
```

通过标准：

- 页面成功发送消息；
- 助手返回 `OPENCLAW_OK`；
- `openclaw gateway status` 仍显示 Gateway 正常；
- 没有把密钥、私人文件内容或敏感日志复制到公开渠道。

如果这一步失败，先记录四项信息：OpenClaw 版本、操作系统、模型 / Provider 路由、实际错误。提问或报错时提供这些信息，比只说“不能用”更容易获得帮助。

## 4. 连接聊天渠道前，先完成安全检查

OpenClaw 官方 README 明确提醒：把外部消息视为不可信输入。主会话中的工具默认可能在宿主机运行，因此连接其他用户或把 Gateway 暴露到公网前，应先阅读安全与沙箱文档。

最低安全清单：

- 不在教程、截图、Issue 或聊天中公开 API Key；
- 不把 Gateway 直接暴露到公网，除非已理解访问控制与暴露风险；
- 陌生发送者使用配对流程，不默认放行；
- 给 Agent 的文件、命令和网络权限遵循最小权限原则；
- 高影响操作保留人工确认；
- 先在测试目录与非关键账号上验证工具行为。

每次修改安全相关配置后、以及任何公网暴露之前，先运行官方审计：

```bash
openclaw security audit
openclaw security audit --deep
```

如果审计提示“开放访问 + 工具已启用”，优先收紧 DM / 群组策略与 allowlist，再处理工具权限和沙箱。

陌生私信渠道的配对批准命令格式为：

```bash
openclaw pairing approve <channel> <code>
```

## 5. 什么时候算“已经上手”？

建议用下面五个可观察结果验收，而不是只看安装命令是否执行完：

- [ ] CLI 可运行；
- [ ] Gateway 状态正常；
- [ ] Control UI 可访问；
- [ ] 一条最小消息得到预期回复；
- [ ] 已写下自己的权限边界与回滚方式。

## 6. 从使用者变成贡献者

OpenClaw 的官方贡献路由很明确：

- Bug 或小修复：可直接提交聚焦的 PR；
- 文档缺失、矛盾或错误：先给出具体 URL / 路径、验证步骤、期望内容、实际内容与影响；
- 新功能或架构变化：先开 Feature Request 或在 Discord 讨论；
- 一般安装问题：优先到 Discord 的帮助频道，不要把支持问题伪装成 GitHub Issue；
- 新能力通常更适合做成插件，并通过 ClawHub 分享。

贡献前应阅读完整指南。官方也要求 PR 写清楚它解决的用户问题，并提供可核验的证据；AI 辅助贡献可以接受，但必须透明标注且作者需要理解提交内容。

## 官方入口

- [OpenClaw 官方仓库](https://github.com/openclaw/openclaw)
- [Getting Started](https://docs.openclaw.ai/start/getting-started)
- [安装文档](https://docs.openclaw.ai/install)
- [Gateway 安全指南](https://docs.openclaw.ai/gateway/security)
- [沙箱指南](https://docs.openclaw.ai/gateway/sandboxing)
- [贡献指南](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md)
- [Good first issues](https://github.com/openclaw/openclaw/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)

## 勘误与反馈

如果本文中的命令与最新官方文档不一致，请以官方文档为准，并附上对应官方页面与复现信息提交勘误。
