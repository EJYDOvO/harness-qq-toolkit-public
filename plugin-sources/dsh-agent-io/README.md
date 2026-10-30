# DSH Agent I/O（Unified Agent I/O）

独立、平台无关的 Host 插件，提供统一聊天出站接口 `sendMessage()` 与入站通道 `openInbound()`。当前源码 `0.1.0-test.3`：架构路线的 **Iteration 01：普通文本出站**（已合并）与 **Iteration 02：普通聊天入站**（本分支，见 Character 仓库 `docs/architecture-planning/IMPLEMENTATION_ROADMAP.md`）。**未部署**；实例版本以仓库根 README 为准。验证基线为 DSH `0.2.1-rc.3`、Node 24。

它只做逻辑消息的交接语义：出站的校验、同 Conversation 串行、取消与分片间复核、同一逻辑消息去重、诚实的结果；入站的标准消息交接、按平台消息范围去重与交接结果。平台协议（回复目标、限额、分片、API 错误、事件解析与标准化）由各平台 Adapter 负责；准入与权限仍属 Host；Session 与路由仍由原生 DSH 和 [Conversation Manager](../dsh-conversation-manager/README.md) 负责。不依赖 QQ SDK、Character 或 Interaction；不注册模型工具、RPC 或路由；不持久化任何状态。

## 安装与装配

从本目录 `pnpm pack --pack-destination <LOCAL_ARTIFACT_DIRECTORY>`，在 Profile 安装已审阅的 tarball，固定版本与 SHA-256。声明在平台插件之前：

```yaml
- insert:
    - id: agent-io
      name: dsh-agent-io
      config: {}            # 可选：maxPending、maxPendingPerConversation、maxConcurrent、maxTextLength
    - id: conversation-manager
      name: dsh-conversation-manager
      config: { stateFile: '<ABSOLUTE_PROJECT_DATA>/conversations.json' }
    # 平台 Adapter（如 QQ）在这之后装配；它们原生 inject agentIO。
```

默认上限：全局待发 512、每 Conversation 32（含在途一条）、跨 Conversation 并发 8、单条文本 100 000 字符。

## 接口

`ctx.get('agentIO')` 返回冻结对象 `{ sendMessage, registerAdapter, openInbound }`。仅供可信 Host 代码调用，**不是模型可调用的工具**。

### sendMessage(request) → Promise\<SendResult\>

```js
const result = await ctx.get('agentIO').sendMessage({
  id: 'turn-12/bubble-3',          // 可选：稳定逻辑消息 ID（由可信事件派生，不得随机生成）；见“去重”
  target: {
    platform: 'qq-official',        // 平台
    accountId: '<APP_ID>',          // 接入账号/应用
    conversation: { type: 'direct', id: '<PEER_ID>' },   // direct | group
  },
  origin: { sessionId: '<DSH_SESSION_ID>' },  // 可信来源证据，由 Host 代码填写，Adapter 发送时复核
  message: { text: '你好' },        // v1 仅文本；其他字段（attachments、replyTo…）返回 not-sent/unsupported
  signal,                           // 可选：AbortSignal（或任何带布尔 aborted 的对象）
});
```

永不因发送结果抛出异常，总是返回冻结的结果：

| status | 含义 | 调用方应做 |
| --- | --- | --- |
| `sent` | 所有分片都已被平台 API 明确接受（**不等于用户手机已收到**） | — |
| `not-sent` | 没有任何分片被发送。`stage: 'before-platform'`＝调用平台 API 前失败或被拒（校验、取消、授权失效、队列满、Adapter 不可用）；`stage: 'platform'`＝平台明确拒绝 | 可决定是否以**新 id** 另行发送 |
| `partial` | 前面分片已接受，后续分片被明确拒绝或因取消/失效而跳过 | 不自动补发；已发部分不可撤回 |
| `unknown` | 至少一个分片结果不确定（超时、连接中断、5xx 等），可能已发出 | **不得重发** |

`reason` 为固定小写代码（如 `cancelled`、`stale`、`unauthorized`、`invalid-target`、`unsupported`、`queue-full`、`adapter-unavailable`、`id-conflict`、`platform-rejected`、`rate-limited`、`timeout-or-network`）；`parts` 为每个物理分片 `{index, status: sent|not-sent|unknown|skipped, receipt?, reason?}`，保留同一逻辑消息与平台回执的关联。`duplicate: true` 表示该 id 已交接过，本次返回首次结果、未再次发送。

