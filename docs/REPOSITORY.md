# 源码与公开提交

公开目标是 EJYDOvO/harness-qq-toolkit-public。推送前核对实际 remote URL；远端名称不是可见性保证。源码直接在克隆内维护，不再从运行实例整体导出。

保留插件源码、必需上游补丁输入及哈希、固定依赖、安装/恢复脚本、许可证和安全/生命周期回归。旧安装包、逐轮报告、已替代探针及旧 Task Memory 不在当前树中；历史没有改写。

提交前执行 npm ci、npm test、npm run test:audit、npm run test:patch，以及 node scripts/check-export.cjs。后者只扫描跟踪树，不读取本机秘密；它不代替历史/归档的 Gitleaks 审计。检查 git status/diff，明确列出新增文件；tarball、日志、数据库、Profile、Persona、Owner 配置和本地归档不得提交。

使用专用分支和 PR，不强推或自动部署。必要兼容补丁与上下游快照必须同步重建、应用并逐文件校验；不要修改已安装的官方 DSH 文件。
