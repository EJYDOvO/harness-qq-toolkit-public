# QQTK 通用安装与依赖

当前源码为 Manager test.2，修复恢复错误分类和关闭生命周期；抽离基线 test.1 已随 Character test.21 授权部署，新版部署见仓库根 README。普通 QQ 新装、NapCat 与手机验收仍待独立完成；历史版本记录不证明这些组合。路由接口、安装与恢复前置见 [独立插件说明](../plugin-sources/dsh-conversation-manager/README.md)。

QQTK 继续是独立插件与维护组件集合，不迁入 Character 仓库、不合并单体。Character 通过固定版本的 QQTK 接口和补丁使用它。

## 依赖变化

| 功能 | 旧前提 | 当前前提 |
|---|---|---|
| QQ 接入/Session/Sender/审批/问答 | 基础 QQ 强依赖 qqRemoteOps | 原生 Agent/Preset + Conversation Manager + Agent I/O + QQ 0.5.2 配套补丁 |
| `/ops` | 安装目录中私人维护脚本 | 独立插件，显式 Owner/stateDirectory；可选 qqMaintenance 服务 |
| 旧 Windows 部署/恢复/守护 | 固定部署约定 | 保留在显式 root 后端，未改成跨平台工具 |
| Character QQ | QQTK + Character 集成 | 不变；通用 QQ 不加载 Character |
| 会话偏好 | QQ 私有路径推导 | Manager 显式绝对 stateFile；默认项目隔离 |

普通项目安装 QQ Bot、独立 `dsh-agent-io` 和 `dsh-conversation-manager`，不需要 Remote Ops、旧项目记忆或任何 Character 包。Agent I/O 的接口与语义见 [独立插件说明](../plugin-sources/dsh-agent-io/README.md)；Iteration 06 的 QQ 补丁要求 `dsh-agent-io@0.1.0-test.6` 或更新（`openCommands()`、附件与 `openHITL()`），旧包会让 Gateway 启动即报错。两份补丁须配套：

Profile 保留原生 base/web-app Bundle，`autoInstallPeers: false`，不要重复安装本体的服务包。将 `maintenance/patches/dsh-qqbot@0.5.2.patch` 放到 Profile 的 patches，配置：

```yaml
# pnpm-workspace.yaml
packages: [ . ]
nodeLinker: hoisted
autoInstallPeers: false
patchedDependencies:
  '@tencent-connect/dsh-qqbot@0.5.2': patches/dsh-qqbot@0.5.2.patch
  '@tencent-connect/qqbot-nodejs@1.0.5': patches/qqbot-nodejs@1.0.5.patch
overrides:
  '@tencent-connect/qqbot-nodejs': 1.0.5
```