### registerAdapter(adapter) → unregister()

每个 `(platform, accountId)` 只能有一个活跃 Adapter，重复注册抛错；注销后其排队消息返回 `adapter-unavailable`。

```js
const release = io.registerAdapter({
  platform: 'example', accountId: 'account-1',
  // 发送前及每个分片前调用：用可信路由记录复核目标与来源，返回 {ok:true, route} 或 {ok:false, reason}
  resolve(target, origin) { /* ... */ },
  split(text) { return [text]; },                  // 平台分片规则
  async send(route, text, { index, count, messageId }) { return { receipt: '<platform-message-id>' }; },
  classify(error) { return { outcome: 'not-sent' | 'unknown', reason: 'platform-rejected' }; },  // 缺省或异常时一律 unknown
});
```

### openInbound(channel) → { receive(message), close() }

平台 Adapter 为每个 `(platform, accountId)` 打开**一个**入站通道（重复打开抛错；`close()` 后可由重载的 Adapter 重新打开）。通道对象就是提交入站消息的能力：只有打开它的 Adapter 持有，平台、Adapter 与账号由通道固定，**不取自消息**（消息里带 `platform`/`accountId` 会被拒绝）。`deliver` 是该 Adapter 的可信会话入口（Host 准入 → Conversation Manager → 原生 Agent 输入）。

```js
const inbound = ctx.get('agentIO').openInbound({
  platform: 'qq-official', adapter: 'qq-official-gateway', accountId: '<APP_ID>',
  // 返回 {status:'accepted'} | {status:'rejected', reason} | {status:'not-delivered', reason}
  deliver: async standard => { /* Host 准入、Conversation Manager、followup/intervene */ },
});
ctx.effect(() => inbound.close);
const result = await inbound.receive({
  conversation: { type: 'direct', id: '<PEER>' },   // group 时为群 ID，发送者另见 sender
  message: { id: '<PLATFORM_MESSAGE_ID>', text: '你好' },  // 本轮只有 id/text；attachments、replyTo 返回 unsupported
  sender: { id: '<SENDER>', displayName: '可选' },
  timestamp: '<平台时间，可选>',
  platformData: { /* 只交回本 Adapter 的 deliver，不会自动成为模型可见内容 */ },
});
```

`deliver` 收到冻结的标准消息 `{platform, adapter, accountId, conversation, message, sender, timestamp, platformData}`。结果（不表示 Agent 已处理完）：

| status | 含义 |
| --- | --- |
| `accepted` | 已交给会话入口并创建原生输入（followup 或运行中的 Interaction intervene） |
| `duplicate` | 同一平台消息正在处理或已处理过，本次未交接（不区分两者；见下文“入站去重”） |
| `rejected` | 未创建任何 Agent 输入：校验失败、未授权、通道已关闭、空消息等（`reason`） |
| `failed` | 会话入口失败。`stage: 'before-handoff'` 证明未创建输入（如 Session 恢复失败、交接前 Session 已失效），平台重投可再处理；`stage: 'unknown'` 可能已创建输入，**不重放** |

## 语义与边界

