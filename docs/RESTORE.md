# 干净安装、数据迁移与回滚

源码和用户数据分开迁移。以下命令只用于新目录；不要对运行中的原目录运行 prepare/restore。默认单 Owner 私聊，不开启群聊。Windows / DSH 0.2.2-rc.1 / Node 24 是原生验证目标；Mac/Linux 的 GUI、原生权限、旧 Session 路径迁移尚未验收。

## 1. 安装公开依赖

自行安装官方 DSH 0.2.2-rc.1 与 Node 24。两个源码目录独立：

```sh
git clone https://github.com/EJYDOvO/harness-qq-toolkit-public.git
git clone https://github.com/EJYDOvO/character-agent-v1.git
cd harness-qq-toolkit-public
npm ci
npm test
npm run test:audit
npm run test:patch
cd ../character-agent-v1
npm ci
npm test
npm run test:audit
```

根 package-lock.json 固定构建依赖及 QQ/SDK 下载完整性。pnpm 11.7.0 来自本地锁定依赖，不依赖开发机全局 pnpm 或旧 Profile。schemastery 3.18.5 仅用于测试依赖；DSH SDK 由 0.2.2-rc.1 发行包提供，不另装第二套 Core。

## 2. 创建私有配置

复制 Character 的 `examples/portable.config.example.json` 或普通 QQ 的 `templates/portable.config.example.json` 到仓库外。填写：官方 runtimeRoot、Profile 名称、模型 provider/id/baseURL/input、真实 appId 和唯一 Owner OpenID。runtimeExecutable/resourcesDirectory 可覆盖非标准发行布局。Character 另外设置私有 Persona YAML、projectId、dataDirectory（Home 内相对目录）和可选插件。

只填环境变量名称 `MODEL_API_KEY`/`QQ_APP_SECRET`，密钥值放本地 .env，不填入公开模板。使用新的独立 Home；不要指向现有生产 Home。qq.enabled:false 可用于完全不连 QQ 的装配验证，模型调用同样需要独立授权。

## 3. 构建及安装

下面将占位符替换为绝对路径，命令在 Character 仓库执行：

```sh
node scripts/portable.cjs prepare --qqtk <QQTK_CLONE> --config <PRIVATE_CONFIG> --home <NEW_HOME>
node scripts/portable.cjs install --qqtk <QQTK_CLONE> --home <NEW_HOME>
node scripts/portable.cjs verify --qqtk <QQTK_CLONE> --home <NEW_HOME>
```

普通 QQ 在 QQTK 执行同样命令，省略 --qqtk。prepare 读取官方 Creator 并生成四个运行插件、Core 和选定的可选包；不修改官方文件，不读取原 Profile。生成包及其 SHA-256、相对 file: 依赖和两份补丁进入新 Home；保留这些本地产物作为升级/回滚依据。

install 首次从注册表安装固定版本，随即进行冻结锁/离线复验。新 Home 内的 Profile/pnpm-lock.yaml 是该次完整依赖锁；升级与回滚必须连同包、补丁和私有配置一起保管。注册表不可用且没有完整缓存时安装会失败，不静默换版本。

## 4. 用户数据备份与恢复

必须先停止旧 Host、Gateway、watchdog 和所有使用同一数据目录的进程。新 portable start 为前台官方 Host，结束时按 Ctrl+C；操作锁仍存在时 backup/restore 拒绝运行。崩溃后锁不自动删除：先由管理员证实无进程使用该 Home，再人工解除。脚本无法证明由其他启动器私自打开的 Host 已停止。

```sh
node scripts/portable.cjs backup --home <STOPPED_PORTABLE_HOME> --out <NEW_PRIVATE_BACKUP>
node scripts/portable.cjs restore --home <NEW_PREPARED_HOME> --backup <PRIVATE_BACKUP>
```

Character 在上述命令追加 --qqtk。备份独立保存 sessions、storages（含原生 Schedule）、qqbot、remote-ops、Character 数据（Memory、coordination、Outbox、binding、路由）及 .env/.credentials.yaml；包含敏感信息，不上传 Git。逐文件 SHA-256，拒绝符号链接与越界路径。恢复先完整验证，不覆盖不同内容的目标文件，不还原旧 Profile。

