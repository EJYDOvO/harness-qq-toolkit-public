# DSH Agent I/O（Unified Agent I/O）

独立、平台无关的 Host 插件，提供统一聊天出站接口 `sendMessage()`、入站通道 `openInbound()`、连接 Conversation Manager 的 `openConversation()`，以及其内部的命令路由与基础附件契约。当前源码 `0.1.0-test.5`：架构路线的 **Iteration 01：普通文本出站**、**Iteration 02：普通聊天入站**、**Iteration 03：Conversation Manager 统一 I/O 接线**与 **Iteration 05：Commands / 基础 Media**（见 Character 仓库 `docs/architecture-planning/IMPLEMENTATION_ROADMAP.md`）。运行实例为随 Iteration 04 授权部署的 `0.1.0-test.4`；test.5 仅源码与隔离验证，**未部署**，真实 QQ/手机验收待完成；实例版本以仓库根 README 为准。验证基线为 DSH `0.2.1-rc.3`、Node 24。

它只做逻辑消息的交接语义：出站的校验、同 Conversation 串行、取消与分片间复核、同一逻辑消息去重、诚实的结果；入站的标准消息交接、按平台消息范围去重与交接结果；以及平台无关的 Session 接线（Manager 取得/校验当前 Session、原生 `UserMessage`、Interaction 交接、出站可信路由）。平台协议（回复目标、限额、分片、API 错误、事件解析与标准化）由各平台 Adapter 负责；准入与权限仍属 Host；Session 与路由仍由原生 DSH 和 [Conversation Manager](../dsh-conversation-manager/README.md) 负责。不依赖 QQ SDK、Character、Interaction 或 Conversation Manager 包（只使用平台传入的 Manager 句柄），原生消息构造取自 Host 提供的 `@deepseek-ai/dsh-llm`；不注册模型工具、RPC 或路由；不持久化任何状态。

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

`ctx.get('agentIO')` 返回冻结对象 `{ sendMessage, registerAdapter, openInbound, openConversation }`。仅供可信 Host 代码调用，**不是模型可调用的工具**。平台 Adapter 通常只需要 `openConversation()`（下文）与 `sendMessage()`；`registerAdapter`/`openInbound` 是它使用的底层接口。

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
  message: { text: '你好' },        // 文本、附件，或带说明文字的附件（见“基础 Media”）；replyTo 等其他字段返回 not-sent/unsupported
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

`reason` 为固定小写代码（如 `cancelled`、`stale`、`unauthorized`、`invalid-target`、`unsupported`、`queue-full`、`adapter-unavailable`、`id-conflict`、`platform-rejected`、`rate-limited`、`timeout-or-network`）；`parts` 为每个物理分片 `{index, status: sent|not-sent|unknown|skipped, receipt?, reason?}`（附件分片另带 `attachment`＝附件序号与可选 `uploaded`＝平台文件 ID），保留同一逻辑消息与平台回执的关联。`duplicate: true` 表示该 id 已交接过，本次返回首次结果、未再次发送。

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

### openInbound(channel) → { receive(message), claim(message), close() }

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
  message: { id: '<PLATFORM_MESSAGE_ID>', text: '你好', attachments: [/* 可选，见“基础 Media” */], quote: { /* 可选：被引用消息 */ } },
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

`claim(message)` 在同一入站去重范围内把一条平台消息登记为“已消费”而不交接（`claimed` / `duplicate` / `unavailable`）：命令路由用它保证命令只执行一次，且同一平台消息之后经 `receive()` 只会得到 `duplicate`，不会再成为 Agent 输入。

### openConversation(options) → Conversation（Iteration 03）

平台 Adapter 为每个接入账号打开**一次** Conversation 接线，把入站交接与出站路由都接到该账号的 Conversation Manager 句柄上。Session 获取、当前 Session 校验、原生 `UserMessage` 创建和 Interaction 交接只在这里实现；新平台不需要复制 QQ 的这些代码，只写协议部分（标准化、回复目标、分片、发送、错误分类）。