- **顺序**：同一 `(platform, accountId, conversation)` 严格按提交顺序发送；不同 Conversation 或不同账号互不阻塞，并发有界。
- **取消**：开始前取消 → `not-sent/cancelled`，不调用平台；进入平台 API 的分片不会被撤回，之后的分片跳过（`partial`）。关闭插件时排队消息返回 `closed`，在途分片完成。
- **授权有效性**：I/O 只检查形状，是否允许由 Adapter 依据可信记录在**实际发送时**及每个分片前判定；会话轮换、移除或权限撤销后的迟到消息不会发出。I/O 不信任模型给出的 ID 或权限声明。
- **去重**：`id` 在 `(platform, accountId)` 内有效，表示“一条逻辑消息”，应由可信事件派生（QQ 用 `原生 Session ID + 事件 seq + 类别`），不得随机生成；I/O 自身也不生成 id，未提供即不去重。同一 id 且 Conversation 与正文相同＝**同一消息的重试**（重复事件、settlement、第二个内部调用方），只交接一次，在途时也一样，返回首次结果并标 `duplicate`；同一 id 但正文或 Conversation 不同＝**冲突**，返回 `not-sent/id-conflict`，绝不冒用首次的成功结果。正文相同但 id 不同＝**另一条合法消息**，照常发送。已入队的 id 无论结果如何都记住（取消、失效、拒绝也不会被同 id 重新发出）；校验失败与 `queue-full` 不入队、不记住。
- **去重记录的边界**：仅在进程内存中、有界（默认最近 1024 条，`rememberResults`）。淘汰只针对已结束的 id，排队或在途的 id 不会被淘汰；已被淘汰的旧 id 或进程重启后，同一 id 会被视为新消息。**不提供持久 exactly-once 保证。**
- **不保证 exactly-once**：网络结果可能未知；未知不重试，失败不会记为成功。
- **入站去重**：键为 `(platform, accountId, conversation.type, conversation.id, message.id)`，不同平台、账号或 Conversation 的同名 ID 互不影响；并发重复在首个到达时即登记，后到者直接 `duplicate`，不等待首次结果；若首次随后以 `failed/before-handoff` 结束，这次并发重复不会被补交，只有之后的再次投递会被处理。因此调用方若可能并发提交同一消息，应自行按 Conversation 串行（QQ 由 SDK 并发合并中间件保证，见下文）。`accepted`、`rejected` 与 `failed/unknown` 都记住；只有 `failed/before-handoff` 被释放以便平台重投。缺少平台消息 ID 时不去重，**绝不以正文哈希合并消息**。记录仅在进程内存，默认 24 小时（`inboundWindowMs`）、最多 4096 条（`rememberInbound`），处理中的条目不淘汰；超期、淘汰或进程重启后同一平台消息可能再次交接，**不提供持久 exactly-once**。
- **入站信任**：I/O 只检查形状与范围，不授予 Owner、Memory 或工具权限；用户文本、显示名和 platformData 都不是授权依据。准入由平台中间件与会话入口（Host、Conversation Manager 及其包装，例如 Character Identity 的 Owner-only 检查）决定。
- **诊断**：只在 debug 日志输出事件类别、平台、状态、原因代码、分片数与耗时；不写正文、ID、目标或凭据。
- **不经本插件的发送**：Interaction 气泡与 SDK 流、审批/问答、Remote Ops 通知，以及 Character Identity 的历史提醒/通知 Outbox（各自的独立授权规则不变）仍走 Gateway Sender；上述普通文本的当前 Session 检查不适用于它们。

## QQ Official Adapter

在 QQTK 补丁的 `dist/transport/qq-text-adapter.js`（源码 [maintenance/qqbot-src](../../maintenance/qqbot-src/dist/transport/qq-text-adapter.js)），由 QQ Gateway 启动时注册（`platform: 'qq-official'`，`accountId` 为 QQ 应用 ID）：

- 目标：Conversation `direct`→`c2c`、`group`→`group`，从该 Gateway 的 Conversation Manager 记录解析。首片及每个后续分片前复核：对端仍被该 Gateway 的访问配置（`c2cMode/c2cAllow`、`groupMode/groupAllow`，规则同 SDK accessPolicy）准入，否则 `unauthorized`；`origin.sessionId` 必须等于记录的 Session，且 `manager.isCurrentSession(record)` 为真（记录仍是映射项、Session 仍为当前、原生 Agent 仍在），否则 `stale`。Manager 不提供 `isCurrentSession` 时 Adapter 拒绝创建。只比较 Host 填写的证据，不信任模型 ID、Owner 声明或 platformData。
- 稳定 ID 与取消（Gateway 侧）：普通回复、Streaming 静态降级（与该回复共用 ID）、工具错误、轮次错误各自用 `qq:<Session ID>:<原生事件 seq>:<assistant|tool|turn-error>`；每条消息带所属原生 Turn 的 `AbortSignal`。`/stop`、以 `aborted`/`interrupted` 结束的 Turn 会取消该 Session 尚未交给 QQ 的输出，含该 Turn 的迟到输出；因取消而结算的半截回复（`interrupted: true`）及取消后的缓冲不发送。已交给 QQ 的分片不撤回。
- 回复目标与被动回复限额：复用 Gateway 现有 Sender（同一 msg_id 4 次被动回复，超限/过期降级主动推送；诊断记录照旧）。
- 分片：原 Markdown 分片器（`textChunkLimit`，默认 4500），超长单行再按上限切开且不拆代理对。
- 错误：SDK `ApiError` 的 4xx（除 408）为 `not-sent`（429 为 `rate-limited`），状态 0（超时/网络）、408、5xx 及非 `ApiError` 为 `unknown`。

