# QQTK 通用安装与依赖（2026-10-19）

QQTK 继续是独立插件与维护组件集合，不迁入 Character 仓库、不合并单体。Character 通过固定版本的 QQTK 接口和补丁使用它。

## 依赖变化

| 功能 | 旧前提 | 当前前提 |
|---|---|---|
| QQ 接入/Session/Sender/审批/问答 | 基础 QQ 强依赖 qqRemoteOps | DSH Agent/原生 Preset + 已审查 QQ 0.5.2 补丁 |
| `/ops` | 安装目录中私人维护脚本 | 独立插件，显式 Owner/stateDirectory；可选 qqMaintenance 服务 |
| 旧 Windows 部署/恢复/守护 | 固定部署约定 | 保留在显式 root 后端，未改成跨平台工具 |
| Character QQ | QQTK + Character 集成 | 不变；通用 QQ 不加载 Character |
| QQ 会话偏好 | 所有 Profile 使用用户目录 | 有 DSH_HOME 时使用 DSH_HOME/qqbot；无配置保留旧路径 |

普通项目只需安装 `@tencent-connect/dsh-qqbot@0.5.2`，不需要本仓库 Remote Ops、本仓库旧项目记忆，或任何 Character 包。

Profile 保留原生 base/web-app Bundle，`autoInstallPeers: false`，不要重复安装本体的服务包。将 `maintenance/patches/dsh-qqbot@0.5.2.patch` 放到 Profile 的 patches，配置：

```yaml
# pnpm-workspace.yaml
packages: [ . ]
nodeLinker: hoisted
autoInstallPeers: false
patchedDependencies:
  '@tencent-connect/dsh-qqbot@0.5.2': patches/dsh-qqbot@0.5.2.patch
```

```yaml
# cordis.patch.yml；占位符必须换成本机安全配置
- insert:
    - id: ordinary-qq
      name: '@tencent-connect/dsh-qqbot'
      config:
        appId: '<LOCAL_APP_ID>'
        appSecret: '<LOCAL_APP_SECRET>'
        preset: cordis
        cwd: '<ABSOLUTE_PROJECT>'
        access:
          c2cMode: allowlist
          c2cAllow: ['<LOCAL_OWNER_OPENID>']
          groupMode: disabled
          groupAllow: []
```

包管理器正常安装并应用补丁；不手改 DSH app.asar 或安装后的 node_modules 文件。每个项目设置独立的绝对 DSH_HOME。不要同时启用 QQ 官方 Bundle 和另一个手动 QQ 条目。

需要 `/ops` 时，另行安装 `plugin-packages/dsh-remote-ops-local-1.1.0.tgz`（或审查源码后 pack）。按 [独立模式与维护后端](../plugin-sources/dsh-remote-ops/README.md) 在 QQ 前加载。没有维护后端时基本任务观察可用，部署/重启等明确拒绝；不会猜测其他安装目录。

## 单例、权限与生命周期

- 基础 QQ 的注入声明只依赖 agents，未安装 Remote Ops 时审批/问答仍注册。
- 进程共享 appId 租约拒绝重复 Gateway，卸载等待停止后释放；只构造一套 Sender、问答与审批通道。
- 多进程使用同一凭据需外部单活管理；本机维护锁不能代表跨机器分布式锁。
- 无效 Preset 不再退回其他 Agent 组合；已有 Session 继续按其原 Preset 恢复，缺失时拒绝。
- Remote Ops 安装/卸载后重载 QQ 或重启 Profile。热插拔能力发现未实现。
- QQ 白名单、审批 nonce、Owner 校验、取消/超时、路径边界修复保留。只验收单 Owner 私聊；未开放群聊或主动闲聊。

## 实际验证

在已安装 DSH 0.2.0-rc.2 上，以单独 DSH_HOME/Profile、仅 QQ 一个第三方依赖启动真实 QQ SDK；无 Character/Remote Ops 服务。已通过连接、普通 Creator Preset、Session 创建/恢复、缺失 Preset 拒绝及单 Gateway 检查。

15 项自动回归通过：审批4、访问/问答/文件边界6、Remote Ops及偏好隔离5。按钮 nonce/拒绝/允许属于自动交互测试；本轮没有用户手机点击验收，不能算手机投递已验证。

完整 Character test.7 使用 Remote Ops 1.1.0：Core-only、Core+Extras 各启动一次且各只有一个 QQ ready；实际恢复 test.6 后再部署 test.7 成功。Windows 以外宿主兼容性未验证，不能据此宣称两台 Mac 已可直接迁移。

## 更新维护

维护源码包含 QQ Bot 15 文件和 SDK 3 文件的审查快照（含未改动的 IdleEvictor 供回归验证）；原文件哈希分别在 qqbot-upstream-0.5.2/manifest.json 和 sdk-upstream-1.0.5/manifest.json。修改后分别构建并检查两份补丁（SDK 使用 `--sdk`），安装示例见 [审计修复说明](INTERACTION-AUDIT-FIXES.md)。升级上游版本时重新比对，不能跨版本盲目应用。