应用账号、Owner、Character ID、projectId 和数据布局必须一致；不重算 principal/namespace/Conversation/Session/通知 ID。新设备上模型和 Preset ID 应保持一致。unknown/partial/sending 记录按原实现安全恢复，禁止清空账本或主动重试来“修复”缺失通知。

**旧版自定义布局**不自动导入：先离线盘点其实际 stateFile、database、Session/Schedule/storageDomain、外置工作目录及维护账本，按官方机制制作一致快照。新工具只处理已声明的 portable Home，不能用它假装完整备份任意旧安装。绝对路径写入过的 Session cwd、附件或工具配置需逐项检查；不能批量替换持久文件中的 ID/路径。跨操作系统恢复尚未获证实。

恢复是复制，不是同步；中途 I/O 失败保留原备份，勿启动未通过完整复验的目标。同一份备份只能启动一套连接同账号的 Host。

## 5. 启动与验收

在新 Home 创建本地 .env（参照 templates/env.example），审查权限后执行 `node scripts/portable.cjs start --home <NEW_HOME>`；Character 追加 --qqtk。使用官方原生 Web/Desktop 登录，不在源码中存登录 URL。命令前台运行，Ctrl+C 停止；不要并行运行另一个 Gateway。

先 verify，再核对本机日志中的插件装配与错误：I/O、Manager、唯一 QQ Gateway、Identity/Memory 与目标 Preset；可选 Inspector 默认 writable:false。检查当前路由和历史提醒归属，Schedule 任务 ID/规则/Session、Outbox 各终态、Memory 修订/遗忘屏障数量与备份一致。Owner/跨 Session 权限、Worker 原生 Spawn、取消、Compaction 和审批另行验收。

无真实 QQ 的隔离接口验证不等于手机验收。首次连接真实 QQ 前核查未完成任务及已到期 Schedule；不能通过试发 unknown 通知验证。

## 6. 升级与回滚

在另一个新 Home/候选 Profile 中构建安装，核验接口、包哈希和锁文件，离线数据副本先跑恢复测试。正式切换须另获授权并停净原实例；旧版代码若不理解新增终态或 Schema，应阻断回滚。

已有旧 Windows 布局实例升级维护后端时，保留该实例自己的 `maintenance/features.json`、`plugin-policy.json` 与 `maintenance/browser/` 运行包，只更新代码文件。仓库中的 features.json 是新安装模板（Task Memory/Browser 默认关闭）；用它覆盖已启用 Browser 或 Memory 的实例会在下次 apply 时关闭这些功能。切换前对比新旧开关，确认一致后再重新 Stage。

回滚保留**最新** Memory、Session、Schedule、路由和去重账本，只切回兼容的旧代码/包/补丁/私有配置。DSH 0.2.2 写入 Schedule 后存储为 v2，0.2.1 宿主无法加载；此后不能把宿主单独降回 0.2.1，只能在维护者明确决定时整体恢复切换前快照（会丢失窗口内新增数据）。能否只换回宿主不凭 Schedule 文件哈希判断：Character 的 `scripts/rollback-gate.mjs` 在快照时记录、回滚前只读比对存储单元版本、Session 格式、SQLite Schema 与逻辑内容（含 WAL）、Outbox 和任务账本，给出允许 / 需旧宿主隔离加载验证 / 拒绝三种结论。切换前检查隔离新版候选 Profile，切换后检查实际 Profile，具体命令见下文；旧实例不应通过新版 testedRuntime 检查。不用旧数据快照覆盖新增记录。官方 DSH 自身的安装/降级由官方渠道管理，本仓库不修改 ASAR 或内置 Bundle。

SDK/Interaction 跨仓库审计需要 Character 源码：在非默认相邻目录时设置 DSH_CHARACTER_PROJECT 为其绝对路径。仅为测试依赖，不是 QQTK 运行依赖；CI 固定检出兼容 Character 提交，更新接口时同步审查该固定点。


### 部署门禁补充：候选与实例分离

切换前只检查隔离候选：

```sh
node <QQTK>/maintenance/pin-check.mjs --phase pre-switch --runtime <TARGET_HOST> --profile <CANDIDATE_PROFILE> --instance-profile <INSTANCE_PROFILE>
```

