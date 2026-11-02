# 干净安装、数据迁移与回滚

源码和用户数据分开迁移。以下命令只用于新目录；不要对运行中的原目录运行 prepare/restore。默认单 Owner 私聊，不开启群聊。Windows / DSH 0.2.1-rc.3 / Node 24 是原生验证目标；Mac/Linux 的 GUI、原生权限、旧 Session 路径迁移尚未验收。

## 1. 安装公开依赖

自行安装官方 DSH rc.3 与 Node 24。两个源码目录独立：

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

根 package-lock.json 固定构建依赖及 QQ/SDK 下载完整性。pnpm 11.7.0 来自本地锁定依赖，不依赖开发机全局 pnpm 或旧 Profile。SDK 3.18.5 指 schemastery；运行时 DSH 服务仍由官方宿主提供，不另装第二套 Core。

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

回滚保留**最新** Memory、Session、Schedule、路由和去重账本，只切回兼容的旧代码/包/补丁/私有配置。不用旧数据快照覆盖新增记录。官方 DSH 自身的安装/降级由官方渠道管理，本仓库不修改 ASAR 或内置 Bundle。