```js
const manager = ctx.get('conversationManager').openAdapter('example:account-1', { /* key、lifecycleScope… */ });
const conversation = ctx.get('agentIO').openConversation({
  platform: 'example', adapter: 'example-gateway', accountId: 'account-1',
  manager,                                   // 须有 getOrCreate / getSessionRecord / isCurrentSession
  scopes: { direct: 'dm', group: 'room' },   // Conversation type → Manager scope（沿用既有 Session Key）
  admits: (scope, peer) => allowList.has(peer),   // 平台访问配置；入站与出站都复核，抛错视为拒绝
  onInput: (record, message, policy) => {},       // 可选：交接前的平台侧登记（如该输入的回复目标）
});
ctx.effect(() => conversation.close);
const inbound = conversation.openInbound(standard =>
  conversation.handoff(standard, { replyTarget: { input: standard.message.id }, content: standard.message.text }));
conversation.registerAdapter({ split, send, classify, check: (record, target) => ({ ok: true }) });
// Host 侧发送：目标与来源证据都取自 Manager 记录
await ctx.get('agentIO').sendMessage({ id, target: conversation.target(record), origin: { sessionId: record.sessionId }, message: { text } });
```

| 方法 | 作用 |
| --- | --- |
| `handoff(standard, {replyTarget, content})` | 入站交接：平台/账号必须属于本接线 → `admits` 复核 → `manager.getOrCreate(scope, peer, sender, replyTarget)`（Manager 的创建/恢复/轮换以及外层包装，如 Character 的 Owner-only，全部保留）→ 返回的记录必须是同一 Conversation 且 `isCurrentSession` 为真，并再次 `admits` 复核（Session 获取期间被撤权时 `rejected/unauthorized`，不创建输入）→ Interaction 查询（失败时 `not-delivered/interaction-unavailable`，不创建输入）→ 原生 `UserMessage` → `onInput` → Interaction 的 `admitInput` → Agent 运行中且策略提供 `intervene` 时 `intervene()`，否则 `followup()`。`content` 可为函数，准入后才组装。结果：`accepted {record, message, mode, interactive}`；`rejected {reason}`（`unauthorized`、`invalid-target`、`empty-message`、`closed`）；`not-delivered {reason}`（`session-unavailable` 另带只留在 Host 侧的 `error`；`session-changed`；`interaction-unavailable`），可直接作为 `openInbound` 的 deliver 结果。 |
| `submit(record, text, {revise})` | 已取得记录时的同一交接（先复核当前 Session 与 `admits`，再查询 Interaction；同上的拒绝与失败结果）；`revise: true` 用于显式更正，要求策略提供 `revise()`，否则 `not-delivered/no-interaction`。 |
| `route(target, origin)` | 出站可信路由：平台/账号属于本接线，类型有映射；对端仍被 `admits` 准入（`unauthorized`）；`origin.sessionId` 必须是 Manager 当前记录的 Session 且 `isCurrentSession` 为真（`stale`）。返回 `{ok: true, record}` 或 `{ok: false, reason}`。 |
| `registerAdapter({split, send, classify, check, accepts?, sendAttachment?})` | 以 `route` 作为 `resolve` 注册该账号的出站 Adapter（首片与每个后续分片前复核）；`check(record, target)` 追加协议条件，默认拒绝：只有明确返回 `{ok: true}` 才发送，`undefined`/`null`/其他值记为 `invalid-target`（拒绝原因不是小写代码时同样记为 `invalid-target`），抛出异常记为 `adapter-error`，均不调用 `send`；`send(route, text, info)` 与可选的 `sendAttachment(route, attachment, info)` 收到 `route.record`；不提供 `sendAttachment` 时附件消息返回 `unsupported`。每个接线一个。 |
| `openInbound(deliver)` | 以本接线固定的平台、Adapter 与账号打开入站通道（语义同 `openInbound`）。每个接线一个。 |
| `openCommands({prefixes, messages})` | 本账号的命令路由（Iteration 05，见下文），以本接线的 `admits` 准入，并在本接线入站通道的去重范围内 `claim` 每条命令消息。每个接线一个。 |
| `target(record)` | Manager 记录的逻辑目标 `{platform, accountId, conversation: {type, id}}`，与入站标准消息的同名字段一致；scope 未映射时为 `undefined`。 |
| `policy(record)` | Agent 的可选 Interaction 策略（原生 `agentPresets.serviceFor(agent, 'interactionPolicy')`）：`undefined`＝未启用，`null`＝查询失败：入站不按未启用处理，`handoff`/`submit` 返回 `not-delivered/interaction-unavailable` 且不创建原生输入（I/O 记为 `failed/before-handoff`，平台重投可再处理）；出站由调用方暂停该 Session 的 Interaction 输出。 |
| `close()` | 关闭入站通道、注销出站 Adapter；之后交接返回 `closed`，排队的出站消息返回 `adapter-unavailable`。 |

