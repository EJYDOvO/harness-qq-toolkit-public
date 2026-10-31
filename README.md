# Harness QQ Toolkit

为 DeepSeek Harness 提供 **QQ 接入兼容补丁、可选 Remote Ops 插件和维护工具**。普通 DSH Agent 可以独立使用 QQ 接入，不需要 Character Agent、角色 Preset 或记忆插件。

**Iteration 07（2026-11-01 已授权部署）：** Agent I/O `0.1.0-test.7`、Remote Ops `1.1.1-test.2` 与配套补丁已随 Character test.26 冷切换上线，冻结锁文件、代码哈希、单一 Gateway 和 QQ connected 检查通过；角色、Memory、Session、Schedule 与通知账本保留。独立通用安装、真实 QQ 通知、审批按钮与手机显示仍未验收。

Notification：`conversation.openNotifications()` 发往稳定 Conversation，不要求当前 Session，由访问配置与通知方自己的 `authorize(target)` 在每个分片前复核，与聊天共用同一 Conversation 队列。Gateway 只把通知器交给 Remote Ops（及经其包装的 Character Identity）。Remote Ops 独立运行时经通知器发送并如实记录 sent/not-sent/partial/unknown；与 Character 集成时只由 Character 持久 Outbox 发送，同一事件不会有第二个发送方。`notifications.enabled: false` 可关闭。

