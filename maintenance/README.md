# QQ 端维护手册

本文适用于原 Windows 维护后端，包含旧实例的目录、Preset 和功能约定；不表示所有 QQTK 项目或当前生产都采用相同配置。普通 Agent 的最小 QQ 接入见 [通用集成](../docs/GENERIC-INTEGRATION.md)，Remote Ops 1.1 的独立模式和服务后端见 [插件说明](../plugin-sources/dsh-remote-ops/README.md)。

原验收基线为 DSH 0.2.0-rc.2、desktop Profile、Creator（cordis）及单 Owner 私聊。模型、子 Agent 限制、Preset 和自启动状态均应以目标实例实际配置为准。Character 项目有自己的 Preset 和部署流程，不要为了套用本文而把它改回 cordis。

## 在 QQ 使用

首次配置后发送 `/preset cordis`，再发送 `/new`，使新会话使用 Creator 工具集。已有会话会保留创建时的预设。`/bot-status` 看状态，`/model` 看或切换模型，`/compact` 压缩长上下文，`/stop` 停止当前生成。

可直接说：

- “检查 Harness 和插件状态，告诉我有没有可更新版本。”
- “把这项工作拆成调查、实现、复核，最多三个 Agent，不要同时改相同文件。”
- “准备插件升级，先测试并给我结果。”
- “应用刚才验证通过的插件版本，允许短暂重启。”
- “读取最近一次维护结果；如果失败，说明是否恢复成功。”

自然语言请求由 Agent 转为下面的维护命令；现在也可以直接使用所有者专属的 `/ops help`、`/ops status`、`/ops tasks`、`/ops stop`、`/ops result`。维护完成后会尝试主动通知 QQ，投递失败可查询落盘结果。全部功能开关、数据位置、更新和停用方法见 [功能管理手册](FEATURES.md)。子 Agent 扩权由本体拒绝，额外权限必须交回主 Agent，通过 QQ 的单次允许/拒绝按钮处理。

## 维护命令

在安装目录运行，或使用脚本绝对路径：

```powershell
powershell.exe -NoProfile -File .\maintenance\manage.ps1 -Action Status
powershell.exe -NoProfile -File .\maintenance\manage.ps1 -Action Doctor
powershell.exe -NoProfile -File .\maintenance\manage.ps1 -Action Result
powershell.exe -NoProfile -File .\maintenance\manage.ps1 -Action CheckUpdates
powershell.exe -NoProfile -File .\maintenance\manage.ps1 -Action Backup -Queue
powershell.exe -NoProfile -File .\maintenance\manage.ps1 -Action Stage -Queue
powershell.exe -NoProfile -File .\maintenance\manage.ps1 -Action DeployValidated -Queue
powershell.exe -NoProfile -File .\maintenance\manage.ps1 -Action Restart -Queue
powershell.exe -NoProfile -File .\maintenance\manage.ps1 -Action Restore -BackupId <备份目录名> -Queue
node .\maintenance\ops.cjs verify
node .\maintenance\ops.cjs health
```

QQ Agent 必须队列执行 Backup、Stage、部署、重启和恢复；用户在本机外部终端可以不加 `-Queue`。Backup 需要空闲，在 QQ 提交后台备份后应结束当前回复；日常升级也会自动备份。

Stage 按 `plugin-policy.json` 的已审查版本建立 `qqbot-validation` 候选 profile，保留显式自定义参数，禁用依赖安装脚本，验证配置、补丁、审批、提问和文件发送边界。它不会启动第二个 QQ 连接，也不会自动应用发现的 latest 版本。需要更新到其他版本时，先检查来源和变更，再修改目标版本并重新 Stage。

Doctor 检查固定版本、配置、补丁、本机接口和 Creator 预设。Status 分开报告 `coreVersion`（本体）与 `marketVersion`（插件市场），避免把市场版本误认为本体版本。Result 读取最近一次持锁维护结果；每次任务仍有独立日志。它们不能代替实际 QQ 按钮点击测试。

DeployValidated 校验候选文件、当前 profile 和本体哈希；若准备期间配置发生改变，就拒绝应用，要求重新 Stage。后台进程等待所有 Agent 与插件安装空闲，备份 profile，停止本安装目录下的宿主，按锁文件离线安装，启动并检查本机状态接口及 QQ ready。失败时恢复旧 profile 并再次启动。未知状态或 3 分钟内不能空闲时不执行切换。

结果：`data/maintenance/latest-result.json`；各次结果与日志：`data/maintenance/jobs/`；完整 profile 备份：`data/maintenance/backups/`。备份包含 QQ 凭据，只留本机，不上传或发到群。自动回滚覆盖 profile，不能回滚官方本体安装器或工作项目修改。

新备份附带整个 profile 的 SHA-256 清单，Restore 在停止宿主前验证，回滚时再次验证。缺失、损坏或未带完整性清单的旧备份不会自动恢复；旧备份仍保留，可人工审查后迁移。备份内的 AGENTS.md 用于留档，恢复操作只切换 profile，不覆盖维护期间更新的工作约定。

## 插件与补丁

