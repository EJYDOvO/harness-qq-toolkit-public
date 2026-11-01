# Remote Ops 1.1

独立的 DSH Host 插件，不依赖 Character Identity 或角色 Preset。基础 QQ Gateway 不要求安装本插件。本包自带 Bundle 默认禁用，必须先配置所有者与持久状态目录。

## 独立模式

```yaml
- insert:
    - id: qq-remote-ops
      name: dsh-remote-ops-local
      config:
        ownerId: '<PRIVATE_OWNER_OPENID>'
        stateDirectory: '<ABSOLUTE_PROJECT_DATA>/remote-ops'
    # 此后加载同一套已打版本化补丁的 QQ 插件
```

在 QQ Gateway 之前加载本插件。QQ 私聊白名单必须包含这个 Owner；当前验收配置只允许一位 Owner，关闭群聊。

独立模式提供所有者 `/ops` 命令、当前 QQ 主会话状态/停止、长任务观察和持久通知去重，不需要 Windows 脚本或安装根目录。`backup/stage/deploy/restart/apply` 必须有维护后端，否则明确报错。独立 stop 只取消 Owner 主会话；子 Agent 树停止由项目维护后端实现。帮助文本沿用兼容命令集，不代表所有后端都实现全部能力。

## 自定义可信 Host 后端

在本插件之前提供 `qqMaintenance` 服务，配置 `backend: service`。服务缺失时启动失败，不退回其他维护后端。接口：

| 方法 | 结果/约定 |
|---|---|
| `features()` | 同步返回 remoteOps 的 enabled/notifyAfterSeconds/staleAfterSeconds/maxTurnSeconds，及 notifications.enabled |
| `setFeature(name, enabled)` | 同步返回修改结果，可含 requiresApply |
| `tasks()` | 可异步，返回可公开给 Owner 的任务摘要 |
| `stop()` | 可异步，按本项目权限取消任务，不能停止其他项目 |
| `jobs()` | 同步返回维护结果摘要，不含凭据 |
| `queue(action)` | 可异步，接收 Backup/Stage/DeployValidated/Restart/ApplyFeatures；后端负责维护锁、空闲检查、备份、切换和恢复 |

stateDirectory/jobs 下的 result.json 可接入现有维护通知（action/ok/rolledBack/finishedAt）。后端是可信代码，不向模型暴露任意维护执行接口。

## 兼容旧部署

显式 `config.root` 启用旧安装后端：加载根目录下的 maintenance/remote.cjs、data/maintenance/owner.json 和旧账本，保留 Windows 维护与子 Agent 停止行为。通用插件不再默认寻找固定磁盘路径；旧 PowerShell 工具仍是平台专用后端，未宣称支持 macOS。

## 生命周期与管理

`qqRemoteOps.attach(runtime)` 返回 detach，拒绝同时绑定两个 Gateway。运行中添加/删除插件后应重载 QQ Gateway 或重启 Profile。`/ops feature remoteOps off` 关闭监控；`/ops feature notifications off` 关闭通知。停用不删除账本。

每个事件只有一个发送方：与 Character 集成时（`notifyEvent`）只由 Character 的持久 Outbox 发送，账本只记事件键与 Outbox 返回的状态；独立运行时经 Gateway 交来的 Agent I/O 通知器（`runtime.notifications`）发送，目标为固定的所有者私聊，并在发送前复核仍是本次附加与所有者。两者都没有时不发送（`not-sent`，`notifications-unavailable`），不再直接调用 Gateway Sender。发送前先持久记录 `sending`（写入失败则不发送）；进程中断留下的 `sending` 永不重放。状态：`sent`（只代表平台 API 接受）、`not-sent`、`partial`、`unknown`（不重发）、`pending`（Character Outbox 仍在投递）、`suppressed`；旧账本中的 `failed` 是此前版本对任何错误的记录，保留不改。

写入使用候选快照，只有成功落盘才更新内存；首次写入失败不会留下虚假的 sending。持久化异常后先重读账本，读不到则拒绝继续；已出现的 sending/unknown/partial 不会因故障恢复而删除或重发。HMR 仅当前实例可写 JSON；旧实例的迟到结果不覆盖新快照，其发送前授权也失效。终态写入失败保留磁盘上的 sending 屏障，后续 Tick/重启不重试。异步任务结束通知的存储异常明确告警，不成为未处理拒绝。

这是 at-most-once handoff，结果未知需要人工核对；QQ API 接受不等于手机收到。当前单进程 HMR 防护不替代多进程锁，部署仍须单活。与 Character 集成时 SQLite Outbox 是发送权威，JSON 只记委派结果；缺少提醒来源的旧 Outbox 行继续暂缓，不以 JSON 记录补发。

首次从未包含上述保护的旧版升级、或回滚到旧版时，必须停止旧 Host 并确认进程退出后切换。新代码的所有权标记无法阻止仍在执行的旧版闭包写回；不支持这样的跨版本热切换。API、事件键和历史状态不迁移，旧 sending/unknown 等记录继续保持禁止重放。

更新前备份配置、状态和旧安装包，固定依赖及补丁哈希，独立 Profile 验证后单活切换。基础 QQ 审批/问答不经过本插件。启动仅恢复 Owner Session，不自动执行模型请求；/new 不迁移旧提醒，应先管理原提醒。
## Interaction 兼容

Iteration 07 部署版本 `1.1.1-test.2`（Iteration 07：通知只经 Agent I/O 通知器或 Character Outbox），2026-11-01 已配套 Character test.26 / Agent I/O test.7 授权部署，启动与既有账本保留检查通过；真实 QQ 通知仍待验收。`1.1.1-test.1` 曾配套 Character test.10 部署。目标 Agent 存在可选 Interaction 服务时让出普通等待提示，保留维护、超时、故障与任务完成通知；原生流式帧更新活动时间。旧 `1.1.0` 恢复包未被覆盖。详见 [适配说明](../../docs/INTERACTION.md)。
## Iteration 08（1.1.1-test.3，2026-11-02 已授权部署）

复审：单独卸载立即撤销旧 `/ops` 授权并释放 Bot 监听器；新实例不复活旧命令。Remote Ops 单独重装不会自动挂接到存活 Gateway，必须重载 QQ Gateway 才能恢复命令/通知器；在途后端操作不保证取消。命令超过输入回复 300 秒授权时可能完成但 `replied:false`，通过 `/ops result` 或既有授权通知查询，不能靠重发同一消息重跑。

通知与持久写入规则不变。Gateway 可选传入 `diagnostics`，Remote Ops 只记录脱敏事件关系与交接状态；观察异常不能改变 Ledger 或发送。与 Character 组合时不再拦截 `attach`，Gateway 使用显式 Host 集成参数取得 Character 的 `notifyEvent`；SQLite Outbox 仍是唯一发送者。test.2 为历史部署记录，实机投递仍待验收。
