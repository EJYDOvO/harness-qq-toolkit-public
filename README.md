# Harness QQ Toolkit

DSH QQ 接入的兼容补丁、独立 Remote Ops 和维护工具源码仓库。**本体使用官方安装器单独安装**；这里保存可审查、可重建的扩展，以及恢复需要的小型固定版本包。

2026-10-19 更新：基础 QQ 不再依赖 Remote Ops 或 Character，Remote Ops 1.1.0 支持独立状态目录及可选 Host 维护后端。参见 [通用安装与依赖](docs/GENERIC-INTEGRATION.md) 和 [Remote Ops 接口](plugin-sources/dsh-remote-ops/README.md)。原 Windows 维护目录保留为兼容后端，不等同于跨平台通用安装器。

已验证环境：Windows、Harness `0.2.0-rc.2`、QQ 插件 `0.5.2`、Navigator / `gemma-4-31b-it`。这是现有部署的维护快照，不是跨版本通用的一键安装器。

## 保存范围

| 目录 | 内容与作用 |
|---|---|
| `plugin-sources/dsh-remote-ops` | 所有者专属 `/ops` 命令、维护结果通知、长任务监控 |
| `plugin-sources/dsh-task-memory` | 固定上游提交的本地适配；修复记忆读取和搜索缺少正文 |
| `maintenance` | QQ 正式补丁与原文件快照、测试、候选部署、备份恢复、守护与管理说明 |
| `maintenance/browser/0.0.83` | Playwright MCP 的固定依赖清单、锁文件与配置；不包含 node_modules |
| `plugin-packages` | 当前两个本地插件及既有 Bilibili 插件的小型 tgz，供离线恢复精确版本 |
| `templates` | 无凭据的 profile 清单/锁文件、QQ 配置示例、所有者和模型配置示例 |
| `default-workspace/AGENTS.md` | Agent 与多 Agent 的工作约定 |
| `scripts` | 从已审查本机源码导出、上传前检查 |
| `source-snapshot.json` | 本地来源提交、文件 SHA-256 与导出时间 |

不保存本体 exe/app.asar、运行时、node_modules、QQ/API 凭据、真实所有者配置、聊天记录、记忆数据、浏览器登录资料、日志、备份和日常项目。配置示例中的占位符必须在本机填写；QQ 示例默认禁用。

源码和小安装包目前合计约 0.5 MB。没有打包整个桌面程序，没有自动更新或自动推送任务。

## 管理与恢复

- [功能管理手册](maintenance/FEATURES.md)：各功能开关、目录、更新及停用方式。
- [维护入口](maintenance/README.md)：Stage → DeployValidated，备份与失败回滚。
- [恢复步骤](docs/RESTORE.md)：先安装官方本体，再恢复扩展并配置本机凭据。
- [仓库同步](docs/REPOSITORY.md)：本机运行目录与 GitHub 仓库的关系。
- [安装前审查](maintenance/reviews/INSTALL-REVIEW.md)与[验收记录](maintenance/TEST-REPORT.md)。报告引用的运行日志只保留本机，不在仓库内。

当前按私人用户部署。QQ 白名单、运维所有者和任务记忆分组均不等同于完整的多用户权限隔离。守护在 Windows 用户登录后工作；本体升级到其他版本前需要重新做兼容验收。

## 验证

仓库内可直接运行的检查（Node.js 22+，无需安装 SDK）：

```powershell
npm test
node maintenance/build-qqbot-patch.cjs --check
```

完整 17 项部署回归、浏览器和真实模型测试依赖已配置的 Harness 安装环境，应在那里通过 `maintenance/manage.ps1 -Action Stage` 执行。仓库中的轻量测试不能替代完整部署验收。

第三方文件保留原许可，QQ/Bilibili 许可另见 `licenses`，记忆插件许可见其源码目录。仓库未将第三方内容重新声明为本项目原创代码。