Notification 定向修复已包含在本次部署：Remote Ops 在落盘成功后才提交内存快照，写入失败后先核对磁盘状态再决定能否继续；HMR 旧实例不能授权后续分片或覆盖新账本。已经持久认领但结果未知的键不会自动重发。故障恢复验证使用隔离数据，未对真实账本注入故障。详见 [Remote Ops 生命周期](plugin-sources/dsh-remote-ops/README.md#生命周期与管理)。

**Iteration 06（历史部署，Agent I/O test.6，已由 Iteration 07 取代）：** HITL Bridge：Agent I/O `0.1.0-test.6` 新增内部 HITL Bridge（`conversation.openHITL()`），以原生 `approval/request` 与 `user-questions/request` waterfall 集中接收 QQ Session 的审批与提问（不再修改全局 `userQuestions.ask`），审批提示、提问、下一题与超时提示经 `sendMessage()` 发送，按钮由 Bridge 签发（`message.actions`，其他调用方不能构造）。回应须来自同一 Conversation 的预期作答者、请求仍未完成且 Session 仍为当前并被准入；展示被证明失败时审批为 `unavailable`，结果未知不重发。QQ 只保留 Markdown 渲染、键盘与按钮事件转换；原审批/问答通道与直发路径已删除。可用 `hitl.enabled: false` 关闭（交回原生 Web/Desktop）。真实 QQ 按钮与手机端未验收。

**Iteration 05（已授权部署，Agent I/O test.5，已由 Iteration 06 取代）：** Commands 与基础 Media 抽离：Agent I/O `0.1.0-test.5` 新增 I/O 内部命令路由（识别、解析、在入站去重范围内一次性认领、路由；执行与授权仍由命令所属插件负责），QQ 的 `/stop`、`/bot-*`、会话命令与 Remote Ops `/ops` 改经该路由（位置仍在并发合并之前，不再用 SDK `slashCommand`）；消息契约新增可选附件描述（图片、语音、视频、文件，区分可信资源与模型可见内容），QQ 入站附件/引用改为标准描述，`qqbot_send_file` 改经 `sendMessage()` 发送（只能发往当前会话，上传与消息分阶段分类，结果未知不重发）。同时修复 Turn 取消控制器的容量淘汰（有在途消息的控制器不再被淘汰）。详见 [Agent I/O](plugin-sources/dsh-agent-io/README.md)。

**Iteration 04（已授权部署，配套 Character Interaction test.9）：** Interaction 出站迁移：Interaction 只生成并提交完整气泡（长回复在生成期间按定稿规则提前提交，其余在 settlement 后提交），QQ 桥接层把每个气泡、等待提示和工具/轮次错误提示都作为一条逻辑消息交给 Agent I/O `sendMessage()`，经 QQ 文本 Adapter 发送；稳定逻辑 ID 关联原生 Session、Turn、回复与气泡，回复目标按原生输入选择，逐片复核权限与当前 Session，`/stop`、插话撤回与 Turn 中止停止未发出的分片，未确认的气泡不重发且扣留同回复后续气泡。Interaction 专属的 QQ SDK Stream 发送路径与普通回复的 SDK 流式输出均已移除（`streaming` 配置项停用）；Agent I/O 公共接口不变（仍为 `0.1.0-test.4`，只有 `sendMessage()`）。详见 [Agent I/O](plugin-sources/dsh-agent-io/README.md)。

**Iteration 03（已授权部署，Agent I/O test.4）：** Agent I/O `0.1.0-test.4` 新增 `openConversation()`：平台无关的 Conversation 接线把入站交接（Conversation Manager `getOrCreate` → `isCurrentSession` → 原生 `UserMessage` → Interaction `intervene`/`followup`）与出站可信路由（Manager 当前记录 + `isCurrentSession`，每个分片前复核）收在一处，出入站共用 `{platform, accountId, conversation}` 引用。QQ Official 入站、出站文本 Adapter、显式更正与 `/stop` 已改用它，原 QQ 内的重复交接与三处 Interaction 查询已删除；Session Key、持久状态与 Character 包装不变。详见 [Agent I/O](plugin-sources/dsh-agent-io/README.md#openconversationoptions--conversationiteration-03)。

**Iteration 02（已配套 Character test.24 授权部署）：** 普通聊天入站改经 Agent I/O `0.1.0-test.3` 的 `openInbound()`：QQ Adapter 标准化 → I/O 按平台/账号/Conversation/消息 ID 去重（并发重复也只交接一次）→ 可信会话入口（同一访问配置复核 → Conversation Manager → 原生 followup 或 Interaction intervene）。命令、问答、审批、附件预处理与 Character Owner 准入不变。

**Iteration 01（已配套 Character test.24 授权部署，现为 Agent I/O `0.1.0-test.3`）：** 新增独立 [Agent I/O](plugin-sources/dsh-agent-io/README.md) `0.1.0-test.2`，提供与 QQ SDK 解耦的 `sendMessage()`；未绑定 Interaction 时的普通文本出站（回复、Streaming 静态降级、工具错误、轮次错误提示）改经它交给 QQ Official 文本 Adapter。每条消息带由原生事件派生的稳定 ID（重复事件/settlement 只发一次，同 ID 异内容判冲突），并关联原生 Turn：`/stop` 或被取消的 Turn 不再发出未开始的输出。发送前按 Conversation Manager 的 `isCurrentSession` 与访问配置复核。QQ 补丁原生依赖该服务，需与 Manager 成套安装；Interaction、审批/问答和通知的发送路径本轮未变。

**当前源码配套 Character test.22 / Manager test.2：** 恢复只接受原生同 Session 的缺失错误；关闭等待旧句柄并显式报告失败。已配套 Character test.23 / Interaction test.8 在现有 rc.3 实例授权部署，单一 QQ Gateway 健康；手机验收仍待完成。 新增独立 [Conversation Manager](plugin-sources/dsh-conversation-manager/README.md) `0.1.0-test.1`。最新 QQ 补丁原生依赖该服务，必须成套安装；下面的 test.14～test.20 是历史部署记录。路由由 Host 显式配置 `stateFile`；上线前审查旧提醒、任务及通知账本，禁止用空文件静默替代旧路由。

源码提供默认关闭的 [QQ 主 Session 生命周期](docs/GENERIC-INTEGRATION.md#可选主-session-生命周期)：真实 Host 重启或 12 小时无用户输入后，下次安全交互创建空白根 Session，不 Fork 聊天。繁忙、审批和已有提醒有保护，启动预热不算用户输入。test.13 首次部署并启用，test.14 保留；真实 QQ 收件与手机验收仍待完成。

配套 test.14 的补丁已部署，增加 Host 当前 Session 核验及 rc.2 模型切换适配：Session/模型偏好原子提交，失败保留原路由；供 Character 将历史根收窄为提醒用途。QQTK 本身不增加 Character、Memory 或 Remote Ops 依赖，详见[生命周期契约](docs/GENERIC-INTEGRATION.md#可选主-session-生命周期)。

本仓库是扩展源码与维护材料，不包含 DSH 本体，也不是一键安装器。当前 Character 集成实例已验证 **Windows、DSH 0.2.1-rc.2、QQ Bot 0.5.2**；Remote Ops 为 **1.1.1-test.1**。原独立接入基线为 0.2.0-rc.2，新版本的适配范围与限制见 [兼容说明](docs/DSH-0.2.1.md)。其他版本和平台需要重新验证。

本次增加 [Interaction 可选适配](docs/INTERACTION.md)，Remote Ops 为 **1.1.1-test.1**。它不强制安装 Interaction；没有该插件时沿用原 QQ 流程。配套 Character 实例已部署，原生 Session 恢复和单 Gateway 检查通过；手机验收单独记录。仓库旧恢复包不包含这些新增改动。

当前配套 Interaction **0.1.0-test.5**：支持默认 8 秒无自然回复发送确认提示（5.5 秒起由 Agent 侧插件经原生模型生成 Persona 风格短句，QQTK 只负责发送）、长结果语义分泡与只观察的 SDK 回执钩子。QQ 配置 `deliveryDiagnostics:true` 可开启限量脱敏投递关联日志，默认关闭；不需要开启 debug，不保存私聊正文或原始身份。QQ 补丁与 Agent 插件须同步更新；重复完整气泡仍待真实复现，详见 [Interaction 契约](docs/INTERACTION.md)。已配套并部署 Interaction **0.1.0-test.6**：回复按输入 ID 选择 QQ 回复目标、Worker 续轮投递、运行期新消息交给 Interaction 的 intervene 处理（入站不再等待整轮结束），并补充回退失败与抑制来源诊断。

后续[Interaction 隔离审计](docs/AUDIT-INTERACTION-test10.md)的复现问题已进行[修复及隔离复测](docs/INTERACTION-AUDIT-FIXES.md)。36/36 自动测试及 10/10 SDK 边界测试通过；新增 qqbot-nodejs 1.0.5 补丁，须与 QQ Bot 补丁配套。已随 Character test.11 部署，新宿主及 QQ ready 检查通过；实机投递、完整 HMR 与生产回滚演练尚未验收。

## 按需使用

| 你需要什么 | 使用哪些部分 |
|---|---|
| QQ 对话、消息发送、审批与问答 | QQ Bot 0.5.2 + 配套补丁 + 独立 Conversation Manager + 独立 Agent I/O；无需 Remote Ops |
| Owner 专属 `/ops`、任务观察、通知记录 | 在基础 QQ 上增加 `dsh-remote-ops-local`，配置 Owner 和状态目录 |
| 远程备份、候选验证、部署、重启 | 再接入可信维护后端；仓库提供的是原 Windows 部署后端 |
| Character 与分层长期记忆 | 使用独立的 [Character Agent](https://github.com/EJYDOvO/character-agent-v1) 项目；不是 QQTK 的安装前提 |

QQ Gateway 负责连接、Sender、审批/问答的 QQ 渲染与按钮事件转换，并注册 QQ Official 文本 Adapter；Agent I/O 的 HITL Bridge 负责审批/问答的关联、可信回应与生命周期；Conversation Manager 负责 Session 路由与生命周期；Agent I/O 负责逻辑消息的顺序、取消、去重和发送结果。Remote Ops 接入同一套 Gateway，不创建第二条 QQ 连接；Identity 另行负责授权。

## 仓库结构

```text
maintenance/
  qqbot-src/                 # 维护中的 QQ 兼容代码
  qqbot-upstream-0.5.2/       # 对应上游文件与哈希，供比对和重建补丁
  patches/                   # 包管理器应用的版本化补丁
  browser/0.0.83/            # 可选 Playwright MCP 的固定清单和配置
  *.ps1 / *.cjs / *.mjs      # Windows 维护后端、验证和测试
plugin-sources/
  dsh-agent-io/              # 独立、平台无关的统一出站 sendMessage() Host 插件
  dsh-conversation-manager/  # 独立、平台无关的路由/生命周期 Host 插件
  dsh-remote-ops/            # 独立运维插件，自带默认禁用的 Bundle
  dsh-task-memory/           # 旧项目记忆的适配源码，可选
plugin-packages/             # 明确允许发布的小型固定版本包，含回滚旧版本
templates/                   # 脱敏的配置示例与旧 Profile 快照
scripts/                    # 源码导出及脱敏检查
docs/                       # 通用集成、恢复和仓库管理说明
licenses/                   # 第三方许可
```

`dsh-task-memory` 是旧的项目记忆组件，**不是 Character 的 L1/L2/L3 Memory Core**。浏览器、旧记忆和 Bilibili 恢复包都属于可选或历史部署材料，不需要为基础 QQ 全部安装。`qqbot-approval` 仅保留早期修复参考，新补丁从 `qqbot-src` 构建。

## 从哪里开始

| 你的目标 | 阅读入口 |
|---|---|
| 为普通 DSH Agent 接入 QQ | [通用集成与最小配置](docs/GENERIC-INTEGRATION.md) |
| 配置独立 Remote Ops 或自有维护后端 | [Remote Ops 接口与配置](plugin-sources/dsh-remote-ops/README.md) |
| 管理原 Windows 部署的开关和数据 | [功能管理](maintenance/FEATURES.md) |
| 执行 Stage、部署、备份与恢复 | [Windows 维护手册](maintenance/README.md) |
| 恢复原部署扩展 | [恢复边界与步骤](docs/RESTORE.md) |
| 导出源码或向 GitHub 发布 | [仓库管理](docs/REPOSITORY.md) |

## 接入方式

**仅使用 QQ：** 安装固定版本 QQ Bot、`dsh-agent-io` 和 `dsh-conversation-manager`，应用两份配套补丁，在 QQ 前声明 Agent I/O 与 Manager，再配置唯一 QQ 条目与目标 Preset。完整示例见 [通用集成](docs/GENERIC-INTEGRATION.md)。

- 保留由宿主提供的 DSH 核心依赖，使用 `autoInstallPeers: false`。
- QQ 凭据与 Owner 白名单只保存在本机安全配置中；示例占位符不能直接使用。
- 每个独立项目配置自己的绝对 `DSH_HOME`。同一 QQ 应用凭据只能有一个活跃部署。
- 不要同时启用 QQ Bundle 又手动插入另一套 QQ 插件。

**增加 Remote Ops：** 安装已审查并固定哈希的包（现有部署记录为 1.1.1-test.1），配置 `ownerId`、绝对 `stateDirectory`，并在 QQ Gateway 之前加载。包自带的条目默认禁用，安装成功不等于已经启用；修改现有条目或自行装配，避免重复声明。

Remote Ops 有三种后端方式：

| 方式 | 配置与能力 |
|---|---|
| 独立模式 | Owner + 状态目录；提供主会话观察/停止和通知去重，不依赖 Windows 维护脚本 |
| 自有 Host 后端 | `backend: service`，由可信 `qqMaintenance` 服务实现项目维护动作 |
| 原 Windows 后端 | 显式设置 `root`，使用原安装目录的维护脚本、Owner 配置和账本 |

增删 Remote Ops 后应重载 QQ 或重启 Profile；当前没有运行中热插拔发现机制。不要直接复制旧 `templates/profile` 当作新项目安装方案，其中包含历史依赖与路径约定。

## 本地检查与补丁维护

使用 Node.js 22 或以上，在仓库根目录执行：

```sh
npm test
node maintenance/build-qqbot-patch.cjs --check
```

这些检查无需安装 DSH SDK。`npm test` 只运行根 `package.json` 声明的轻量测试，并不覆盖全部 QQ、审批、浏览器或真实模型验证。

修改 QQ 兼容代码时，在 `maintenance/qqbot-src` 中修改后运行：

```sh
node maintenance/build-qqbot-patch.cjs
node maintenance/build-qqbot-patch.cjs --check
```

完整回归需要匹配的安装环境与候选 Profile；执行前阅读维护手册。升级上游 QQ 版本必须重新比对上游文件、调整补丁并验证，不能把 0.5.2 补丁直接用于任意版本，也不要修改官方 DSH 发行文件或临时手改 node_modules。

## 权限、可靠性与部署边界

- 当前只验收单 Owner 私聊，群聊关闭。入口白名单不是多用户数据隔离，也不替代 Agent 的工具权限和审批。
- 同进程 Gateway 租约防止重复实例；跨进程、跨机器的单活仍由部署管理负责。
- 通知账本中的发送成功仅表示 API 成功；未知结果不盲目重放。QQ ready 也不代表手机已收件或审批按钮已验证。
- Windows 守护需要用户登录和正确注册任务，不是无人登录的系统服务；macOS 迁移未验证。
- 旧维护后端的自动恢复主要覆盖 Profile，不能代替官方本体回滚、业务数据恢复或 Character 数据库迁移。Character 应使用自身经过审阅的部署流程。
- 本仓库不保存 QQ/API 凭据、真实 Owner、聊天、记忆数据、浏览器登录状态、日志或备份。GitHub 更新不会自动部署到运行实例。

已做过的验证和当时限制见 [通用接口验收](docs/GENERIC-INTEGRATION.md#实际验证) 与 [历史维护验收](maintenance/TEST-REPORT.md)。仓库源码、默认配置与某台机器的实际部署状态应分别核对。

第三方文件保留原许可，见 `licenses/` 和各插件目录。功能、配置或操作方式变更时，同步维护本 README 及对应专题文档，明确区分通用能力、旧部署约定和实际验证范围。

### 官方更新后的运行目录

自有维护脚本通过 `maintenance/runtime.cjs` 选择官方运行目录，数据/Profile 仍保留原位置。可在本地 `data/maintenance/host-runtime.json` 配置 `{ "schemaVersion": 1, "runtimeRoot": "<absolute official install directory>" }`，也可用可信 Host 环境变量 `DSH_CHARACTER_HOST_ROOT` 或 `DSH_RUNTIME_ROOT` 显式覆盖。配置文件不提交仓库；含 BOM 的 Windows JSON 可读取，损坏或相对路径直接拒绝。

`start-desktop.ps1`、维护重启/守护和 ASAR 审查使用同一选择，候选同时封存目录与哈希，目录变化后需重新验证。先停止旧宿主再切换，不复制或修改官方发行文件，不并行启动两个 QQ Gateway。运行时兼容已在 DSH rc.3 完成隔离与单实例验证，原 QQ Bot 0.5.2 / SDK 1.0.5 补丁保持不变；修改前应备份本机维护策略，确认后仅更新实际 `testedRuntime`，不要用仓库历史策略模板覆盖本机包版本、Owner 或产物 pin。
