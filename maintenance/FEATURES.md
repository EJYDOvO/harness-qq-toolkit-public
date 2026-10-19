# 功能管理手册

本文描述原 Windows 维护后端的功能、路径与开关，不是所有 QQTK 项目的默认配置。Remote Ops 1.1 独立模式使用显式 ownerId/stateDirectory，服务后端的能力由 qqMaintenance 实现，见 [插件说明](../plugin-sources/dsh-remote-ops/README.md)。下文 memory 指旧项目记忆，不是 Character 的分层 Memory Core。

原后端中入口权限名单与运维所有者分别保存；只有 `data/maintenance/owner.json` 指定的私人 QQ 可用 `/ops`，群聊不能运维。这只限制快捷入口，不是多个用户之间完整的文件/模型权限隔离。

## 日常操作

| 功能 | QQ 管理方式 | 本机管理与数据 |
|---|---|---|
| 运维命令 | `/ops help`、`status`、`tasks`、`stop`、`result` | `node maintenance/remote.cjs tasks` / `stop` / `jobs` |
| 备份与升级 | `/ops backup`、`stage`、`deploy`、`restart` | 原 `manage.ps1` 流程；恢复仍要求明确 BackupId |
| 功能开关 | `/ops features`；`/ops feature 名称 on` 或 `off` | `maintenance/features.json`；名称为 remoteOps、notifications、watchdog、memory、browser |
| 应用记忆/浏览器开关 | `/ops apply` | `manage.ps1 -Action ApplyFeatures -Queue`；等待空闲、备份、重启，失败回滚 |
| 维护结果通知 | `/ops notifications`、`/ops result` | `data/maintenance/qq-notifications.json`；开关 notifications 即时生效 |
| 登录守护 | `/ops feature watchdog on/off` | `autostart.ps1 -Action Enable/Disable/Status/Start`；任务名 DeepSeekHarness-QQ-Watchdog |
| 项目记忆 | 自然语言要求绑定项目、记住、检索、删除 | `memory_bind_task/current_task/remember/recall/search/forget/list_tasks/clear_task`；数据在 `data/storages/task-memory` |
| 浏览器 | 让 Agent 调用 `mcp__browser__*` | 固定运行时 `maintenance/browser/0.0.83`；配置 config.json；登录资料 `data/browser-profile`；输出 `default-workspace/browser-output` |
| 定时任务 | 自然语言明确安排提醒，然后查询/修改/删除 | 使用内置 `schedule_create/list/update/delete`，不安装第二个调度器 |
| 备份保留 | 当前不自动删除 | `node maintenance/retention.cjs` 预览；明确清理后加 `--apply` |
| 源码版本 | 维护完成后本地 checkpoint | `powershell -File maintenance/checkpoint.ps1 -Message "说明"`，各源码目录独立 Git；不上传 |

`/ops stop` 只停止当前所有者 QQ 会话及其活跃持续型子 Agent，不停止其他桌面会话。运维入口关闭后，所有者仍能通过 `/ops feature remoteOps on` 恢复。

维护任务持锁期间不能同时修改权限或功能开关，遇到占用错误需等任务结束再试。开关写入还使用 features.lock 串行化；异常退出若留下该文件，先检查其中 PID，确认原进程不存在后再清除。memory/browser 的开关代表期望配置，执行 apply 成功后才是实际状态；失败自动回滚时以 `/ops result` 和宿主插件状态为准。

## 守护与任务边界

守护在当前 Windows 用户登录后运行，不是无人登录也能启动桌面应用的系统服务。每 30 秒检查本安装进程，连续缺失 90 秒后启动；每小时最多自动启动/重启 3 次。QQ SDK 自行处理普通断线重连；明确的永久断线持续一分钟后，守护仅在 Agent 空闲时排队重启。维护锁被持有时停止干预。关闭 Harness 前先关闭 watchdog，否则它会把退出视为需要恢复。

长任务运行 2 分钟提示一次；5 分钟无新事件提示停滞；单回合 30 分钟时尝试停止当前 QQ 任务树。提醒阈值在 features.json。审批和待答问题同样占用回合时间；正常长任务可在执行前调整上限。

通知只发给固定所有者，投递记录先落盘再发送。`sent` 表示发送 API 成功，`failed` 表示失败，`sending` 在异常退出后表示结果不确定，`suppressed` 表示关闭通知时抑制。失败/不确定记录不会自动重复发送，可用 result 查结果。QQ 平台拒收或限额时不能保证手机收到。

插件启动时恢复当前所有者的持久化 QQ 会话，以便原生定时任务在重启后有回传路由。`/new` 不会迁移旧会话提醒；迁移需按用户要求删除并重建。当前没有安排日常巡检或无限循环任务。

## 安装来源和更新

- `dsh-remote-ops-local@1.0.0`：本地独立插件，无第三方运行依赖；源码 `plugin-sources/dsh-remote-ops`。QQ 的正式补丁声明运维服务依赖，确保先加载运维服务；功能逻辑不放进上游 QQ 文件。停用功能用 remoteOps 开关保留服务。彻底卸载运维插件时须同时移除 QQ 的服务声明和桥接补丁，经测试后一起部署，不能单独删除运维包。
- `dsh-task-memory-local@0.1.0-local.2`：来自 `wangyihao0001-oss/dsh-task-memory` 提交 `96e6552a26b11b6430e48cbd37755bb40f1a13dc`。上游 0.1.0 被兼容性检查拒绝；本地包独立命名，仅声明当前本体 0.2.0-rc.2，保留 MIT 许可。本地修复 recall/search 只返回摘要、模型看不到正文的问题；保留存储逻辑，禁用自动提示注入，使用明确的读写工具。更换本体版本必须重新验收，不添加兼容性豁免。
- `@playwright/mcp@0.0.83`：npm 官方来源与完整性摘要已检查；依赖固定、安装脚本关闭。运行时按版本存放；新版本应另建目录测试，再切换 MCP 配置中的路径，保留旧目录供回滚。不要在现有版本目录直接执行 update。

本地归档的来源、版本、SHA-256 在 plugin-policy.json；浏览器来源记录在 reviews。Stage 校验固定包、8 份 QQ 补丁源码、维护策略和功能开关；本体跳过不兼容插件也会判失败。浏览器锁文件和配置纳入候选摘要。修改插件源码后应升本地版本、生成新 tgz、更新策略哈希，再 Stage → 验收 → DeployValidated。

停用 memory/browser 不删除包和数据，以便可靠恢复。彻底卸载时先关闭功能并 ApplyFeatures，再从策略和 profile 中移除相应 bundle/依赖，重新 Stage/Deploy；数据仅在用户明确要求时删除。

## 备份、清理与恢复

每次部署、应用开关及恢复前，备份完整 profile，并保存当时的记忆 vault 快照和完整性摘要。常规 Restore 只恢复 profile，不覆盖部署后新增的记忆；需要恢复记忆时，先停用记忆并备份现有目录，再从指定备份的 feature-data/task-memory 恢复。浏览器登录资料不随 profile 回滚，也不发送到 QQ。

默认保留至少最新 5 份备份，只有超过 14 天的更旧备份才进入清理预览；没有自动删除。清理操作校验真实目录边界和完整性，旧的无摘要备份需要人工处理。工作项目不是 profile 备份的一部分；每个项目应单独建 Git，当前 default-workspace 仅跟踪工作约定。

管理源码和配置使用本机 Git；凭据、运行数据、浏览器登录资料、node_modules 不入库。回退某功能源码后必须重新打包、更新策略并走候选部署，单纯 git checkout 不会改变正在运行的插件。