**统一 Conversation 引用**：`{platform, accountId, conversation: {type, id}}` 在入站（由通道固定平台与账号）与出站（由同一接线校验）中含义相同，并经同一 `scopes` 映射到 Manager 的 `(scope, peer)`。因此不同平台、账号或 direct/group 互不串线；Manager 已持久化的 Session Key、偏好与生命周期状态不变。

**Manager 仍是唯一路由权威**：接线不缓存记录、不写偏好、不决定轮换，每次交接与每个出站分片都向 Manager 重新确认（`getOrCreate` 后、创建输入前，以及发送每个分片前）。它只信任平台 Host 代码传入的 Manager 句柄与 Host 填写的 `origin`，不信任模型给出的 ID、Owner 声明或 `platformData`。

## Commands（Iteration 05）

命令识别、解析与路由是 I/O 内部模块（`commands.mjs`，ADR-057 L1），不是独立插件；**执行与授权仍归 Host/业务插件**。平台 Adapter 在自己的命令位置（QQ 为原 SDK `slashCommand` 处，即并发合并中间件之前，`/stop` 因而不排在运行中的 Turn 后面）做完协议步骤（去掉 @ 标记、群聊须 @），把标准候选交给 `router.dispatch()`：

```js
const router = conversation.openCommands({ prefixes: ['/'] });
router.register({
  name: ['stop'], scopes: ['direct', 'group'],      // 可选范围限制
  authorize: call => call.sender.id === owner || '仅部署所有者可执行',   // 可选；只有 true 才执行
  execute: call => '已中止',                         // 返回文本（或 {kind:'text', content} / {kind:'noop'}）
});
const r = await router.dispatch({ conversation: { type: 'direct', id: peer }, sender: { id: peer }, message: { id: msgId, text: '/stop' } },
  { reply: text => platformReply(text), context: platformContext });
if (r.status !== 'pass') stopPlatformChain();       // 命令消息不得再进入普通 Agent
```

- 结果：`pass`（不是已注册命令：普通文本或未知命令，照旧进入普通聊天）、`handled`、`denied`（`scope`/`unauthorized`，已回复）、`failed`（`execute` 抛错，回复 `Error: …`）、`duplicate`（同一平台消息已被认领）、`rejected`（未准入、形状无效或通道已关闭，不回复、不执行）。除 `pass` 外都表示该消息不得成为 Agent 输入。
- 一次性：执行前以入站通道的 `claim()` 在 `(platform, accountId, conversation, message.id)` 范围内认领；重复/并发投递得到 `duplicate`，之后经 `receive()` 的同一消息也只得到 `duplicate`。不同账号、direct/group 的同名消息 ID 互不影响。没有平台消息 ID 时无法去重（每次都执行）。
- 授权：路由不比较身份、不读 `platformData` 或 Adapter 上下文；只按本接线的 `admits` 准入 Conversation，再交给命令自己的 `authorize(call)`。`call` 冻结，只含 `name/args/raw/conversation/sender/message` 与原样传入的 Adapter `context`；模型输出和消息中的任何字段都不能授予 Host 权限。
- 刻意不归入 Commands：审批/问答回应与显式更正保留各自的业务语义与位置（问答截获、`更正：` 中间件）。

