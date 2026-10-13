# 本地适配包维护

上游固定提交和本地改动见 `D:/DeepSeek-Harness/maintenance/reviews/memory-source.json`。本地包改用独立名称，当前版本以 package.json 为准；不向 npm 发布。原始 package-lock.json 和 devDependencies 记录的是上游 0.1.x 开发环境，不能据此声称在 0.2.x 完成源码重新编译，也不能用于部署 profile。

本次使用上游提交中随附的 lib 产物，本地修复同步维护 src/index.ts、src/render.ts 与 lib/index.js、lib/render.js：recall/search 必须把实际记忆正文放进模型可见的工具结果。`node --test tests/render.test.mjs` 验证正文输出；完整 SDK 集成在 Harness 候选宿主中运行，不能用独立 Node 缺少 SDK 的执行结果代替宿主测试。

日后涉及业务源码改动，应先建立与目标本体 SDK 版本一致的独立开发环境、重新生成开发锁文件并编译；保留上游开发锁作对照，不把开发 SDK 装进 desktop profile。打包前检查 src/lib 一致、许可与工具权限；升本地版本，生成新 tgz，更新维护策略的 SHA-256，运行 Stage，再完成实际工具测试和 DeployValidated。旧 tgz 保留供锁文件离线回滚。

记忆不是用户访问权限隔离：工具允许显式切换 taskId。只在本人的私人部署使用；开放其他用户前需要独立权限/实例。数据位于配置指定的 storageRoot，默认不自动注入系统提示，也不保存密码。
