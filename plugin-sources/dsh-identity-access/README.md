# Identity & Access — Host 授权服务（Gate 2）

独立、平台无关的 Host 插件 `0.1.0-test.2`，provide 服务 `identityAccess`。不依赖 QQ SDK、Character Memory、Persona 或任何平台命令实现；不注册模型工具、RPC 或路由。默认不装配，QQ 只有显式 `identityAccess.enabled: true` 时才使用它。

```
Platform Adapter → Platform Admission（白名单）→ Unified Agent I/O → Identity & Access → Conversation Manager → 授权的原生 Preset
```

## 角色与状态

| Role | Preset（默认） | 来源 |
|---|---|---|
| owner | `character`（可附 `legacyOwnerPresets`，如 `qq-character`） | 本机可信配置 `owner` / `ownerFile`，不可经命令创建或转让 |
| contact | `character-contact` | Owner 显式授予，可设有效期 |
| guest | `character-guest` | 已通过平台准入、无授权的默认身份 |

`blocked` 是独立账号状态。Principal = `sha256([providerId, subject])`，与角色无关；providerId 包含平台、Adapter 与实际应用账号，不同账号范围不合并。昵称、消息正文、模型输出和调用方传入的 role 字段都不是身份依据。

状态是独立 JSON（`stateFile`，原子写 + fsync），不使用 Character Memory：已出现过的非 Owner 账号（provider、subject，无角色）、contact 授权与有效期、封禁、审计（最多 1000 条）。任一持久化失败使实例失效并撤销所有授权（fail closed）。同一进程内跨模块实例（HMR）共用单写入者登记；多进程共享同一 stateFile 必须由部署阻止。

## 配置

```yaml
- id: identity-access
  name: dsh-identity-access
  config:
    stateFile: <ABSOLUTE_DATA>/identity-access.json
    ownerFile: <ABSOLUTE_DATA>/identity-owner.json   # {"provider":"qq-official:qq-official-gateway:<APP_ID>","subject":"<OWNER_OPENID>"}
    presets: {owner: character, contact: character-contact, guest: character-guest}
    legacyOwnerPresets: [qq-character]               # 仅 Owner 可继续使用的旧 Preset 名
```

必须在 QQ Gateway 之前装配。`ownerFile` 是私有文件，不进入 Git。

## 接口

- 管理 API（独立于命令层）：`list/show/change/audit/reference(actor, …)`，actor 必须是 Provider 验证过的 Owner 身份句柄；`change` 需 `expectedEpoch`（并发修改冲突即拒绝）。
- Session 授权：`issue(verified,{sessionId,preset})` 颁发可撤销租约，`authorize(lease,{sessionId,operation})` 每次检查当前角色、有效期、封禁、Preset 与 Session。非 Owner 仅允许 `chat/reply/hitl`。角色变更只撤销该 Principal 的租约；过期在检查时生效。
- `conversation({platform,adapter,accountId})`：Agent I/O 的访问契约（`admit/bind/adopt/authorize/command/outbound/onRevoke/commands`）。v1 只接受私聊且发送者即会话对象；群聊会使多个 Principal 共用一个 Session，直接拒绝。`adopt` 只按本机 Owner 配置把无新输入恢复的 Owner Session 重新绑定，其他角色必须有新的已准入输入。
- `/role`（`roleCommandSpec`）：经 Agent I/O 命令路由注册，路由的访问闸门提供 `call.access`；返回值即回复文本。`list`、`show <principal>`、`grant contact <principal> [30m|12h|7d]`（最长 366 天）、`revoke|block|unblock <principal>`。目标必须是已验证并记录过的 Principal。
- 全局工具守卫：角色管理的 Session 只有当前 Owner 授权才能执行工具；contact/guest Preset 无论租约状态一律拒绝。`tool-scope.mjs` 是 contact/guest Preset 内的原生工具范围（`tools.restrict` + `tools.guard`），覆盖继承和后注册的全局工具。

## 边界

预留：多平台账号绑定（同一人多个 Provider 账号）与细粒度 Capability Grants，本轮未实现。原生 Web/Desktop 窗口属本机 Owner，不经本服务。真实 QQ/手机验收与生产迁移不在源码测试范围内。
