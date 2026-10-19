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

发送前持久记录 sending；未知结果不盲目重放，sent 只代表 API 成功。Character Adapter 可提供 notifyEvent 送入其 outbox；普通项目直接使用同一 Gateway 的 Sender。

更新前备份配置、状态和旧安装包，固定依赖及补丁哈希，独立 Profile 验证后单活切换。基础 QQ 审批/问答不经过本插件。启动仅恢复 Owner Session，不自动执行模型请求；/new 不迁移旧提醒，应先管理原提醒。
