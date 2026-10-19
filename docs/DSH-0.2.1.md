# DSH 0.2.1-rc.2 兼容说明

2026-10-19，本机升级使用官方签名安装包，QQ Bot 保持 0.5.2 及既有审批兼容补丁，Remote Ops 保持 1.1.0。本次不修改 QQ SDK 或官方 DSH 文件。

维护后端有两处适配：

- `configureFeatures` 仅在 Profile 实际装配 `dsh-task-memory-local` 时写入其覆盖项。Character 已接管长期记忆时，不重新启用旧项目记忆。
- 健康检查不再因为安装了 Remote Ops 就强制要求存在旧项目记忆插件；只核查实际装配的组件。QQ、Remote Ops 和 Browser 的检查继续保留。

旧项目记忆包锁定 DSH 0.2.0-rc.2，不能把“包仍在依赖中”视作新版本兼容。当前 Character 实例原已停用它，升级移除其 Bundle 与失效覆盖项，旧数据和包保留。其他仍使用旧项目记忆的项目需单独适配，不能套用本次停用迁移。

新版 Schedule 为宿主内置能力，应移除旧实验 Bundle 的重复选择；具体工具由 Preset 提供。Character 的 Creator 配置需重新派生，不能只替换宿主。

18 项 QQ/审批/维护回归通过，真实新版 Character 宿主的提醒到期与账本测试使用合成身份和替身 Sender。生产 QQ ready、插件 active 和本次服务进程健康需要另行检查；这些都不证明手机收件或真实按钮点击。

本机生产升级已通过新启动健康与 QQ ready 检查。另用实际 QQ SessionManager 在隔离新版宿主验证创建/恢复：Session ID、历史消息、Character Preset 和 Host 绑定保持，未知 Preset/非 Owner 拒绝。该附加探针没有建立 QQ 网络连接，不能代替完整手机验收。

桌面启动 PID 和后台服务 PID 不一定相同。升级门禁应验证服务 PID 属于本次桌面进程树、启动时间不早于本次启动，并检查本次日志的 QQ ready。避免仅凭旧日志或 PID 相等条件判定成功/失败。

跨版本回滚需保留完整官方运行时、Profile、Session、任务存储、QQ 状态和应用数据的离线快照。通用 QQTK 的 Profile Restore 不等于完整宿主降级；不要只恢复 Profile 后运行不匹配的 DSH。
