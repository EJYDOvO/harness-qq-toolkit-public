# 维护后端与验证工具

新安装使用 [portable 流程](../docs/RESTORE.md)。本目录保留 QQ/SDK 补丁输入、构建器、重要回归和原 Windows 维护后端；不是复制到任意机器就可安全执行的完整安装器。

Remote Ops 可以独立运行，不要求本目录中的进程控制后端。配置 stateDirectory、Owner，并按需由可信 Host 注入 qqMaintenance。没有后端时控制操作明确拒绝，不回退其他 Agent 或旧 Sender；状态查询与平台连接分开。

manage.ps1 / ops.cjs / stage.cjs / remote.cjs 等仍按旧 Windows root/data/profiles/desktop 布局工作。使用前在独立副本按目标布局审阅并补齐本地 policy/pins；默认不含私人 Owner、旧 tgz 或 Browser 运行包。features.json 的旧 Task Memory/Browser 默认关闭。浏览器如明确启用，必须由部署者另外提供已审查的运行环境；不会自动下载或装配。

Stage 检查固定版本、配置与补丁，切换需要 idle/锁/备份/单活/健康门禁。不得把旧布局脚本指向现有生产目录做迁移验证。源码清理本轮没有部署或触碰运行实例。

独立源码回归使用 npm test（自动临时代码夹具）、npm run test:audit 与 npm run test:patch。offline-gateway.mjs 在新的空 Home 中按 portable 流程安装补丁后的 QQ 包，以本机回环 mock 代替 QQ 接口与模型，验证宿主上的 Gateway 装配和 Session 事件链路（不连接 QQ 服务器，不等于手机送达）。pin-check.mjs 只读核对宿主版本、QQ 包精确版本、补丁键/文件与已安装补丁文件，切换前对目标 Profile 运行。checkpoint.ps1 只提交用户已审阅暂存的本仓库内容，不创建嵌套 Git 仓库或自动 stage 数据。

角色切换：Character 管理插件写 `data/maintenance/character-switch.json`（`{target, previous, requestedAt, nonce}`），watchdog 发现后在维护锁之外同步运行 `manage.ps1 -Action SwitchCharacter`，不计入 `maxStartsPerHour`。流程：`character-switch.cjs pending`（超过 15 分钟或无效的请求记为 `expired`/`invalid` 并丢弃）→ 等 idle → 停 Host → `apply` 改 `data/character-current` 联接 → 启动 → `verify`（`runtime-health.json` 必须来自新进程、目标角色且 `personaSource` 为 `compiled`，最多 20 秒）→ `finish ok`。`apply` 之后任一步失败：停掉本次启动的 Host、`revert` 联接、启动原角色、`finish fail <原因> <restored>`。结果写入 `data/maintenance/character-switch-result.json`；不做 Profile 备份，也不能用 `-Queue`。切换决策全部在 `character-switch.cjs`，只认 `data/characters/<id>` 或 `data/character-<id>` 下含匹配 `binding.json` 的目录。
