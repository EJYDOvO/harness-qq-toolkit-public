# 可选 Agent Interaction 适配

## 当前部署与验证边界

Conversation Manager `0.1.0-test.1` 已从 QQTK 抽离，配套 Character test.21 / Interaction test.7，已在授权后配套部署。QQ 的会话入口是独立服务的薄适配；审批等待/问答只提供轮换阻塞与清理回调。Typing 使用最新入站目标，并在 Agent 销毁、换模、轮换、回收和 Gateway/服务卸载时释放。正文发送、动态 Hang-on、Worker 续轮及回执协议保持不变，SDK 补丁未修改。安装和状态恢复见 [通用集成](GENERIC-INTEGRATION.md)；以下版本记录保留当时语境。

最新源码配套 Interaction **0.1.0-test.7**、Character test.21、独立 Conversation Manager，已在授权后部署；旧版为 test.6 / test.20。本轮基线为 rc.3、QQ Bot 0.5.2、SDK 1.0.5。策略位于 [Character 仓库](https://github.com/EJYDOvO/character-agent-v1/tree/main/packages/interaction-policy)，不依赖 Character。停用 Interaction 保留普通 QQ 流程；Session 仍由同一个 Manager 管理。

## 契约

gateway/bootstrap.js 用原生 agentPresets.serviceFor 获取当前 Agent 的策略；只转发可信 Session 事件和唯一 Sender，接管 assistant 后阻止旧出站重复发送。审批、问答、Remote Ops 与权限检查继续使用既有通道。

可信入站先登记 native UserMessage。runtime-context、skill-catalog、time-context、agent-instructions 只是上下文，不能登记输入、解除后台抑制或恢复取消输出。Web/Schedule/未知或未登记输入不能通过 QQ 呈现。更正与 /stop 沿用 DSH cancel/steer/followup，不保证撤销工具副作用。

适配器绑定 deliveryReceipts:true，只有 QQ 接口返回成功后调用 metadata.onDelivered()。补丁的 StreamSession.observe 只观察请求/回执/重试/失败/取消，不改变重试与协议逻辑。SDK update 可能只进入缓冲，不能据此确认发送。生成文字和 QQ 回执都不证明手机收件。等待提示（kind:status）与正文（kind:assistant）共用同一 Sender；只有正文回执用于确认自然回复，等待提示的生成与模型路由全部在 Interaction 插件内，QQTK 不调用模型。

默认 8 秒无自然回复确认时，将一次提示加入同一 FIFO 队列；发送前复查，不越过正在发送的正文。工具任务可按段落拆泡，maxBubbles 由进度/状态/结果共享。平台硬分片最多 4500 字符，仍共享被动回复额度及过期/主动降级规则。

### 回复目标与非用户来源（配套 Interaction test.6）

- 登记入站时，桥接层在 Session 记录上保存 `原生消息 ID → 回复目标`（每会话最多 100 条，先进先出）。发送时按元数据 `input` 选择目标，查不到时回退最近入站目标。被动额度、借用其他消息和主动降级规则仍完全在 QQ Gateway，Interaction 不参与。
- 非用户、非上下文投影来源先询问 `policy.admitsSource(message)`：Interaction 认可的 Worker 续轮正常投递（并解除先前的后台抑制）；否则保持抑制并写一条 `suppressed` 诊断（`source` 只取 subagent-settled/schedule/web/other）。旧版 policy 没有该方法时保持原抑制。
- 被动额度耗尽或过期后，流式回退为主动消息的发送失败会记录 `fallback-failure`（httpStatus/bizCode）并继续抛出。

### 执行期间的入站（配套 Interaction test.6）

- 安装了支持 `intervene` 的 Interaction 时，`handleInbound` 不再在 followup 后等待整轮结束：Agent 运行中到达的输入交给 `policy.intervene(message)`，由 Interaction 决定 cancel/steer/followup；空闲时照常 followup。并发保护只覆盖入站处理瞬间，QQ 输出仍由 Interaction 的单一队列串行发送。
- 由于入站链路提前结束，SDK typing 中间件不再续期；桥接层改为每个会话一个 50 秒间隔的 typing 保活，Agent 空闲即停止。
- 未安装 Interaction 或旧版 policy 没有 `intervene` 时，保留原有“等待整轮结束”的串行行为。显式“更正：”中间件保持在合并之前。
- 诊断新增 `intervene` 事件的枚举字段：decision（revise/priority/supplement/append/dropped）、phase（text/tool/waiting-user）、why（judge/timeout/error/invalid/explicit/none），不记录消息内容。
- Interaction test.8 配套：`why` 增加 superseded；新增 `draft`（ready/late/failed/rejected/none，等待提示用了动态句还是固定文案及原因）和数字字段 `elapsedMs`（起草或判断耗时）。仍只记录枚举和数字，不含文本。

## 可选脱敏诊断

QQ 配置 deliveryDiagnostics:true（默认 false），无需启用 debug。文件位于 $DSH_HOME/qqbot/diagnostics/delivery.jsonl；无 DSH_HOME 时为 ~/.dsh-qqbot/diagnostics/delivery.jsonl。

记录 Host seq/轮次、逻辑回复/气泡、SDK index/msg_seq/state、重试、关联编号、回执是否缺失、长度与正文哈希，以及枚举值 kind（assistant/status/tool-or-error）和 dynamic（等待提示是否为动态生成），用于区分等待提示与正文回执。不保存正文、原始 QQ/Session/应用标识、异常原文、Token 或 Cookie。标识和正文使用进程随机密钥 HMAC，重启后不能跨进程关联或从文件还原密钥。

最多保留当前文件及一份轮转文件，每份约 1 MiB（单批可略超）；内存缓冲有界，写入失败提示一次并继续消息服务。关闭后不再记录，已有文件由维护者按需删除；不写 Session/Memory，不上传 GitHub。

排查重复时对照 assistant-settlement、stream-open、stream-request / stream-receipt、static-request / static-receipt：检查同一回复是否打开两次流、静态补发，或 DONE 的 association 是否匹配先前 receipt。多帧请求本身是正常流式更新。本轮未确定真实重复气泡根因，也未改变其重试/去重策略。

## 验证、升级与回滚

轻量测试包含日志脱敏/轮转/失败隔离；SDK 隔离覆盖回执回调、缺失编号、观察器异常、4501/5001/10001 字符、取消、重试和跨平台隔离。本轮 37 项轻量检查通过（含 kind/dynamic/source/intervene 枚举脱敏、按输入选择目标、来源委托、主动回退失败诊断、运行期入站交给 intervene 与 typing 保活），SDK 隔离 33 项沿用上轮结果；实际 rc.3 Host 交互与两进程恢复通过，Provider/Sender/API 为合成替身，不证明手机收件或重复问题消失。

从维护源码重建并检查两份补丁；候选 Profile 离线安装、冻结锁文件，逐文件比对安装产物。不要修改官方 DSH 或已安装包。升级/回滚匹配 Interaction、Core 配置、QQ/SDK 补丁、锁文件、自有维护快照和旧 Profile；保留新数据，无 Memory Schema 迁移。
