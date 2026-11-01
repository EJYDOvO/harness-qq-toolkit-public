# DSH Conversation Manager

独立、平台无关的 Host 插件。维护 Conversation → 原生 Session 的唯一当前路由、模型/Preset 偏好、并发、恢复和可选空白轮换。QQ、Identity、Memory、Remote Ops 均不是本插件依赖。

当前源码 `0.1.0-test.3`（Iteration 08 候选，未部署），保留恢复异常分类和关闭规则，补充 Context 活性门禁及可选脱敏观察。最近部署记录为 test.2。验证基线为 DSH `0.2.1-rc.3`；复用原生 Agent/Session/Persistence/Preset/Schedule，不实现第二套运行时、调度器或数据库。

## 安装与装配

从本目录 `pnpm pack --pack-destination <LOCAL_ARTIFACT_DIRECTORY>`，在 Profile 安装已审阅的 tarball。固定版本及 SHA-256，保持 `autoInstallPeers: false`，不另装宿主 SDK。它是普通插件，安装后需要声明；不会自动装配 QQ。

```yaml
- insert:
    - id: conversation-manager
      name: dsh-conversation-manager
      config:
        stateFile: '<ABSOLUTE_PROJECT_DATA>/conversations.json'
    # 各通信 Adapter 在这之后装配；它们原生 inject conversationManager。
```

每个 Profile/项目使用独立的绝对 `stateFile`。只允许单活 Host 写入。一个服务内的各 Adapter 共用同一个偏好存储，避免分别加载旧状态造成覆盖；外部改写检测失败会拒绝提交，不静默刷新或重置。

## 可信 Host Adapter 契约

`ctx.get('conversationManager').openAdapter(namespace, options)` 返回本插件的会话管理句柄。此接口仅供可信插件调用，不注册模型工具/RPC。

```js
const manager = conversations.openAdapter('example:account', {
  context: ctx, preset: 'cordis', cwd: projectDirectory,
  // provider/model 可省略，使用原生 agentDefaultModel；无有效选择则拒绝。
  sessionIdleTimeout: 600000,
  sessionLifecycle: { enabled: false, freshOnHostRestart: true, inactivityMs: 43200000 },
  adapter: {
    key: (scope, peer) => 'example:account:' + JSON.stringify([scope, peer]),
    lifecycleScope: scope => scope === 'direct',
    acceptActivity: (scope, peer, sender, id) => scope === 'direct' && peer === sender && !!id,
    isUserInput: target => !!target?.inputId,
    inputId: target => target?.inputId,
    waitingForUser: record => pendingApprovals.has(record.sessionKey),
    release: record => releasePlatformResources(record),
  },
});
ctx.effect(() => () => manager.disposeAll());
```

聊天平台不必自己调用下表接口完成 Agent 输入交接：[dsh-agent-io](../dsh-agent-io/README.md) 的 `openConversation({manager, scopes, admits, …})` 用本句柄完成入站 `getOrCreate` → `isCurrentSession` → 原生输入，以及出站的 `getSessionRecord` + `isCurrentSession` 复核，本插件的算法与状态不变。

这些回调处理已经通过平台鉴权的输入，不能把模型字段当作活动证明或权限。`key` 必须属于该 namespace；拒绝重复或前缀重叠的活动命名空间。不同 Conversation 默认独立 Session，不自动进行跨平台账号关联。`replyTarget` 是 Adapter 的不透明数据，不在 Manager 中解释平台消息 ID。

| 接口 | 用途 |
|---|---|
| `getOrCreate(scope, peer, sender, target)` | 串行准入、恢复/创建，必要时安全轮换 |
| `noteUserMessage(...)` | Adapter 完成访问校验后记录活动，命令/问答也可调用 |
| `getSessionRecord` / `records` | 当前活跃句柄；不授予身份或 Memory 权限 |
| `ownershipState(key)` | 唯一当前 Session、上一个轮换根、代数和阻塞原因 |
| `isCurrentSession(record)` | 对象、持久路由、原生 Agent 注册表及关闭状态同时匹配 |
| `setModelOverride` / `clearModelOverride` | 原生前缀 Fork 切模型；清偏好不改写当前归属 |
| `setPresetOverride` | 校验并保存下一新 Session 的 Preset；已开始会话保持锁定 |
| `remove` / `compact` | 显式重置 / 原生压缩；不同于自动轮换 |
| `disposeAll` | 幂等关闭、释放 Adapter 资源、撤销命名空间租约 |