## 基础 Media（Iteration 05）

`sendMessage().message` 与入站 `message` 都可带结构化附件描述（`kind: image|voice|video|file`，可选 `name`、`contentType`、`size`，入站另有 `transcript`）：

```js
message: {
  text: '图表如下',                                  // 可选说明文字；纯附件时可省略
  attachments: [{ kind: 'image', name: 'chart.png', size: 1024, resource: { type: 'local', path: '<已校验的真实路径>' } }],
}
```

- **可信资源与模型可见内容分开**：`resource`（`{type:'local', path}` 或 `{type:'remote', url}`）只由可信 Host 代码或平台 Adapter 填写——例如 QQ 下载到 media 目录的文件、平台事件给出的 URL、或经路径白名单校验后的工具文件；它不是模型输出，本身也不会进入模型可见文本。模型可见内容由平台 Adapter 从描述组装（类型标签、名称、ASR 文本等）。I/O 核心只检查形状（出站最多 10 个、入站最多 20 个附件，未知字段或类型为 `unsupported`）。
- **发送**：分片顺序为说明文字的各分片，然后每个附件一片；同 Conversation 顺序、逻辑 ID 去重（指纹含附件类型、名称与资源）、取消与每片前的路由复核与文本相同。Adapter 必须在发送任何分片前 `accepts(attachment)` 全部附件，否则整条 `not-sent/unsupported`，不会留下半条消息。
- **结果**：上传失败（平台未发出消息）为 `not-sent`；资源在发送时不再通过校验为 `not-sent/before-platform`；媒体消息请求超时/5xx 为 `unknown`，**不重发**；前面分片已发、后面失败为 `partial`。
- **入站**：`attachments` 与 `quote: {id?, text?, attachments?}`（被引用消息）随标准消息冻结交给会话入口；纯附件消息合法（`text` 可为空串）。

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
- **不经本插件的发送**：命令回复（平台对该命令消息的协议回复）、审批/问答、Remote Ops 通知，以及 Character Identity 的历史提醒/通知 Outbox（各自的独立授权规则不变）仍走 Gateway Sender；上述普通聊天的当前 Session 检查不适用于它们。Interaction 气泡（Iteration 04）与 `qqbot_send_file` 文件（Iteration 05）已经由本插件发送。

## QQ Official Adapter

在 QQTK 补丁的 `dist/transport/qq-text-adapter.js`（源码 [maintenance/qqbot-src](../../maintenance/qqbot-src/dist/transport/qq-text-adapter.js)），由 QQ Gateway 启动时注册（`platform: 'qq-official'`，`accountId` 为 QQ 应用 ID）：

