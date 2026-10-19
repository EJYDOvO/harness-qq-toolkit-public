# QQTK 通用安装与依赖（2026-10-19）

QQTK 继续是独立插件与维护组件集合，不迁入 Character 仓库、不合并单体。Character 通过固定版本的 QQTK 接口和补丁使用它。

## 依赖变化

| 功能 | 旧前提 | 当前前提 |
|---|---|---|
| QQ 接入/Session/Sender/审批/问答 | 基础 QQ 强依赖 qqRemoteOps | DSH Agent/原生 Preset + 已审查 QQ 0.5.2 补丁 |
| `/ops` | 安装目录中私人维护脚本 | 独立插件，显式 Owner/stateDirectory；可选 qqMaintenance 服务 |
| 旧 Windows 部署/恢复/守护 | 固定部署约定 | 保留在显式 root 后端，未改成跨平台工具 |
| Character QQ | QQTK + Character 集成 | 不变；通用 QQ 不加载 Character |
| QQ 会话偏好 | 所有 Profile 使用用户目录 | 有 DSH_HOME 时使用 DSH_HOME/qqbot；无配置保留旧路径 |

普通项目只需安装 `@tencent-connect/dsh-qqbot@0.5.2`，不需要本仓库 Remote Ops、本仓库旧项目记忆，或任何 Character 包。

Profile 保留原生 base/web-app Bundle，`autoInstallPeers: false`，不要重复安装本体的服务包。将 `maintenance/patches/dsh-qqbot@0.5.2.patch` 放到 Profile 的 patches，配置：

```yaml
# pnpm-workspace.yaml
packages: [ . ]
nodeLinker: hoisted
autoInstallPeers: false
patchedDependencies:
  '@tencent-connect/dsh-qqbot@0.5.2': patches/dsh-qqbot@0.5.2.patch
```

```yaml
# cordis.patch.yml；占位符必须换成本机安全配置
- insert:
    - id: ordinary-qq
      name: '@tencent-connect/dsh-qqbot'
      config:
        appId: '<LOCAL_APP_ID>'
        appSecret: '<LOCAL_APP_SECRET>'
        preset: cordis
        cwd: '<ABSOLUTE_PROJECT>'
        access:
          c2cMode: allowlist
          c2cAllow: ['<LOCAL_OWNER_OPENID>']
          groupMode: disabled
          groupAllow: []
```

包管理器正常安装并应用补丁；不手改 DSH app.asar 或安装后的 node_modules 文件。每个项目设置独立的绝对 DSH_HOME。不要同时启用 QQ 官方 Bundle 和另一个手动 QQ 条目。

需要 `/ops` 时，另行安装 `plugin-packages/dsh-remote-ops-local-1.1.0.tgz`（或审查源码后 pack）。按 [独立模式与维护后端](../plugin-sources/dsh-remote-ops/README.md) 在 QQ 前加载。没有维护后端时基本任务观察可用，部署/重启等明确拒绝；不会猜测其他安装目录。

## 单例、权限与生命周期

- 基础 QQ 的注入声明只依赖 agents，未安装 Remote Ops 时审批/问答仍注册。
- 进程共享 appId 租约拒绝重复 Gateway，卸载等待停止后释放；只构造一套 Sender、问答与审批通道。
- 多进程使用同一凭据需外部单活管理；本机维护锁不能代表跨机器分布式锁。
- 无效 Preset 不再退回其他 Agent 组合；已有 Session 继续按其原 Preset 恢复，缺失时拒绝。
- Remote Ops 安装/卸载后重载 QQ 或重启 Profile。热插拔能力发现未实现。
- QQ 白名单、审批 nonce、Owner 校验、取消/超时、路径边界修复保留。只验收单 Owner 私聊；未开放群聊或主动闲聊。

## 实际验证

在已安装 DSH 0.2.0-rc.2 上，以单独 DSH_HOME/Profile、仅 QQ 一个第三方依赖启动真实 QQ SDK；无 Character/Remote Ops 服务。已通过连接、普通 Creator Preset、Session 创建/恢复、缺失 Preset 拒绝及单 Gateway 检查。

15 项自动回归通过：审批4、访问/问答/文件边界6、Remote Ops及偏好隔离5。按钮 nonce/拒绝/允许属于自动交互测试；本轮没有用户手机点击验收，不能算手机投递已验证。

完整 Character test.7 使用 Remote Ops 1.1.0：Core-only、Core+Extras 各启动一次且各只有一个 QQ ready；实际恢复 test.6 后再部署 test.7 成功。Windows 以外宿主兼容性未验证，不能据此宣称两台 Mac 已可直接迁移。

## 更新维护

补丁包含10个文件的审查快照；原文件哈希在 qqbot-upstream-0.5.2/manifest.json。修改 qqbot-src 后重建补丁并运行 `node maintenance/build-qqbot-patch.cjs --check`。升级上游版本时重新比对，不能将0.5.2补丁盲目应用到其他版本。

原 templates/profile 是旧安装快照；新项目优先使用本文件的最小装配，不直接复制旧绝对路径/可选插件清单。更新配置与状态目录时先备份；不要删除通知账本来“重试”不确定投递。
# Interaction 可选接入

开发候选可对接 Agent 层 Interaction 服务，详见 [接口与验证边界](INTERACTION.md)。QQ 基础接入仍不依赖它，不增加 Gateway、数据库或额外模型。安装包、在 Preset 中声明并隔离服务、应用 QQ 补丁和部署是不同步骤；本轮没有部署。
