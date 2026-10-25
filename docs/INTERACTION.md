# 可选 Agent Interaction 适配（test.10 配套）

本轮源码面向 DSH 0.2.1-rc.2、QQ Bot 0.5.2。交互策略本身由独立 `dsh-interaction-policy` 提供，源码位于 [Character 仓库](https://github.com/EJYDOvO/character-agent-v1) 的 `packages/interaction-policy`；该通用包不要求安装 Character。配套 Character test.10 已部署；GitHub 源码与本机安装是独立步骤，旧恢复包并未自动替换。

QQTK 的 `gateway/bootstrap.js` 使用原生 `agentPresets.serviceFor(agent, 'interactionPolicy')`。没有服务时保留旧出站；有服务时只把真实 Session 事件、Sender 和当前回复目标转给 Agent 策略，避免双发。Streaming 使用策略从原生 `agent/assistant-stream` 收到的帧，审批与问答仍使用原唯一通道。待审批/问答状态作为只读提示传给策略以抑制等待提示。

原生 `runtime-context`、`skill-catalog`、`time-context`、`agent-instructions` 虽通过 `user/message` 出现，但只是当前轮的上下文，不是新的平台输入。QQTK 与 Interaction Policy 必须配套识别，保留此前可信 QQ 入站的呈现状态；上下文本身不能登记输入、解除后台抑制或恢复已取消输出。Web、Schedule、未知来源及未登记的普通用户消息仍不得借此输出到 QQ。

2026-10-26 修复已配套 Interaction `0.1.0-test.3` 在 Character test.14 实例部署：补齐时间与工作区指令来源分类，避免首轮或时间刷新后模型正常完成但 QQ 无回复。QQTK 27 项轻量、30 项 SDK 边界测试通过；实际 DSH 原生时间投影、静态/流式结果、工具步骤及背景/取消隔离通过。两份包管理器补丁保持配套，QQ 补丁应用后 15 文件逐字节匹配源码；部署后检查单 Gateway、实际安装代码及健康状态。模型/Sender 使用合成替身，未发送真实 QQ 验收消息，手机收件仍待确认。回滚需同时匹配 Interaction、QQ 补丁及维护快照，旧组合会重新引入吞回复问题。

`gateway/middleware-setup.js` 保留白名单、问答、原消息合并和 `/stop`。仅运行中私人文本以 `更正：`/`更正:` 开头时走明确修正。若 Host 定义 `manager.admitInteractionInput(ctx)`，先等待可信入站确认并要求返回同一 Session record；失败不得继续调用策略。Character Identity 使用它复用 Owner 校验和真实来源记录，普通 QQ 项目无需 Character Identity。

修正不是自动推测“等等”“不对”的含义。是否 cancel 或 steer 由 Agent 策略按真实工具状态决定；QQTK 不分类任务或生成回复。`/stop` 在调用既有 native handler 前关闭未发出的呈现内容，不承诺回滚外部工具副作用。

Remote Ops 版本为 `1.1.1-test.1`：目标 Agent 已有 Interaction 时不再发送普通 progress 提示；原生流式帧更新活动时间，避免把持续流式输出误判为无进展。stale、timeout、维护结果及长任务完成通知仍保留，不能把这些运维事件混同为闲聊 Hang on。

## 验证与使用边界

2026-10-19：QQTK 自动化回归 13/13 通过；原始 0.5.2 快照应用候选补丁后，10 个文件逐字节匹配维护源码。验证在单独 fixture Git 目录中执行，并关闭自动换行转换；仅补丁生成器的 `--check` 不能替代应用验证。

新增 `maintenance/interaction.test.mjs` 执行实际适配代码体，SDK/Sender 替身覆盖无插件回退、去重、工具错误排序、关闭 Streaming、问答/白名单顺序、明确修正与 `/stop`。Remote Ops 回归覆盖提示让出及活跃流的 stale 抑制。`npm test` 已加入这些测试。

Character 的原生隔离探针使用真实 DSH Loop、实际 QQ 出站/中间件副本和已安装 SDK，Provider/Sender 为确定性替身；不创建 QQBot 或建立 QQ 网络连接。详情与最新结果见 Character 的交互文档。生产启动、Session 恢复、Owner 授权与唯一 Gateway 已验证；手机气泡、真实发送限额和真实审批按钮不能由这些检查证明。

兼容补丁仍从原始 0.5.2 快照生成，不能手改安装目录。部署前必须重建/检查补丁、生成新的锁文件与候选包并执行完整回归。旧 `plugin-packages` 的恢复包不包含候选改动；不可用旧包版本号覆盖打包，或只修改源码就声称已启用。

配套实例的最终真实 QQ 入站测试已正常完成，用户确认手机气泡正常、没有重复消息；真实逐帧时序、异常网络与频控仍未专项验收。完整部署与回退记录见 [Character test.10](https://github.com/EJYDOvO/character-agent-v1/blob/main/docs/RELEASE-test10.md)。
# 未发布修复说明

2026-10-20：新增可信 native input 登记、协议长度分片、额度共享、可取消 SDK 重试与响应正文 deadline。需要配套 QQ Bot 0.5.2 和 SDK 1.0.5 两份补丁，完整接口、操作及验证边界见 [审计修复说明](INTERACTION-AUDIT-FIXES.md)。以下原设计/部署记录不代表修复候选已经部署。