- 接线：Gateway 启动时为该应用 `openConversation({platform: 'qq-official', accountId: <APP_ID>, manager, scopes: {direct: 'c2c', group: 'group'}, admits: 访问配置})`，入站与出站共用；Session Key 仍为 `qqbot:<appId>:<scope>:<peer>`。
- 目标：首片及每个后续分片前由共享 `route` 复核：对端仍被该 Gateway 的访问配置（`c2cMode/c2cAllow`、`groupMode/groupAllow`，规则同 SDK accessPolicy）准入，否则 `unauthorized`；`origin.sessionId` 必须等于 Manager 当前记录的 Session，且 `manager.isCurrentSession(record)` 为真（记录仍是映射项、Session 仍为当前、原生 Agent 仍在），否则 `stale`。QQ 的 `check` 再要求记录的回复目标仍指向同一 Conversation。Manager 不提供 `isCurrentSession` 时接线拒绝创建。只比较 Host 填写的证据，不信任模型 ID、Owner 声明或 platformData。
- 稳定 ID 与取消（Gateway 侧）：普通回复、工具错误、轮次错误各自用 `qq:<Session ID>:<原生事件 seq>:<assistant|tool|turn-error>`；每条消息带所属原生 Turn 的 `AbortSignal`（Iteration 05：仍在 I/O 中的提交持有该 Turn 控制器的租约，容量上限——每 Session 8 个、全局 256 个 Session——只淘汰空闲控制器，所以 `/stop` 总能取消排队中的旧 Turn 输出；正常结束的空闲控制器在 `turn/end` 即释放，中止的留作墓碑以拒绝迟到输出；没有 Turn 的输出共用一个 Session 控制器，`/stop` 后换新；Session 释放（轮换、移除、销毁）与 Gateway 关闭时中止并清理，被持有的数量受 I/O 队列上限约束；刚创建、尚未取得租约的控制器也不会被容量淘汰）。`/stop`、以 `aborted`/`interrupted` 结束的 Turn 会取消该 Session 尚未交给 QQ 的输出，含该 Turn 的迟到输出；因取消而结算的半截回复（`interrupted: true`）及取消后的缓冲不发送。已交给 QQ 的分片不撤回。旧配置项 `streaming` 已停用：普通回复不再打开 SDK 流式消息，整条回复在 settlement 后作为一条逻辑消息发送。正文只取结算的 `assistant/message` 文本块（DSH 0.2.1-rc.2/rc.3 的增量只在 `agent/assistant-stream` 上，不作为 `session/event` 发出）；即使收到 `assistant/chunk` 也不累积、不在 `turn/end` 补发，被放弃的尝试或未结算的增量不会发送。
- 回复目标与被动回复限额：复用 Gateway 现有 Sender（同一 msg_id 4 次被动回复，超限/过期降级主动推送；诊断记录照旧）。
- 分片：原 Markdown 分片器（`textChunkLimit`，默认 4500），超长单行再按上限切开且不拆代理对。
- 错误：SDK `ApiError` 的 4xx（除 408）为 `not-sent`（429 为 `rate-limited`），状态 0（超时/网络）、408、5xx 及非 `ApiError` 为 `unknown`。
- 基础 Media（Iteration 05）：同一 Adapter 提供 `accepts`/`sendAttachment`，只接受 `local` 资源（不让调用方借 QQ 抓取任意 URL）。Gateway 的 `sendMedia` 分两步：先复核资源（仍是自身真实路径、在 media 目录/cwd/`sendFile.extraRoots` 白名单内、是普通文件；否则 `invalid-resource`，不读取不上传），再以 `srv_send_msg: false` 上传（SDK 自带上传重试；只上传不会给用户显示任何内容，失败记为 `not-sent/upload-failed`），最后发送媒体消息（失败按上面的文本规则分类）。被动回复额度与以前的文件发送相同（不使用 event_id）。
- `qqbot_send_file`：目标只能是调用该工具的 Agent 所在的当前会话（`findByAgent`），`target` 参数仅为兼容保留，必须与当前会话一致，否则拒绝；路径白名单与符号链接解析保留，并在发送时再查一次。文件作为一条附件消息经 `sendMessage()` 发送，逻辑 ID `qq:<Session>:<Turn>:file:<真实路径哈希>`：同一轮内同一文件的重复调用（包括结果未知后的重试）得到第一次的结果，不会重发；只有被证明未发送（`not-sent`）后才以新 ID 重试。工具不再持有 QQ bot，也没有直接调用 `sendImage`/`sendFile` 的路径。

QQ 插件现在原生 `inject` `agentIO`；未安装本插件时 Gateway 拒绝启动，不退回旧的直接发送路径。

## QQ Official 出站：Interaction 气泡（Iteration 04）

绑定 Interaction 时，策略只负责语义分泡、Hang-on、插话与回复节奏，把**已完整**的气泡交给桥接层的 `sendText(text, metadata)`；桥接层（`createInteractionOutbound`）把每个气泡、等待提示和工具/轮次错误提示都作为一条逻辑消息交给 `sendMessage()`，经上面的 QQ 文本 Adapter 由 Gateway Sender 发出。没有其他聊天直发路径：Gateway Sender 不再提供 SDK `openStream`，桥接层不调用 `sendMarkdown`。

