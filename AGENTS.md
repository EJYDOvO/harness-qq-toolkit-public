# QQTK repository guidance

本文件面向维护仓库的人和编码 Agent。先读 README，再按任务阅读通用集成、Remote Ops 或 Windows 维护文档。`default-workspace/AGENTS.md` 是历史 QQ 工作区样例，不自动成为仓库根目录的行为规则，也不要把它覆盖到用户工作区。

## 组件与修改边界

- QQTK 保持独立的 QQ 补丁、Remote Ops 插件与维护组件集合。基础 QQ 不依赖 Remote Ops、Character Identity、角色 Preset 或记忆插件。
- 不手工修改官方 DSH 发行文件或已安装 node_modules。QQ 兼容变更在 `maintenance/qqbot-src` 维护，以版本化补丁发布；保留匹配的上游快照与许可。
- Remote Ops 的通用接口与原 Windows 后端分开维护。不要让通用入口默认猜测某个私人安装路径、Owner 或维护后端。
- 一个 QQ 应用只保持一套活跃 Gateway、Sender、审批和问答通道。保留 Owner、白名单、nonce、超时、取消和权限校验。
- 旧项目记忆、浏览器和恢复包是可选/历史组件，不把它们写成基础 QQ 的强制依赖，也不等同于 Character 分层记忆。
- 不把源码修改、打包、Git push、发送 API 成功或 mock 测试通过写成生产上线/手机收件已验证。

## 相关改动必须同步维护文档

README 是新用户和新 Agent 的入口，不写成维护流水账。保持项目定位、组件关系、接入前提、操作入口和重要限制清晰；详细接口及历史证据放专题文档。

| 改动 | 同步检查 |
|---|---|
| 能力、依赖、目录、安装入口或主要限制 | README.md |
| 基础 QQ 接入、生命周期、兼容要求 | docs/GENERIC-INTEGRATION.md |
| Remote Ops 配置、默认值、命令、维护后端契约 | plugin-sources/dsh-remote-ops/README.md |
| Windows 开关、路径、Stage/部署/恢复/守护 | maintenance/FEATURES.md、maintenance/README.md、docs/RESTORE.md |
| 导出规则、发布目标、脱敏流程 | docs/REPOSITORY.md |
| 实际验收 | 对应报告；注明环境、模拟部分及未验证事项 |

- 区分源码默认、示例和实例当前状态。旧部署手册必须标出适用范围，不把它的模型、Preset、路径和自启动状态当作通用默认。
- 保留历史测试报告的当时语境；修正文档入口的过时结论。示例只用占位符。
- 每次提交前检查文档影响；无用户可见变化的内部修改无需为了形式改 README。
- 校验本地链接、示例命令和已安装 SDK 的真实接口。不要臆造原生插件安装器的目标 Bundle 选项。

## 检查与发布

- `npm test` 只是根 package.json 指定的轻量测试。修改 QQ 补丁还需重建并执行 `node maintenance/build-qqbot-patch.cjs --check`，在匹配宿主上做相关回归。
- 文档修改检查事实、链接及敏感内容即可，不运行会写生产状态的测试。
- 发布前审查 diff、文件清单和真实私有值匹配；使用 check-export 检查允许保留的 tgz 内容。不能只依赖 .gitignore。
- 不上传凭据、私人 Owner/应用标识、聊天、数据库、浏览器资料、日志、备份或官方发行文件。保留第三方许可，不扩大压缩包白名单。
- 推送前核对远端 URL。`public` 可能对应公开仓库，`origin` 可能对应旧私有仓库；不要仅凭远端名字判断，也不要把私有历史推入公开分支。
- GitHub 文档/源码更新不等于部署授权。已获部署授权时仍需空闲门禁、维护锁、可校验备份、隔离验证、单活切换和新启动健康检查；回滚范围必须说明清楚。
