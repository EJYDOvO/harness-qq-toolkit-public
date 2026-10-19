# Interaction 审计修复候选（未部署）

> 后续状态：2026-10-20 经授权随 Character test.11 / Interaction test.2 部署，两份补丁共 16 个已安装文件核对通过；新宿主健康及 QQ ready 通过。保留原候选报告；没有执行实机回复或生产回滚演练。维护 `ops verify` 也已恢复 Character 专用的单 Owner、唯一 Gateway 和产物完整性分支，完整核验通过。

2026-10-20；DSH 0.2.1-rc.2 / QQ Bot 0.5.2 / SDK 1.0.5。修复仅在源码及隔离代码副本中验证，没有更改生产安装或连接 QQ。

## 修改

- F02：QQ 适配负责不超过配置值/4500 字符的分片，不拆 UTF-16 代理对。静态及流式 4501、5001、10001 字符不丢字；流式溢出内容等正式 settlement 后发送，取消停止剩余分片。
- F04、F08、F16：新增 SDK 版本化补丁，cancel 中断重试等待及后续请求；正文读取也受 HTTP deadline 约束；识别真实 ApiError.httpStatus / bizCode。
- F06：真实 QQ 入站通过访问控制后，由 manager.registerInteractionInput(record,message) 登记 native input。Agent 层拥有通道准入策略；普通 Web 的 user 来源不够授权 QQ 输出。策略服务重载暂不可用时不降级绕过策略。
- F07：Stream 与静态共用四次回复额度；耗尽后降级静态主动发送。过期条目保留墓碑，候选 ID 去重；容量耗尽按拒绝处理，不通过淘汰记录恢复额度。主动发送仍可能被 QQ 配额拒绝，不声称可靠送达。当前 TTL 仍沿用原 ReplyLimiter 语义，不宣称私聊五分钟规则已确认。
- F09：合并消息的 survivor 持有 peer 锁直到自己的 downstream 结束；超时请求 abort 后等待退出，不提前允许另一个有副作用的任务并发进入。
- F15：普通 Agent 的“更正：”刷新回复目标，不依赖 Character Identity；/stop 即使策略查询失败仍调用原生停止。

## 补丁与维护

源码位置：`maintenance/qqbot-src`、`maintenance/sdk-src`；对应 upstream 目录存储版本和 SHA-256 快照。SDK MIT 许可保存在 `licenses/qqbot-nodejs-LICENSE`。

```powershell
node maintenance/build-qqbot-patch.cjs
node maintenance/build-qqbot-patch.cjs --sdk
node maintenance/build-qqbot-patch.cjs --check
node maintenance/build-qqbot-patch.cjs --sdk --check
node maintenance/audit/verify-patches.cjs
```

安装候选需要同时应用两份补丁，不得修改已安装文件：

```yaml
overrides:
  '@tencent-connect/qqbot-nodejs': 1.0.5
patchedDependencies:
  '@tencent-connect/dsh-qqbot@0.5.2': patches/dsh-qqbot@0.5.2.patch
  '@tencent-connect/qqbot-nodejs@1.0.5': patches/qqbot-nodejs@1.0.5.patch
```

Stage/verify 已加入 SDK 补丁、源码校验、版本固定与 seal 哈希；未实际执行生产 Stage/Deploy。旧维护 policy 与整套升级回滚闭包仍需独立审查，不能直接拿源码模板覆盖私人配置。

## 验证与限制

- 36/36 自动测试通过：13 项原回归 + 23 项 SDK/适配隔离用例。
- 真实 SDK 的审批、问答、文件 ACL：10/10；不包含手机按钮验收。
- QQ 13 文件及 SDK 3 文件的补丁可应用，应用结果逐字节等于维护源码。
- Character 112/112 自动测试、真实 DSH 原生重试及 9 项集成检查通过。对应详细结果与剩余 F17–F19 风险见 Character 仓库的 `docs/INTERACTION-AUDIT-FIXES.md`。
- 实际 QQ 配额、到期、主动降级手机收件、断线与完整 HMR 未验证。超长 Markdown 跨片渲染待验收；在途发送不能撤回；未知投递不盲目重发。现有包版本和生产状态未提升，不构成发布批准。
