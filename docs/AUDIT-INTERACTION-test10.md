# QQTK Interaction 隔离审计

结论：**NO-GO，当前不建议发布下一版。** 本轮新增测试和文档，没有修改运行代码、手改官方DSH/SDK、连接生产QQ、访问生产记忆、推送或部署。

审计基线：本仓库main `56d1a1687ee70777e9b67085b4bf95144706f7e9`，Character main `f2aae367962a2539895d9bfdb7925d438072f12a`；DSH `0.2.1-rc.2`、QQ Bot `0.5.2`、实际SDK `qqbot-nodejs 1.0.5`。主分支与本地HEAD一致；已安装QQ的10个维护文件与源码哈希一致。补丁在全新fixture实际应用后10/10字节匹配。

跨仓库完整报告：[Character test.10审计](https://github.com/EJYDOvO/character-agent-v1/blob/main/docs/AUDIT-test10-INTERACTION.md)。本轮尚未推送；本地完整报告在同级Character仓库 `docs/AUDIT-test10-INTERACTION.md`。以下行号对应审计基线。

| 问题 | 严重性、证据 | 位置 | 最小修复 |
|---|---|---|---|
| Interaction绕过textChunkLimit，4501/5001/10001字符直接发送 | P1，Q01六用例失败；4500控制通过 | `maintenance/qqbot-src/dist/gateway/bootstrap.js:49-53`，Character `policy.mjs:70-81` | 平台层硬分块；语义气泡不能代替协议长度控制 |
| 多Stream不走ReplyLimiter，静态/Stream预算分裂 | P1，Q02失败 | `bootstrap.js:101-110` | 目标租约/计数统一，stream首次创建计数，帧更新不重复消耗 |
| ReplyLimiter删除过期记录后再次许可，缓存重复候选可复活 | P1，Q03/Q04失败，上游继承 | QQ包 `dist/transport/reply-limiter.js:20-27`、`reply-target.js:23-38` | 过期墓碑、候选去重、接收时间及明确降级 |
| stop会complete并补发SDK未发尾巴，429重试越过取消 | P1，Q05/Q06失败 | Character `policy.mjs:94-96`；SDK `dist/streaming.js:91-109,178-194` | Abort/generation贯穿SDK缓冲与重试；不可承诺撤回已提交请求 |
| update失败后最终尾巴不再进入SDK | P1，Q07失败 | Character `policy.mjs:64-81` | 区分明确失败/未知交付，最终全文不能静默丢失 |
| 同Session Web/后台输出及Hang-on进入QQ | P1，Q09条件复现，真实Web入口未运行 | `bootstrap.js:44-53` | 可信turn origin与delivery intent，不能仅凭Session映射路由 |
| SDK超时只等响应头，不覆盖正文 | P1，Q10实际ApiClient复现 | SDK `dist/protocol/api/api-client.js:60-79` | 超时覆盖整个响应，外层有可取消drain |
| merge survivor不持有下游串行锁 | P1，Q12实际SDK复现峰值并发2 | SDK `dist/middleware/concurrency-guard.js:119-125,171-175,251-283`；启用点`middleware-setup.js:90` | survivor真正完成后再释放peer锁 |
| policy.get异常阻止原生stop | P1，Q14隔离故障注入复现，实际HMR触发待验证 | `maintenance/qqbot-src/dist/gateway/middleware-setup.js:56-62` | 策略展示错误不得阻止nativeStop；不可放宽Agent scoped授权 |
| 通用QQ更正不刷新replyTarget/msgId | P2，Q13失败；Character hook可缓解实例 | `middleware-setup.js:77-87` | QQ可信入站统一更新目标及cache，不依赖Character |
| SDK频控检测读错异常字段 | P2，Q11实际ApiError复现 | SDK `dist/streaming.js:196-203`；`protocol/types.js:17-36` | 读取httpStatus/bizCode；受控且可取消重试 |

完整报告另含Character草稿重试的真实DSH复现、Identity中间件detach、忘记后source.quote、分段与慢网络积压、记忆大库延迟、安装/回滚闭包风险。**没有发现已证实P0或Owner ACL绕过**；不能由此推导所有安全场景已验证。

不要把“五分钟”当已验证的私聊期限：本机QQ缓存使用群聊5分钟、私聊30分钟，ReplyLimiter却默认首次发送起算1小时；流式路径根本未调用它。实际平台期限、频控上限及手机异常网络表现本轮没有连接QQ验证。msg_seq由SDK生成，未证实多个Stream必定共用同一seq。

## 测试与复跑

- 原轻量回归13/13通过。
- 实际SDK审批/问答/文件路径与Owner边界10/10通过，发送器为替身。
- 新增SDK/桥接门禁19项，1通过、18失败；都是保留的正常断言，没有skip/todo。完整两个仓库共40项新离线门禁，3通过、37失败，不等于37项独立Bug。
- QQ补丁生成检查通过，在新建Git fixture实际apply后10个文件与维护源码逐字节一致。
- Character原生宿主基础8项通过，但新增真实retry门禁失败，错误草稿和最终答案都被发送。
- 没有验证生产锁文件、真实QQ收件、真实HMR、重连及生产回滚。旧tgz恢复包不包含新代码，不能当成本轮可恢复证明。

`npm test`仍是原轻量范围；**发布还必须运行`npm run test:audit`，当前会返回非零**。SDK门禁使用Node24及同级`character-agent-v1`源码，需显式准备代码fixture：

```powershell
node maintenance/audit/prepare-fixture.cjs '<SDK package directory>' '<QQ Bot package directory>' '<NEW isolated output directory>'
$env:QQBOT_AUDIT_SDK_DIR = '<output>/sdk/dist'
$env:QQBOT_AUDIT_DIST = '<output>/qq/dist'
npm run test:audit
```

prepare只复制指定包的dist/package.json，然后覆盖仓库维护的QQ代码；拒绝已存在的输出目录，不读取Profile配置。SDK测试直接执行StreamSession/MessageApi/ApiClient/concurrencyGuard；桥接和中间件为实际源码函数体，HTTP/令牌/身份使用合成替身。没有构造QQBot或建立网络连接。不要用Mock通过替代真实QQ兼容性证据。

修复优先顺序：提交/交付状态与停止 → 可信入口及Sender生命周期 → 长度/额度/超时/频控 → merge与更正目标 → 格式/积压 → 兼容声明和不可变发布manifest。上游SDK问题应通过自有适配、独立SDK版本补丁或后续已验证上游版本处理；仅现有dsh-qqbot补丁不会修改传递SDK。

审批和问答仍使用唯一原通道，Owner/nonce/取消测试没有退步；通知账本的unknown隔离仍是防重复设计，不能保证exactly-once手机投递。修复输出取消时必须保留明确任务通知的独立语义。
