# 本轮插件安装审查

2026-10-13，目标为官方 Harness 0.2.0-rc.2。来源元数据另见本目录 JSON，部署固定版本与本地归档 SHA-256 见 ../plugin-policy.json。

| 组件 | 安装前核对 | 决定与维护边界 |
|---|---|---|
| dsh-remote-ops-local 1.0.0 | 本地独立源码、无第三方运行依赖；所有者校验、群禁用、维护队列、持锁更新、通知投递记录 | 不改本体；QQ 8 文件正式补丁声明服务依赖。禁止只删除运维包而留下桥接依赖 |
| dsh-task-memory-local 0.1.0-local.2 | 上游固定 Git 提交、MIT 许可、peer 合约、存储路径、工具输出；上游仅支持 0.1.x 的包曾被宿主拒绝 | 独立命名适配当前核心；修复 recall/search 缺少正文。关闭自动提示注入。记忆 taskId 是组织边界，不是用户授权边界 |
| @playwright/mcp 0.0.83 | npm 官方包、tarball SHA-512 与 registry 一致、锁定直接及传递依赖、未执行安装脚本；依赖审计当时为 0 条漏洞 | 3 个包，Playwright 依赖实际为 1.64.0-alpha-1790635538000；使用现有 Edge。保留版本目录、独立登录目录，升级另建目录测试，不能保证未来持续无漏洞 |
| 现有 QQ/搜索/市场/Bilibili | 保留精确已审查版本和既有 Bilibili 本地 tgz 来源 | 未因本轮扩展追随 latest；不额外安装多 Agent 编排插件 |

安装策略：固定来源 → 审查差异/依赖/权限/许可 → 独立源码和新版本包 → Stage → 真实宿主工具验收 → DeployValidated → 就绪检查。安装关闭 lifecycle scripts；保持 autoInstallPeers=false，由桌面本体提供核心 SDK。候选摘要包含配置、补丁、策略、维护脚本、浏览器锁文件与本体哈希；任何变化要求重新 Stage。

记忆插件的独立 Node smoke 脚本在未安装开发 SDK 时因缺少 dsh-home-paths 失败，这不计为通过。实际验收使用带当前 SDK 的隔离 Harness 宿主；开发源码重编译的边界见插件源码中的 LOCAL-MAINTENANCE.md。当前未完成更新到其他核心版本的兼容验证。
