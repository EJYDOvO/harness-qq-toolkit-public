# GitHub 仓库管理

公开入口：[EJYDOvO/harness-qq-toolkit-public](https://github.com/EJYDOvO/harness-qq-toolkit-public)。原私有仓库 `EJYDOvO/harness-qq-toolkit` 是不同发布目标。本机克隆可能同时配置 `origin`（旧私有仓库）与 `public`（公开仓库）；推送前运行 `git remote -v` 核对 URL，不凭远端名字猜测可见性。

该目录保存可审查的源码和导出快照；运行中的插件依然由安装目录管理，不从 GitHub 自动拉取运行。开发文档维护规则见 [AGENTS.md](../AGENTS.md)。

## 保存新的改动

1. 在原 `plugin-sources` / `maintenance` 中修改、审查并测试。通过 `maintenance/checkpoint.ps1` 保存本地 Git 检查点。
2. 在此仓库执行 `node scripts/sync-from-installation.cjs D:/DeepSeek-Harness`。导出脚本只复制已跟踪且工作区干净的源码、指定包和白名单模板，不复制历史仓库、运行数据或完整 live profile。导出会更新对应快照；它不会删除旧文件，改名/删除的旧文件须通过 git diff 人工审查并移除。
3. 运行 `node scripts/check-export.cjs D:/DeepSeek-Harness`、`npm test` 和补丁重建检查。检查程序在本机比对配置中的凭据、私人 openid，并检查压缩包内容；只输出匹配位置，不输出凭据值。通过检查不等于可以上传任意新文件，仍须检查 git diff 和待提交清单。
4. 新 tgz 必须审查、升版本、登记 plugin-policy.json 哈希，并在根 .gitignore 明确允许。旧版本按需要保留用于恢复；不要添加宽泛的压缩包例外。
5. 审查后提交明确的文件清单，并向已核对的目标推送；本机公开目标通常为 `git push public main`。新克隆若 origin 已指向公开仓库，则使用该已核对的远端。先确认提交历史可公开，不要强推，不上传本体或 data。此流程不会自动部署到正在运行的 QQ。

纯 README、接口说明和仓库规则可直接在此仓库维护，无需先从运行安装目录整体重新导出。导出可能覆盖维护目录内的文档，重新导出后应复核文档差异；不要用旧快照覆盖已修正的说明。`source-snapshot.json` 记录的是某次导出的来源和哈希，不是后续每个 Git 提交的实时完整性证明。

## 从 GitHub 应用改动

先拉取并审查 diff，再将变更带回安装目录的独立源码仓库，按“打包 → Stage → 实测 → DeployValidated”发布。仅 git pull 或修改导出目录不会改变正在运行的插件。

首次备份采用新的干净快照，保留 `source-snapshot.json` 中的本地来源提交编号；没有把四个本地仓库的完整历史拼接上传。后续远端提交用于跟踪本工具集的整体变化。仓库文件保留原字节换行，避免 QQ 上游快照和补丁摘要因 Git 换行转换失效。