| 组件 | 已审查目标 | 管理方式 |
| --- | --- | --- |
| QQ Bot | 0.5.2 | npm 固定版本 + pnpm 正式补丁 |
| 免费搜索 | 0.8.9 | npm 固定版本 |
| 插件市场 | 1.66.18 | npm 固定版本；保留本机应急 UI |
| Bilibili | 0.2.4 | 保留现有本地 tgz 来源，不自动换成同名远程包 |
| 私人运维 | dsh-remote-ops-local 1.1.0；保留 1.0.0 恢复包 | 独立源码、本地 tgz、哈希固定；与 QQ 桥接补丁一起验证 |
| 项目记忆 | dsh-task-memory-local 0.1.0-local.2 | 固定上游提交的本地适配包，仅当前核心版本通过验收 |
| 浏览器 | @playwright/mcp 0.0.83 | 版本独立目录、锁文件、通过核心 MCP 桥接 |
| 本体 | 0.2.0-rc.2 | 官方桌面更新器，更新前备份、更新后复验 |

QQ 0.5.2 的上游审批代码仍读取旧的 `session.events`，本体当前使用 `seq/eventAt`。Iteration 06 起审批与提问不再使用上游的 `ApprovalChannel`/`QuestionChannel`（补丁不再修改它们，Gateway 也不引用），改由 Agent I/O 的 HITL Bridge 处理：随机请求引用、预期作答者匹配（群聊取点击成员）、超时、取消、Session 释放与卸载清理均在 Bridge 内，并经原生 waterfall 接入、经 `sendMessage()` 展示。补丁仍修复空白名单放行、目录链接越界发送与显式收件人绕过访问配置等情况。

维护源码在 `maintenance/qqbot-src`，对应上游原文件及 SHA-256 清单在 `maintenance/qqbot-upstream-0.5.2`。编辑维护源码后运行 `node maintenance/build-qqbot-patch.cjs` 生成 `maintenance/patches/dsh-qqbot@0.5.2.patch`（清单 `added` 列出上游没有、由补丁新增的文件，如 QQ Official 文本 Adapter；`node maintenance/audit/verify-patches.cjs` 在新上游副本上应用并逐文件比对）；Stage 会用 `--check` 核对可重建性。profile 的 `patchedDependencies` 和锁文件负责自动重装。旧 `qqbot-approval` 目录仅为首版兼容修复参考，不再作为新补丁来源。

升级 QQ 时不能只改包版本：检查新版是否已经合入修复，更新或删除补丁，并重跑 `node --test maintenance/hitl.test.mjs maintenance/qq-boundaries.test.mjs maintenance/maintenance.test.cjs`（默认针对候选 profile，实际部署复测设置环境变量 `QQBOT_TEST_PROFILE`）。脚本对未经审查的 QQ 版本直接报错，避免静默丢补丁。`autoInstallPeers: false` 保持由桌面本体提供核心组件，不在 profile 装第二份核心。现有 `plugin-sources/dsh-qqbot-0.5.0` 仅作为历史源码参考。

## 权限管理

```powershell
node .\maintenance\ops.cjs access list
node .\maintenance\ops.cjs access add c2c <用户openid>
node .\maintenance\ops.cjs access remove c2c <用户openid>
node .\maintenance\ops.cjs access add group <群openid>
node .\maintenance\ops.cjs access remove group <群openid>
```

权限修改先保存原配置到 `data/maintenance/access-backups/`。不允许删除最后一个私人管理员。新增群会开启群白名单，删除最后一个群后关闭群聊。现有 QQ 插件是入口白名单，不是管理员/访客分级系统；加入同一实例的成员具有相同 Agent 能力。多用户只读访客应另建受限部署后再开放，不能靠提示词冒充权限隔离。

权限修改与维护共用 Windows 文件互斥锁，避免部署覆盖同时发生的权限变更；并发权限编辑还有独立 `access.lock`。如进程被强制结束而留下该文件，先检查其中 PID 是否仍在运行，确认没有权限编辑进程后才可移除，不要在失败时绕过锁直接写配置。

## 本体更新与长期运行

本体保留官方桌面更新通道，不改 `app.asar`。自定义文件放在 `data`、`default-workspace`、`plugin-sources`、`plugin-packages`、`maintenance`，更新前应保留这些目录；跨安装目录迁移需要修正原配置中的绝对路径。官方本体升级后，先运行 `ops.cjs verify`，再 Stage；需要检查真实 QQ 收发、审批和多 Agent。`runtimeReviewRequired: true` 表示版本超出当前验证范围，不能视为已完成兼容认证。

远程操作依赖这台 Windows 主机在线。已注册当前用户登录后启动的 `DeepSeekHarness-QQ-Watchdog` 计划任务，使用 `maintenance/autostart.ps1` 管理；它检查宿主缺失和 QQ 永久断线，遵守维护锁、空闲门槛和重启次数限制。没有改变休眠或断电恢复设置；无人登录时不会启动桌面宿主。功能详情见 FEATURES.md。

### 运行目录选择

官方更新迁移安装目录时，配置 `data/maintenance/host-runtime.json`（schemaVersion 1、绝对 runtimeRoot），保持原数据目录。`runtime.cjs` 为启动、重启、守护和只读 ASAR 检查提供同一目标；`stage.cjs` 同时校验选定目录与 ASAR 哈希，改目录必须重新 Stage。旧布局未配置时维持原行为，不猜测用户目录。仅在空闲、备份、兼容验证和旧进程退出后切换；不改官方文件。
