# GitHub 仓库管理

远端：`EJYDOvO/harness-qq-toolkit`，私有。初始本机克隆在 `D:/DeepSeek-Harness/source-repository/harness-qq-toolkit`。该目录保存导出快照；运行中的插件依然由原安装目录管理，不从 GitHub 自动拉取运行。

## 保存新的改动

1. 在原 `plugin-sources` / `maintenance` 中修改、审查并测试。通过 `maintenance/checkpoint.ps1` 保存本地 Git 检查点。
2. 在此仓库执行 `node scripts/sync-from-installation.cjs D:/DeepSeek-Harness`。导出脚本只复制已跟踪且工作区干净的源码、指定包和白名单模板，不复制历史仓库、运行数据或完整 live profile。导出会更新对应快照；它不会删除旧文件，改名/删除的旧文件须通过 git diff 人工审查并移除。
3. 运行 `node scripts/check-export.cjs D:/DeepSeek-Harness`、`npm test` 和补丁重建检查。检查程序在本机比对配置中的凭据、私人 openid，并检查压缩包内容；只输出匹配位置，不输出凭据值。通过检查不等于可以上传任意新文件，仍须检查 git diff 和待提交清单。
4. 新 tgz 必须审查、升版本、登记 plugin-policy.json 哈希，并在根 .gitignore 明确允许。旧版本按需要保留用于恢复；不要添加宽泛的压缩包例外。
5. 审查后 `git add`、`git commit`、`git push origin main`。不要强推，不上传本体或 data。此流程不会自动部署到正在运行的 QQ。

## 从 GitHub 应用改动

先拉取并审查 diff，再将变更带回安装目录的独立源码仓库，按“打包 → Stage → 实测 → DeployValidated”发布。仅 git pull 或修改导出目录不会改变正在运行的插件。

首次备份采用新的干净快照，保留 `source-snapshot.json` 中的本地来源提交编号；没有把四个本地仓库的完整历史拼接上传。后续远端提交用于跟踪本工具集的整体变化。仓库文件保留原字节换行，避免 QQ 上游快照和补丁摘要因 Git 换行转换失效。
