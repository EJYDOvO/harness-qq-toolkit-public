# Harness QQ Toolkit

为 DeepSeek Harness 提供 **QQ 接入兼容补丁、可选 Remote Ops 插件和维护工具**。普通 DSH Agent 可以独立使用 QQ 接入，不需要 Character Agent、角色 Preset 或记忆插件。

**开发候选，未部署：** 新增独立 [Conversation Manager](plugin-sources/dsh-conversation-manager/README.md) `0.1.0-test.1`。最新 QQ 补丁原生依赖该服务，必须成套安装；下面的 test.14～test.20 是历史部署记录。路由由 Host 显式配置 `stateFile`；上线前审查旧提醒、任务及通知账本，禁止用空文件静默替代旧路由。

源码提供默认关闭的 [QQ 主 Session 生命周期](docs/GENERIC-INTEGRATION.md#可选主-session-生命周期)：真实 Host 重启或 12 小时无用户输入后，下次安全交互创建空白根 Session，不 Fork 聊天。繁忙、审批和已有提醒有保护，启动预热不算用户输入。test.13 首次部署并启用，test.14 保留；真实 QQ 收件与手机验收仍待完成。

配套 test.14 的补丁已部署，增加 Host 当前 Session 核验及 rc.2 模型切换适配：Session/模型偏好原子提交，失败保留原路由；供 Character 将历史根收窄为提醒用途。QQTK 本身不增加 Character、Memory 或 Remote Ops 依赖，详见[生命周期契约](docs/GENERIC-INTEGRATION.md#可选主-session-生命周期)。

本仓库是扩展源码与维护材料，不包含 DSH 本体，也不是一键安装器。当前 Character 集成实例已验证 **Windows、DSH 0.2.1-rc.2、QQ Bot 0.5.2**；Remote Ops 为 **1.1.1-test.1**。原独立接入基线为 0.2.0-rc.2，新版本的适配范围与限制见 [兼容说明](docs/DSH-0.2.1.md)。其他版本和平台需要重新验证。

本次增加 [Interaction 可选适配](docs/INTERACTION.md)，Remote Ops 为 **1.1.1-test.1**。它不强制安装 Interaction；没有该插件时沿用原 QQ 流程。配套 Character 实例已部署，原生 Session 恢复和单 Gateway 检查通过；手机验收单独记录。仓库旧恢复包不包含这些新增改动。

当前配套 Interaction **0.1.0-test.5**：支持默认 8 秒无自然回复发送确认提示（5.5 秒起由 Agent 侧插件经原生模型生成 Persona 风格短句，QQTK 只负责发送）、长结果语义分泡与只观察的 SDK 回执钩子。QQ 配置 `deliveryDiagnostics:true` 可开启限量脱敏投递关联日志，默认关闭；不需要开启 debug，不保存私聊正文或原始身份。QQ 补丁与 Agent 插件须同步更新；重复完整气泡仍待真实复现，详见 [Interaction 契约](docs/INTERACTION.md)。已配套并部署 Interaction **0.1.0-test.6**：回复按输入 ID 选择 QQ 回复目标、Worker 续轮投递、运行期新消息交给 Interaction 的 intervene 处理（入站不再等待整轮结束），并补充回退失败与抑制来源诊断。

后续[Interaction 隔离审计](docs/AUDIT-INTERACTION-test10.md)的复现问题已进行[修复及隔离复测](docs/INTERACTION-AUDIT-FIXES.md)。36/36 自动测试及 10/10 SDK 边界测试通过；新增 qqbot-nodejs 1.0.5 补丁，须与 QQ Bot 补丁配套。已随 Character test.11 部署，新宿主及 QQ ready 检查通过；实机投递、完整 HMR 与生产回滚演练尚未验收。

## 按需使用

| 你需要什么 | 使用哪些部分 |
|---|---|
| QQ 对话、消息发送、审批与问答 | QQ Bot 0.5.2 + 配套补丁 + 独立 Conversation Manager；无需 Remote Ops |
| Owner 专属 `/ops`、任务观察、通知记录 | 在基础 QQ 上增加 `dsh-remote-ops-local`，配置 Owner 和状态目录 |
| 远程备份、候选验证、部署、重启 | 再接入可信维护后端；仓库提供的是原 Windows 部署后端 |
| Character 与分层长期记忆 | 使用独立的 [Character Agent](https://github.com/EJYDOvO/character-agent-v1) 项目；不是 QQTK 的安装前提 |

QQ Gateway 负责连接、Sender、审批/问答展示；Conversation Manager 负责 Session 路由与生命周期。Remote Ops 接入同一套 Gateway，不创建第二条 QQ 连接；Identity 另行负责授权。

## 仓库结构

```text
maintenance/
  qqbot-src/                 # 维护中的 QQ 兼容代码
  qqbot-upstream-0.5.2/       # 对应上游文件与哈希，供比对和重建补丁
  patches/                   # 包管理器应用的版本化补丁
  browser/0.0.83/            # 可选 Playwright MCP 的固定清单和配置
  *.ps1 / *.cjs / *.mjs      # Windows 维护后端、验证和测试
plugin-sources/
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

**仅使用 QQ：** 安装固定版本 QQ Bot 和 `dsh-conversation-manager`，应用两份配套补丁，在 QQ 前声明 Manager，再配置唯一 QQ 条目与目标 Preset。完整示例见 [通用集成](docs/GENERIC-INTEGRATION.md)。

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
