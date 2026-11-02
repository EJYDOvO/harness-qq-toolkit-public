# Harness QQ Toolkit

DSH 的可复用 QQ 通信组件。普通 Agent 不需要 Character、Memory、Persona 或 Remote Ops 即可接入 QQ。

| 组件 | 固定源码基线 |
|---|---|
| DSH | 0.2.1-rc.3，用户自行安装官方发行包 |
| QQ Bot / SDK | 0.5.2 / 1.0.5，必须配套应用两份补丁 |
| Agent I/O / Conversation Manager | 0.1.0-test.8 / 0.1.0-test.3 |
| Remote Ops（可选） | 1.1.1-test.3 |
| 构建工具 | Node 24、锁定依赖、pnpm 11.7.0 |

## 结构与职责

- `plugin-sources/dsh-agent-io`：可信入站、命令、HITL、通知和统一出站队列。
- `plugin-sources/dsh-conversation-manager`：唯一当前 Session 路由、偏好与生命周期。
- `plugin-sources/dsh-remote-ops`：可选 Owner 运维命令；维护后端需另外显式配置。
- `maintenance/qqbot-src`、`sdk-src`：实际兼容代码；对应 upstream 文件/哈希和 `patches` 用于确定性重建与校验。
- `scripts/portable.cjs`、`versions.json`、根锁文件和 `templates`：空目录安装、私有配置和离线数据迁移。
- `maintenance/*.test.*`：权限、I/O、重启、通知与生命周期回归。

不包含 DSH 本体、安装包、旧 Task Memory、浏览器运行包或真实数据。历史记录仍保留在 Git 中；删除工作树文件不清理历史。

## 安装与验证

从 [干净安装与数据恢复](docs/RESTORE.md) 开始。先 `npm ci`，再 `npm test`、`npm run test:audit` 和 `npm run test:patch`。测试自动从锁定的公开包构造隔离代码夹具，不读取已安装 Profile，也不连接 QQ。

`portable prepare` 只写新空目录；`install` 固定版本、应用补丁并冻结生成锁文件；`verify` 校验 tarball 和补丁逐文件哈希。凭据由本地环境变量提供。连接真实 QQ 前必须审查唯一 Owner 白名单和数据恢复结果。

Windows rc.3 是原生验证基线；Mac/Linux 没有同等原生验收。构建脚本允许显式 runtimeExecutable/resourcesDirectory，不能据此宣称已经支持跨系统无损恢复。

## 接口与维护

[通用接入](docs/GENERIC-INTEGRATION.md) · [Interaction](docs/INTERACTION.md) · [诊断](docs/DIAGNOSTICS.md) · [Remote Ops](plugin-sources/dsh-remote-ops/README.md) · [维护后端](maintenance/README.md) · [仓库管理](docs/REPOSITORY.md)。

所有正文、命令、HITL、媒体和通知经唯一 Agent I/O 出口。Typing/ACK 是协议控制，不是对话或审批结算。通知目标是可靠的 at-most-once handoff；unknown/partial 不自动重发，API 接受不等于手机收件。

Character 集成见独立 [Character Agent](https://github.com/EJYDOvO/character-agent-v1)。第三方授权文件保留在 `licenses/` 和对应源码目录；公开可见不等于改变原许可。