QQ 插件现在原生 `inject` `agentIO`；未安装本插件时 Gateway 拒绝启动，不退回旧的直接发送路径。

## QQ Official 入站

QQ Gateway 启动时为该应用打开入站通道。SDK 中间件链保持原样并先于 I/O 执行：自回声与消息 ID 去重（SDK 记住最多 1000 个 ID，超出后清除 5 秒前的记录，并非固定 5 秒窗口）、白名单/群聊禁用（accessPolicy）、群聊 @ 门控、内容清洗、限流、`/stop` 等斜杠命令、待答问题截获、显式更正、并发合并、输入状态、引用解析、附件下载与 envelope 组装；Character Identity 的 Owner 准入中间件也在其后、I/O 之前。只有走到 `bot.on('message')` 的普通聊天消息才进入 I/O：

1. Adapter 标准化（`normalizeQQMessage`）：C2C 的 Conversation 为发送者；群为群 openid，发送者另记；消息 ID 为 QQ `msg_id`；原始 SDK 上下文只放 platformData。
2. I/O 去重并交给会话入口 `deliverInbound`：按同一访问配置再次准入（C2C 只能是发送者本人，禁用的群范围不开放），用原有分层逻辑组装模型可见正文（引用、附件、语音、群历史），经 Conversation Manager `getOrCreate`（保留 Session 创建/恢复/轮换与 Character 包装）得到当前 Session，创建原生 `UserMessage`；Interaction 启用且 Agent 运行中时走 `intervene()`，否则 `followup()`，未启用 Interaction 时仍等待本轮结束。
3. 原 `handleInbound` 不再直接创建 Agent 输入；Session 获取失败时仍发送原有的固定兜底提示（结果为 `failed/before-handoff`）。取得 Session 后、创建输入前再以 `isCurrentSession` 复核：Gateway 卸载或轮换恰好落在这一间隙时不向已失效的 Session 交接（`failed/before-handoff`，`session-changed`，不发提示）。

同一 Conversation 的消息由 SDK 并发合并中间件（`concurrencyGuard` merge，按 `scope:targetId`）串行处理：后到消息等前一条处理完、`receive()` 返回后才进入 I/O，所以 QQ 路径上 I/O 只会看到已结束的重复——前一条已交接则 `duplicate`，前一条 `before-handoff` 失败则正常交接。I/O 处理中的记录也因此每个 Conversation 至多一条（Session 获取一直不返回时，后续消息由 SDK 缓冲、超出 `maxQueue` 丢弃）。

交接之后（创建输入时）抛出的异常由 I/O 记为 `failed/unknown`，只写警告日志；不再像以前那样落到 SDK `errorHandler` 把原始错误文字回给用户。

## 测试

```bash
npm test
```

（在 QQTK 根目录；包括 `maintenance/agent-io.test.mjs` 的核心语义、`maintenance/qq-agent-io.test.mjs` 的 QQ 出站集成与 `maintenance/qq-inbound.test.mjs` 的 QQ 入站集成。）设置 `QQBOT_TEST_PROFILE=<验证 Profile>` 可额外用已安装的 Markdown 分片器与 SDK 中间件（访问控制、@ 门控、斜杠命令、合并）跑相应测试，否则这些项跳过。所有测试使用 Fake Adapter / 模拟 QQ Bot，不连接 QQ。

## 本轮未覆盖

入站的附件/引用标准字段（现仍经 platformData 由 QQ 原逻辑组装）；被 SDK 合并的非首条消息 ID 不进入 I/O 去重；Character Identity 入站证据中间件与命令、问答、显式更正仍在 I/O 之前，各自只靠 SDK 消息 ID 去重；Conversation Manager 的统一接线（03）；Interaction 的 `sendText`/`openStream`、渐进分泡与 SDK Stream（04，现仍走 Gateway Sender）；附件、引用、Commands（05）；审批/问答展示（06，仍走 Gateway Sender）；通知/提醒与其历史授权规则（07，Character Identity Outbox 未改）；QQ Personal 及其他平台；持久发送状态与崩溃恢复；真实 QQ 手机收件验收。
