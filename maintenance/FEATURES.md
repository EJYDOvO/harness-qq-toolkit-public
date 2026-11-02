# 功能配置

| 能力 | 所有者 | 配置方式 |
|---|---|---|
| QQ 私聊入口、Typing、媒体协议 | QQ Adapter | Profile 的 im-qqbot；唯一 Owner 白名单，群聊禁用 |
| Session 路由/轮换 | Conversation Manager | 显式 stateFile；保留现有 ID/偏好 |
| I/O/HITL/Notification | Agent I/O | 对应公开服务开关；缺失时不走旧 Sender |
| Remote Ops | 独立插件 | Owner/stateDirectory；维护后端可选 |
| Memory/Interaction/Inspector/Long Tasks | Character 或独立插件 | 见各包接口，非 QQTK 隐含前提 |

portable config 的 remoteOps.enabled 默认 false。可选模块先安装再声明；配置声明不是插件安装器。新安装不预装 Task Memory、Browser 或其他市场插件。

features.json / plugin-policy.json 仅是旧 Windows 维护后端的源码模板，不代表某台实例当前开关。修改后必须离线重新 Stage 与验证，不能直接覆盖运行中的私人配置。已有实例升级时保留本机 features.json、plugin-policy.json 与 browser/ 运行包；模板中 memory/browser 为 false 只是新安装默认值，不是对现有实例的关闭指令。未知通知状态不清空、不盲目重试。参见 [恢复](../docs/RESTORE.md)。