旧实例保留旧 testedRuntime；候选的 plugin-policy.json 须经维护者审阅，明确 schemaVersion、profile、testedRuntime、精确 targets、qqPatch 和 localPackages。不要为通过校验而修改旧实例，也不要用模板覆盖实例策略。

另行批准切换后，检查实际实例：

```sh
node <QQTK>/maintenance/pin-check.mjs --phase post-switch --runtime <TARGET_HOST> --profile <INSTANCE_PROFILE>
```

两阶段均严格检查目标版本、补丁 pin/文件哈希和已安装文件；工具没有安装、修改策略或切换能力。

回滚门禁使用格式版本 2 清单。停机维护锁下 record，check 使用完全相同的绝对 Home、全部 --sqlite 与 --file 参数；不得省略或替换监控路径。新增、修改、删除 Session/记录域/记录/状态文件均计入，Schedule 版本及 SQLite Schema 前进、损坏、缺失或无法确定状态均拒绝。指定 --file 是 JSON 状态文件。旧清单须重新从一致快照生成，不能编辑为通过。SQLite 主文件和 WAL 按一致快照保管；WAL 内容变化也需回放验证。

allowed（退出 0）只表示监控状态完全未变；needs_replay（2）须复制当前数据到隔离旧 Host 验证；refused（3）不得只换宿主。任何可能丢失新增数据的整体快照恢复均须维护者单独明确决定，默认向前修复。


## 自定义模型预算门禁（0.2.2）

升级前须为每个自定义模型显式设置 contextWindow 和 maxTokens，不能依赖宿主默认 1M/128K。两者是模型/路由上限；每次请求仍由原生 SDK 根据输入估算和安全余量动态裁剪。不要将所有模型统一固定为 8192，也不要依据模型名称猜容量。

QQTK 的只读能力探测（只输出 policy/diff，不写 Profile；当前支持环境凭据的 OpenAI-compatible /models）：

```sh
node <QQTK>/maintenance/model-budget-probe.mjs --profile <PROFILE> --home <HOME> --provider <PROVIDER> --runtime-version 0.2.2-rc.1
```

它拒绝缺少容量、非法容量、重复路由、超大响应和重定向。可先使用 DSH Models 页原生发现；其他协议或凭据方式使用原生发现并人工审核。探测结果须经管理员审核再应用，仅将差异字段添加到现有模型对象，不覆盖提供商、凭据或输入模态。无法发现容量时填写经复核的手动声明，source=reviewed-manual，不能随意补默认值。

将配套 model-policy.json 放在目标 Profile，包含 schemaVersion=1、profile、testedRuntime、maxAgeDays（默认30，最多90）以及模型记录（provider/id/contextWindow/maxTokens/endpointSha256/source/observedAt）。策略不含密钥或明文服务地址。端点、模型集合、数值、目标运行时或 Profile 名称改变，均须重新复核；证据过期须重新探测或人工核实，不应只修改日期。

```sh
node <QQTK>/maintenance/model-budget-check.mjs --profile <PROFILE> --runtime-version 0.2.2-rc.1
```

pin-check 的 pre-switch/post-switch 已调用此门禁；模型定义存在但缺少策略或预算时失败。候选与实际 Profile 的策略 profile 字段应各自匹配目录名。检查全程只读，不发网络请求、不安装插件、不修改配置。没有声明自定义模型的官方内置目录无需此实例策略。

portable 配置的 model 对象可显式传入 contextWindow、maxTokens、observedAt、capabilitySource；prepare 会保留这些数字并生成配套策略。未提供预算的旧 prepare 输入不会被自动填值，切换前 pin-check 会拒绝它。新安装也必须运行此门禁，不能只用 portable verify 的包校验代替。

静态文件检查不等于运行时已加载：配置应用后还须用已认证 Settings describe 比较有效值，并做隔离原生模型请求，确认 request/context 的窗口与实际发送的输出预算符合预期。直接由第三方插件覆盖输出参数的路径不属于此配置门禁的强制拦截范围，未改宿主/SDK。

回滚仅恢复本次模型配置与 model-policy.json；不恢复 Session、Memory、Schedule 或数据库快照。真实模型测试单独授权、使用合成数据，不将手机收发或原生审批视为已验证。