- **逻辑 ID**：`qq:<Session ID>:<原生 Turn>:<策略实例>:<回复>.<气泡>:<assistant|status>`；策略实例为进程内随机 8 位十六进制，回复与气泡序号来自 Interaction 元数据。同一气泡重复提交得到第一次的结果（不重发），不同气泡不会同号；同号异文为 `id-conflict`。工具/轮次错误沿用原生事件 ID。
- **回复目标**：气泡元数据的 `input`（原生 UserMessage ID）在 QQ 侧映射到该输入的回复目标；QQ 文本 Adapter 只在该目标仍属于本 Conversation 时使用它，否则用记录的最新目标。被动回复额度、过期与主动降级不变。
- **取消**：请求带策略令牌的 `AbortSignal` 与原生 Turn 的 `AbortSignal`（合并），`/stop`、插话撤回、Turn 中止都会停止尚未交给 QQ 的分片；交接前已取消的气泡不发起请求。
- **结果**：只有 `sent` 视为确认；`not-sent`/`partial`/`unknown` 以 `delivery` 状态抛回给 Interaction，由它记录并扣留同一回复的后续气泡（不留空洞、不盲目重发）。`partial`/`unknown` 可能已可见，计为自然回复（不再发 Hang-on）。取消不记警告。
- **授权**：每个分片前与普通回复相同，复核访问配置与 Manager 当前 Session（轮换、移除、撤权后的迟到气泡被拒）。
- **诊断**：`static-request`/`static-receipt`/`static-failure` 另带 `turn`/`reply`/`bubble`/`kind`，仍不含正文、原始 ID 或凭据；原 `stream-*` 记录不再产生。

## QQ Official 入站

QQ Gateway 启动时为该应用打开入站通道。SDK 中间件链先于 I/O 执行：自回声与消息 ID 去重（SDK 记住最多 1000 个 ID，超出后清除 5 秒前的记录，并非固定 5 秒窗口）、白名单/群聊禁用（accessPolicy）、群聊 @ 门控、内容清洗、限流、斜杠命令（Iteration 05 起由本插件的命令路由识别、认领与路由，QQ 的 `commandGate` 只做 @ 标记与群 @ 判断，命令本身的执行与授权不变；不再使用 SDK `slashCommand`，也不自动注册 `/help`）、待答问题截获、显式更正、并发合并、输入状态、引用解析、附件下载与 envelope 组装；Character Identity 的 Owner 准入中间件也在其后、I/O 之前。只有走到 `bot.on('message')` 的普通聊天消息才进入 I/O：

1. Adapter 标准化（`normalizeQQMessage`）：C2C 的 Conversation 为发送者；群为群 openid，发送者另记；消息 ID 为 QQ `msg_id`；附件与被引用消息（含其附件）转为基础 Media 描述——已下载的为 media 目录本地文件（逐个附件下载并按附件序号关联，不按文件名：同名或无名的附件各自对应自己的文件，下载失败的附件不会关联到别的文件），否则为 QQ 事件给出的 URL，语音带 ASR 文本，过长名称与含控制字符的引用被丢弃；原始 SDK 上下文只放 platformData。模型可见正文从这些描述组装，格式与以前相同（类型标签、`Image:`/`File:` 行、ASR、`[Reference attachments]`）。
2. I/O 去重并交给会话入口 `deliverInbound`，它只做 QQ 部分：C2C 只能是发送者本人，组装回复目标，并在准入后用原有分层逻辑组装模型可见正文（引用、附件、语音、群历史）；其余由共享 `handoff` 完成——按同一访问配置再次准入（禁用的群范围不开放），经 Conversation Manager `getOrCreate`（保留 Session 创建/恢复/轮换与 Character 包装）得到当前 Session，创建原生 `UserMessage`；Interaction 启用且 Agent 运行中时走 `intervene()`，否则 `followup()`。交接后 QQ 侧清理群历史、保持 typing，未启用 Interaction 时仍等待本轮结束。显式更正（`更正：…`）同样经共享 `submit(record, text, {revise: true})`；`/stop`、更正与出站 Interaction 绑定都用同一 `conversation.policy()` 查询。
3. 原 `handleInbound` 不再直接创建 Agent 输入，QQ 代码中也不再有 `getOrCreate`/`isCurrentSession`/`followup`/`intervene`/`createUserMessage` 的交接调用；Session 获取失败时仍发送原有的固定兜底提示（结果为 `failed/before-handoff`）。取得 Session 后、创建输入前共享接线再以 `isCurrentSession` 复核：Gateway 卸载或轮换恰好落在这一间隙时不向已失效的 Session 交接（`failed/before-handoff`，`session-changed`，不发提示）。