原 templates/profile 是旧安装快照；新项目优先使用本文件的最小装配，不直接复制旧绝对路径/可选插件清单。更新配置与状态目录时先备份；不要删除通知账本来“重试”不确定投递。
# Interaction 可选接入

开发候选可对接 Agent 层 Interaction 服务，详见 [接口与验证边界](INTERACTION.md)。QQ 基础接入仍不依赖它，不增加 Gateway、数据库或额外模型。安装包、在 Preset 中声明并隔离服务、应用 QQ 补丁和部署是不同步骤；部署状态见 README；是否实际启用由各实例配置决定。

## 可选主 Session 生命周期

基于 DSH 0.2.1-rc.2 / QQ Bot 0.5.2 配套补丁，在 QQ 配置中显式启用：

```yaml
sessionLifecycle:
  enabled: true                  # 默认 false，保持旧路由/恢复行为
  freshOnHostRestart: true        # 真实 Host 进程重启；HMR 不算重启
  inactivityMs: 43200000          # 距上次可信用户入站 12 小时
```

只对 c2c 生效。用户消息通过访问/mention 校验后记录活动，包括命令与问答输入；模型回复、Schedule、后台任务和 Agent 状态不延长用户活动时间。Remote Ops 启动预热等不带 QQ messageId 的恢复调用不更新用户计时，也不触发或消费待执行轮换。下一次实际用户输入取得聊天 Agent 时，创建无 parent/seed 的新根 Session，保留模型/目标 Preset 偏好；不 Fork、复制或删除旧历史。换新 Session 与 Agent 内存空闲回收分开：回收后仍可恢复同一 Session。

运行中的 Agent、待处理 Inbox、待审批/问答、持久未完成轮次均会延后轮换，下一次安全交互重试，不自动 cancel。记录在 `getStatus().lifecycle` 中包含 lastUserAt、pendingReason、blockedBy、generation。并发 get、手动重置/模型切换/压缩采用每 Conversation 串行边界；路由和生命周期使用同一个偏好文件原子提交，失败不发布新路由。异常或外部更改的偏好文件拒绝覆盖；仍要求单活 Host，不提供跨机器锁。

已有原生 Schedule 仍绑定旧 Session，**不迁移提醒**。通用 QQ 没有可信旧根桥接时，轮换因 `existing_schedule` 延后，避免丢提醒。Character Identity 提供 Host-only `manager.preserveScheduledSession(oldId)`，只接受已持久绑定的 Owner/项目/角色旧根，经原 Outbox 通知稳定 Conversation，不能改写当前主路由。历史部署 test.13 冷恢复曾重授完整身份；test.14 改为仅提醒绑定，拒绝历史根的模型、工具、Memory 与长期任务创建。其他项目若需要相同行为，须提供自己经过审查的桥接；不要简单返回 true。

当前补丁的 `manager.isCurrentSession(record)` 检查真实 record 对象、manager 路由与 Agent 注册表；集成层必须在异步 admission 后重查，不能凭 Session ID/QQ 身份参数授权。QQTK 不决定具体 Identity 策略，普通 Agent 无须安装 Character。当前 rc.2 切模型使用原生 `snapshotEvents/buildForkSeed` 构建精确前缀，避免旧 `.events` API 和额外的临时活跃 fork；新根持久化成功后通过 `PrefsStore.commitSession` 一次提交模型偏好及路由。磁盘写入/外部修改/关闭失败时撤销候选，不发布新路由。自动空白轮换仍不 Fork。

生命周期状态仍在 `$DSH_HOME/qqbot/model-prefs.json`；无 DSH_HOME 保留旧路径，不自动迁移。备份需同时保留偏好、原生 Session/Schedule，以及集成方身份/通知状态。停用开关保留已有最新路由，不重置历史或数据库。宿主崩溃后未完成的副作用无法自动证明结束，可能保持延后，需显式处理原任务，不能删除记录强迫轮换。

验证：`node --test maintenance/session-lifecycle.test.mjs`；配套 Character `scripts/run-lifecycle.ps1` 在两个真实 rc.2 Host 进程中验证空白根、Memory 连续性、停机逾期、原提醒冷恢复和独立任务。模型/Sender 为合成替身，不启动 QQBot、不证明实机收件；已随 Character test.14 在 Windows 实例部署，保留 test.13 生命周期配置；真实 QQ 收件与手机审批仍待验收。

## DSH 0.2.1-rc.3

已在安装目录与数据目录分离的实际 rc.3 中验证 QQ 适配、Interaction、Session 生命周期及提醒/任务恢复，QQ Bot/SDK 版本及两份补丁未变。通用 QQ 仍不依赖 Character。自有 Windows 维护入口增加可信宿主目录选择；这是维护脚本能力，不是 QQ 运行插件的依赖。测试使用合成模型和 Sender，没有手机收件证明。