可选 `prompt(record)` 提供平台上下文；`cancelPending(record)` 清理已回收通道。审批状态仍由原生 Approval 维护，`waitingForUser` 只是生命周期阻塞条件。Manager 不验证审批人、不决定工具和 Memory 权限。

轮换创建无 seed/parent 的根；正在执行、Inbox、审批/问答或未完成持久 Turn 阻塞轮换。原生提醒保持原 Session。没有可信 `preserveScheduledSession(oldId)` 桥接时，存在提醒即延后，不能为方便轮换直接返回 true。Identity/通知层负责历史根权限和稳定 Conversation Outbox。

恢复先读取持久 Session，只有该次 open/load 抛出原生 `SessionPersistenceNotFoundError` 实例且 sessionId 匹配时才允许新建。普通 ENOENT、同名伪造错误、其他 Session 的缺失，以及读取/关闭/原生 resume/挂载中的错误均上抛；Preset 查询也不吞异常。自定义后端必须遵守原生缺失错误契约。新 Session flush 与路由提交成功后才发布记录；偏好写失败撤回内存变化，不回退其他 Preset。

每个 record/Agent 生命周期的同步 `release` 回调只调用一次，模型切换后重新计入新生命周期。原生 handle 的异步回收统一登记：关闭等待先前回收，重新准入也等待同 Session 的旧句柄释放；并发关闭复用同一个 Promise。某项清理抛错仍执行其余清理，最后报告聚合错误。关闭失败不释放当前服务内的 namespace 租约，不能将其当作可安全重开的成功卸载；不提供失败句柄的静默重试。

## 从旧 QQTK 升级与回滚

新 QQ 补丁强制注入本服务；旧补丁和新 Identity 不能混装。QQ 命名空间及键仍为 `qqbot:<appId>:<scope>:<peer>`，可保留既有 Session ID、模型/Preset 偏好和 lifecycle JSON，不会读取其他项目的默认文件。

上线前先停机一致备份并清点旧偏好、原生 Sessions/Schedule/storageDomain、Memory、Identity binding/coordination 和通知账本。可显式选择原偏好文件，或将其完整复制到新 `stateFile`；保留原件，不合并两个写入器，不删除旧根或重建有提醒的路由。损坏/归属不明的记录需要人工审查，不自动授权。

Character 候选准备要求已验证的独立包 pin/哈希、有效状态文件，以及首次切换的 `--conversation-state-reviewed`；缺失时阻断。本机首次切换已在授权后完成一致性备份、旧路由/提醒审查与精确复制；其他实例仍须独立执行门禁。部署证据只留本机。

回滚必须成套恢复 QQ 补丁、Character Identity/Core 和 Profile/锁文件。保留切换后新增 Session、Memory、任务/通知记录及当前路由；若新路由已有变化，不可直接用旧 prefs 快照覆盖。需先离线核对，再决定将当前 JSON 保留在旧路径或暂停入口。本轮精确复制了旧路由文件，未做 Memory Schema 迁移或生产故障注入/回滚演练。

## 来源与验证边界

从 `@tencent-connect/dsh-qqbot@0.5.2` 的 SessionManager、ModelResolver、IdleEvictor 和 PrefsStore（含 QQTK 自有兼容修复）抽离，保留腾讯 MIT 许可。去除 QQ prompt/身份/路径及私有 settings 读取；没有复制 QQ 连接或调度器。

`maintenance/conversation-manager.test.mjs` / `session-lifecycle.test.mjs` 验证契约、事务失败及资源释放。Character `scripts/run-lifecycle.ps1` 使用真实 rc.3、两个 Host 进程、模拟第二平台、合成模型/Sender验证并发、冷恢复、轮换、历史提醒、Memory ACL、通知去重和服务重载。它不证明真实 QQ 收件、NapCat 协议或跨平台审批路由已实现。
## Iteration 08 增量（test.3，未部署）

持久格式、Session Key、模型/Preset 偏好及唯一当前路由不变。普通日志不再输出原始 peer/session/key 或动态异常。可信 Adapter 可选提供 `diagnostics(event, record)` 观察 route/close；异常不影响业务，接口不要求 Agent I/O、QQ 或 Character。版本和回滚仍须核对包/锁/补丁与原状态文件，不能用空路由替换。
