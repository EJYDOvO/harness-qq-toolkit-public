# 可选诊断契约 v1

Agent I/O test.8 在包内提供 `./diagnostics`，不是日志服务或新插件。Character、QQ、Interaction、HITL、通知、Remote Ops 和 Manager 各自产生观察事件，业务权威与持久写入者不变。

## 开关与容量

Host `agentIO` 配置 `diagnostics:true` 可把事件交给已有 debug logger；`diagnosticCapacity` 默认 256、最多 1024。默认不开详细诊断。Host 测试可 `agentIO.diagnostics.subscribe(listener)`，返回卸载函数。快照只是同一进程的有界内存记录，没有数据库。

QQ `deliveryDiagnostics:true` 复用已有轮转文件记录器：订阅本平台/Adapter/账号的 v1 事件，保留原有 v0 协议诊断；最多 512 条待写，约 1 MiB 轮转并只保留一份前档。卸载移除订阅并清理定时器。文件不可用时只告警一次，不改变业务。v0 和 v1 的 boot/关联键不能混用。

## 字段

| 字段 | 语义 |
|---|---|
| v / boot / at | schema 版本、随机 I/O 实例 ID、毫秒时间；重载 I/O 后新建 boot/密钥 |
| component / event | 闭合集合，模块与动作；不接受动态正文作为事件名 |
| platform / adapter | 受限的公开协议类型标识 |
| account / conversation | 对接入账号及 `{type,id}` 的 HMAC；原值不记录 |
| input / session / logical | 入站平台 ID、原生 Session ID、逻辑发送 ID 的 HMAC |
| notification / request / receipt | 持久通知事件、HITL 临时引用、平台 API 回执的 HMAC |
| turn / reply / bubble / index / count | 非负整数；物理分片 index 与语义气泡 bubble 不混淆 |
| status / reason / stage | 闭合状态、原因分类及 API 前/平台阶段；未知原因只记 other |
| elapsedMs / generation / phase / kind | 可选计数和枚举；不收集错误对象或额外参数 |

HMAC 使用随机进程内密钥，并按 platform/adapter/account 分域。同一实例内，用 `(boot, account, conversation, input)` 定位输入，以 session 关联当前路由，再以 logical 关联排队、逐片和结果。通知发送前的 Outbox 事件同时含 notification/logical；HITL queued 同时含 request/logical。这样可重建生命周期而不用原始身份或正文。跨 I/O 重载不承诺稳定关联，不持久化或导出密钥。

`diagnostics.scope({platform,adapter,accountId,conversation}).emit(component,event,fields)` 只观察，不验证或授予身份。不得从浏览器、模型或原始 platformData 创建权限。所有额外字段被丢弃，正文、OpenID、Token、Cookie、原始异常与 Memory 不记录。同步/异步观察器故障被隔离；授权异常仍按业务门禁拒绝，不能当作诊断异常忽略。

## 结果含义与限制

`sent` 表示平台 API 已接受，不代表手机到达。`not-sent` 区分 before-platform 与 platform；`unknown` 可能已发生，`partial` 已接受部分分片，二者不能自动重发。Remote Ops 的 JSON status 是交接时摘要；Character 组合的最终持久权威仍是 SQLite Outbox。

默认日志不再输出 Manager 路由/Session 原值、QQ 入站 JSON 或 SDK 动态异常。QQ 协议 ACK/Typing 与 Token/WebSocket 是控制操作，不是审批结果或聊天送达。I/O 前的中间件异常没有输入回复授权时仅产生固定 Host 告警，不恢复 SDK 直发。

附件下载器只收到分类日志适配器，原始文件名、本地路径及异常内容不传给 Host logger；这不改变资源校验、下载结果或失败语义。
