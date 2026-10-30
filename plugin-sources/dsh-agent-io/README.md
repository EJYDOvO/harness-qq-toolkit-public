# DSH Agent I/O（Unified Agent I/O）

独立、平台无关的 Host 插件，提供统一聊天出站接口 `sendMessage()`。当前源码 `0.1.0-test.1` 是架构路线的 **Iteration 01：普通文本出站**（见 Character 仓库 `docs/architecture-planning/IMPLEMENTATION_ROADMAP.md` 3.1）。**未部署**；实例版本以仓库根 README 为准。验证基线为 DSH `0.2.1-rc.3`、Node 24。

它只做逻辑消息的交接与发送语义：校验、同 Conversation 串行、取消与分片间复核、同一逻辑消息去重、诚实的结果。平台协议（回复目标、限额、分片、API 错误）由各平台 Adapter 负责；Session 与路由仍由原生 DSH 和 [Conversation Manager](../dsh-conversation-manager/README.md) 负责。不依赖 QQ SDK、Character 或 Interaction；不注册模型工具、RPC 或路由；不持久化任何状态。

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

`ctx.get('agentIO')` 返回冻结对象 `{ sendMessage, registerAdapter }`。仅供可信 Host 代码调用，**不是模型可调用的工具**。

### sendMessage(request) → Promise\<SendResult\>

```js
const result = await ctx.get('agentIO').sendMessage({
  id: 'turn-12/bubble-3',          // 可选：逻辑消息 ID；同一 Conversation 内重复提交返回首次结果
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

`reason` 为固定小写代码（如 `cancelled`、`stale`、`unauthorized`、`invalid-target`、`unsupported`、`queue-full`、`adapter-unavailable`、`platform-rejected`、`rate-limited`、`timeout-or-network`）；`parts` 为每个物理分片 `{index, status: sent|not-sent|unknown|skipped, receipt?, reason?}`，保留同一逻辑消息与平台回执的关联。`duplicate: true` 表示该 id 已发送过，本次未再次发送。

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

## 语义与边界

- **顺序**：同一 `(platform, accountId, conversation)` 严格按提交顺序发送；不同 Conversation 或不同账号互不阻塞，并发有界。
- **取消**：开始前取消 → `not-sent/cancelled`，不调用平台；进入平台 API 的分片不会被撤回，之后的分片跳过（`partial`）。关闭插件时排队消息返回 `closed`，在途分片完成。
- **授权有效性**：I/O 只检查形状，是否允许由 Adapter 依据可信记录在**实际发送时**及每个分片前判定；会话轮换、移除或权限撤销后的迟到消息不会发出。I/O 不信任模型给出的 ID 或权限声明。
- **去重**：同一 Conversation 内重复的 `id`（settlement、模型重试或第二个内部调用方）只发送一次，在途时也一样。去重记录在内存中、有界（最近 1024 条），重启后不保留。
- **不保证 exactly-once**：网络结果可能未知；未知不重试，失败不会记为成功。
- **诊断**：只在 debug 日志输出平台、状态、原因代码、分片数与耗时；不写正文、ID、目标或凭据。

## QQ Official Adapter

在 QQTK 补丁的 `dist/transport/qq-text-adapter.js`（源码 [maintenance/qqbot-src](../../maintenance/qqbot-src/dist/transport/qq-text-adapter.js)），由 QQ Gateway 启动时注册（`platform: 'qq-official'`，`accountId` 为 QQ 应用 ID）：

- 目标：Conversation `direct`→`c2c`、`group`→`group`，从该 Gateway 的 Conversation Manager 记录解析；`origin.sessionId` 必须仍是该 Conversation 的当前 Session，否则 `stale`。
- 回复目标与被动回复限额：复用 Gateway 现有 Sender（同一 msg_id 4 次被动回复，超限/过期降级主动推送；诊断记录照旧）。
- 分片：原 Markdown 分片器（`textChunkLimit`，默认 4500），超长单行再按上限切开且不拆代理对。
- 错误：SDK `ApiError` 的 4xx（除 408）为 `not-sent`（429 为 `rate-limited`），状态 0（超时/网络）、408、5xx 及非 `ApiError` 为 `unknown`。

QQ 插件现在原生 `inject` `agentIO`；未安装本插件时 Gateway 拒绝启动，不退回旧的直接发送路径。

## 测试

```bash
npm test
```

（在 QQTK 根目录；包括 `maintenance/agent-io.test.mjs` 的核心语义与 `maintenance/qq-agent-io.test.mjs` 对已审补丁源码的 QQ 集成。）设置 `QQBOT_TEST_PROFILE=<验证 Profile>` 可额外用已安装的 Markdown 分片器跑一项分片测试。所有测试使用 Fake Adapter / 模拟 QQ Bot，不连接 QQ。

## 本轮未覆盖

入站消息与可信身份交接、入站去重（Iteration 02）；Conversation Manager 的统一接线（03）；Interaction 的 `sendText`/`openStream`、渐进分泡与 SDK Stream（04，现仍走 Gateway Sender）；附件、引用、Commands（05）；审批/问答展示（06，仍走 Gateway Sender）；通知/提醒与其历史授权规则（07，Character Identity Outbox 未改）；QQ Personal 及其他平台；持久发送状态与崩溃恢复；真实 QQ 手机收件验收。