```yaml
# cordis.patch.yml；占位符必须换成本机安全配置
- insert:
    - id: agent-io
      name: dsh-agent-io
      config: {}
    - id: conversation-manager
      name: dsh-conversation-manager
      config:
        stateFile: '<ABSOLUTE_PROJECT_DATA>/conversations.json'
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

需要 `/ops` 时，另行安装 已审查并固定哈希的 `dsh-remote-ops-local` 包（或审查源码后 pack）。按 [独立模式与维护后端](../plugin-sources/dsh-remote-ops/README.md) 在 QQ 前加载。没有维护后端时基本任务观察可用，部署/重启等明确拒绝；不会猜测其他安装目录。

## 单例、权限与生命周期

- 基础 QQ 注入 agents/conversationManager/agentIO；未安装 Remote Ops 时审批/问答仍可用。停用 Manager 或 Agent I/O 会使依赖它们的 QQ 停用，不另开旧 Session Manager，也不退回旧的直接发送路径。
- 所有 QQ 聊天输出经 Agent I/O 的 `sendMessage()` 发送（Iteration 04 起含 Interaction 气泡与等待提示，见 [Agent I/O](../plugin-sources/dsh-agent-io/README.md) 的“QQ Official 出站：Interaction 气泡”）；未绑定 Interaction 时普通回复、工具错误与轮次错误提示：逻辑消息 ID 取自原生 Session ID 与事件 seq（重复事件只发一次）；每个分片前复核对端仍被访问配置准入、来源 Session 仍是 Manager `isCurrentSession` 认可的当前 Session；`/stop` 与 `aborted`/`interrupted` 结束的 Turn 取消尚未交给 QQ 的输出。明确拒绝、结果未知与部分发送分别记录且不重发；进程内去重不跨重启。旧配置项 `streaming` 已停用，QQ 聊天不再使用 SDK 流式消息。
- 斜杠命令（Iteration 05）：仍在并发合并之前处理，但识别、解析、一次性认领与路由由 Agent I/O 命令路由完成；命令的执行与授权（例如 Remote Ops `/ops` 的所有者检查）不变，未知命令仍作为普通聊天进入 Agent，命令消息不会再成为 Agent 输入。不再自动注册 SDK `/help`（`/bot-help` 保留）。
- 审批与 `ask_user_question`（Iteration 06）：Agent I/O 的 HITL Bridge 经原生 `approval/request`/`user-questions/request` waterfall 接收本应用当前 Session 的请求，提示与按钮经 `sendMessage()` 发送；只接受同一 Conversation 预期作答者的按钮或文本回应（文本作答在并发合并之前，经 I/O 入站去重认领）。原生审批策略与结果语义不变。`hitl.enabled: false`（默认 `true`）时这些请求交回原生 Web/Desktop。需要 `dsh-agent-io@0.1.0-test.6` 或更新，旧包会让 Gateway 启动即报错。
- `qqbot_send_file`（Iteration 05）：只发往调用者 Agent 的当前会话，经 Agent I/O 作为附件消息发送；`target` 参数仅在与当前会话一致时接受。`sendFile.restrictPaths`/`extraRoots` 白名单不变并在发送时复核。
- 普通聊天入站（Iteration 02 起）：SDK 中间件链（白名单、群聊禁用、@ 门控、命令、问答、更正、合并、附件下载）位置不变，附件与引用自 Iteration 05 起以标准附件描述随消息进入 I/O，走到消息处理器的消息经 Agent I/O 入站通道去重后交给 QQ 会话入口，入口按同一访问配置复核，再经 Conversation Manager 创建原生输入；I/O 不授予任何权限。去重为进程内、有界，详见 [Agent I/O](../plugin-sources/dsh-agent-io/README.md)。
- 进程共享 appId 租约拒绝重复 Gateway，卸载等待停止后释放；只构造一套 Sender 与一个 HITL Bridge。
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

QQ 可对接 Agent 层 Interaction 服务，详见 [接口与验证边界](INTERACTION.md)。QQ 基础接入仍不依赖它，不增加 Gateway、数据库或额外模型。安装包、在 Preset 中声明并隔离服务、应用 QQ 补丁和部署是不同步骤；部署状态见 README；是否实际启用由各实例配置决定。

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

生命周期状态在 Manager 的显式 `stateFile`。旧版 `$DSH_HOME/qqbot/model-prefs.json` 不再隐式读取；离线审查后可选用原文件，或完整复制到新路径。备份同时保留原生 Session/Schedule 和 Identity/通知状态。停用开关保留最新路由；未完成副作用仍会阻塞轮换，不能删除记录强迫重置。

验证：`node --test maintenance/session-lifecycle.test.mjs`；配套 Character `scripts/run-lifecycle.ps1` 在两个真实 rc.2 Host 进程中验证空白根、Memory 连续性、停机逾期、原提醒冷恢复和独立任务。模型/Sender 为合成替身，不启动 QQBot、不证明实机收件；已随 Character test.14 在 Windows 实例部署，保留 test.13 生命周期配置；真实 QQ 收件与手机审批仍待验收。

## DSH 0.2.1-rc.3

已在安装目录与数据目录分离的实际 rc.3 中验证 QQ 适配、Interaction、Session 生命周期及提醒/任务恢复，QQ Bot/SDK 版本及两份补丁未变。通用 QQ 仍不依赖 Character。自有 Windows 维护入口增加可信宿主目录选择；这是维护脚本能力，不是 QQ 运行插件的依赖。测试使用合成模型和 Sender，没有手机收件证明。
