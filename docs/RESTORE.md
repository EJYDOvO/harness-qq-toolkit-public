# 恢复部署

本文用于恢复原 Windows 部署的扩展，不是新项目的最小安装指南。新项目先阅读 [通用集成](GENERIC-INTEGRATION.md)，仅选择需要的组件；Character 项目应使用其自身部署/数据库恢复流程。

仓库只保存扩展，无法独立启动 Harness。旧路径模板为 `D:/DeepSeek-Harness`，验收基线为 `0.2.0-rc.2`。其他版本或路径须修改配置并重新验收；不能直接覆盖正在运行的安装目录。

1. 从官方渠道安装相应 Harness 桌面版本，先通过官方 UI 配置模型并完成 QQ 绑定，确保基本对话正常。QQ openid 不等于 QQ 号码；先取得实际私聊 openid。
2. 退出宿主并暂停既有 watchdog，备份原 profile。复制仓库的 `maintenance`、`plugin-sources` 和 `plugin-packages` 到安装根目录；工作区约定由本机独立维护并保留。
3. 对照 `templates/profile/package.json`、锁文件和 pnpm-workspace.yaml 恢复插件声明。它们包含固定本地包的绝对路径；更换目录时必须相应调整。将 `maintenance/patches` 复制到 profile 的 `patches`。**不要把示例 YAML 整体覆盖到含凭据的现有 profile。**
4. 根据 `templates/profile/cordis.patch.example.yml` 合并 QQ 白名单、Creator、子 Agent 限制和记忆配置。QQ appId、appSecret 和模型 API 凭据仅在本机填写。将 `templates/owner.example.json` 填好后保存为 `data/maintenance/owner.json`；核对 owner 与唯一私人白名单一致。设置正确后再取消 QQ disabled。模型提供方配置不会从此仓库恢复，继续在官方 UI 管理。
5. 浏览器目录只含清单，先用本体自带 pnpm 在 `maintenance/browser/0.0.83` 执行 `install --frozen-lockfile --ignore-scripts`，确保本机 Edge 已安装。登录目录和输出目录由 config.json 控制。调用 `ops.cjs configure-features` 前需已具备 profile 的 js-yaml 依赖；该命令添加浏览器桥接并按 features.json 应用开关。
6. 使用本体自带 pnpm 安装 profile 的固定锁文件，关闭安装脚本并保持 `autoInstallPeers: false`。第一次恢复需要从 npm 获取官方包；本地 tgz 已随仓库保存。缺少依赖或锁文件不一致时停止排查，不关闭校验继续。
7. 启动后运行 Doctor、Stage，确认 QQ ready，实测 `/ops status`、审批、多 Agent、记忆和浏览器；通过后用 `autostart.ps1 -Action Enable` 注册当前用户登录守护。完整操作见维护手册。

若保留原安装位置，优先使用本机已验证的 profile 备份恢复，GitHub 用于恢复源码和维护能力。聊天历史、记忆 vault、凭据和浏览器登录资料需要另行保存的本地私密备份，此仓库不包含这些数据。

记忆开发包的原始开发锁与当前运行 SDK 的区别见 `plugin-sources/dsh-task-memory/LOCAL-MAINTENANCE.md`；不要直接用上游旧开发锁重建生产包。