同一 Conversation 的消息由 SDK 并发合并中间件（`concurrencyGuard` merge，按 `scope:targetId`）串行处理：后到消息等前一条处理完、`receive()` 返回后才进入 I/O，所以 QQ 路径上 I/O 只会看到已结束的重复——前一条已交接则 `duplicate`，前一条 `before-handoff` 失败则正常交接。I/O 处理中的记录也因此每个 Conversation 至多一条（Session 获取一直不返回时，后续消息由 SDK 缓冲、超出 `maxQueue` 丢弃）。

交接之后（创建输入时）抛出的异常由 I/O 记为 `failed/unknown`，只写警告日志；不再像以前那样落到 SDK `errorHandler` 把原始错误文字回给用户。

## 测试

```bash
npm test
```

（在 QQTK 根目录；包括 `maintenance/agent-io.test.mjs` 的核心语义、`maintenance/commands.test.mjs` 的命令路由、`maintenance/qq-media.test.mjs` 的 QQ 基础 Media（真实临时文件、目录联接与 `qqbot_send_file`）、`maintenance/turn-controls.test.mjs` 的 Turn 取消控制器、`maintenance/conversation-io.test.mjs` 的 Conversation 接线（真实 Conversation Manager + 不含 QQ 代码的合成第二平台：隔离、冷恢复、轮换、关闭竞态、准入拒绝、去重、出站授权、Interaction）、`maintenance/qq-agent-io.test.mjs` 的 QQ 出站集成与 `maintenance/qq-inbound.test.mjs` 的 QQ 入站集成；QQ 测试经 `maintenance/qq-conversation-fixture.mjs` 执行 Gateway 自己的 `openConversation` 代码。）设置 `QQBOT_TEST_PROFILE=<验证 Profile>` 可额外用已安装的 Markdown 分片器与 SDK 中间件（访问控制、@ 门控、斜杠命令、合并）跑相应测试，否则这些项跳过。所有测试使用 Fake Adapter / 模拟 QQ Bot，不连接 QQ。

## 本轮未覆盖

被 SDK 合并的非首条消息 ID 不进入 I/O 去重；Character Identity 入站证据中间件、问答与显式更正仍在 I/O 之前，各自只靠 SDK 消息 ID 去重（更正已用共享交接，但不经 I/O 入站去重；命令自 Iteration 05 起经 I/O 认领）；出站引用关联（`replyTo`）与远程 URL 附件；视觉理解等高级媒体工具仍为原实现；Remote Ops 启动时的 Owner 路由恢复与 Character Identity 的准入仍直接调用 Manager `getOrCreate`（不是 Agent 输入）；Interaction 气泡的持久发送状态与崩溃后恢复（重启后同一气泡不会被识别为重复）；审批/问答展示（06，仍走 Gateway Sender）；通知/提醒与其历史授权规则（07，Character Identity Outbox 未改）；QQ Personal 及其他平台；持久发送状态与崩溃恢复；真实 QQ 手机收件验收。
