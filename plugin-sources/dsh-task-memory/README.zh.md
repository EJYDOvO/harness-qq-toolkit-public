# dsh-task-memory

[![dsh.pub registry status](https://dsh.pub/api/badges/wangyihao0001-oss/dsh-task-memory.svg)](https://dsh.pub/zh/plugins/dsh-task-memory/)
[![CI](https://github.com/wangyihao0001-oss/dsh-task-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/wangyihao0001-oss/dsh-task-memory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**任务隔离**长期记忆插件。

记忆按任务分库，保存在 `~/.dsh/storages/task-memory/`。写入某一任务的事实，对其他任务默认不可见，除非主动切换任务。

**目录页：** [dsh.pub/zh/plugins/dsh-task-memory](https://dsh.pub/zh/plugins/dsh-task-memory/)

## 为什么做这个

多数 DSH memory 插件是全局或按 workspace 共享的。本插件把 **task（任务）** 当作隔离边界：

1. 默认任务：由 session 的 `cwd` 推导
2. `memory_bind_task`：把当前 session 绑到指定任务 vault
3. 搜索 / 读取 / 提示注入：**不会**跨任务边界，提示注入按 **agent 级作用域**注册——每个会话的系统提示只注入它自己任务的记忆

## 快速开始

```bash
# 安装到 web profile（生产环境建议钉完整 commit SHA）
dsh plugin --profile web add "github:wangyihao0001-oss/dsh-task-memory"

# 或通过目录 CLI
npx dshpub add wangyihao0001-oss/dsh-task-memory --profile web
```

重启 Web UI（或重启 profile），然后在会话里：

1. `memory_bind_task` — 例如 `taskId: "my-app"`（可选 `title`）
2. `memory_remember` — `key: "stack"`，`content: "Node 22 + Postgres"`，可选 `pinned: true`
3. `memory_recall` / `memory_search` — 在同一任务内读回
4. `memory_current_task` — 确认当前 session 落在哪个 vault

## 工具

| 工具 | 作用 |
|------|------|
| `memory_bind_task` | 将当前 session 绑定到某个任务 vault |
| `memory_current_task` | 查看当前 session 所在 vault（绑定 or 默认） |
| `memory_remember` | 按 `key` 写入或更新一条事实（可选 tags / 置顶 / 指定任务） |
| `memory_recall` | 按精确 key 读取 |
| `memory_search` | 关键词搜索（英文 + 中文 bigram）；空查询列出近期/置顶 |
| `memory_forget` | 删除一条 |
| `memory_list_tasks` | 列出所有任务 vault |
| `memory_clear_task` | 清空某个 vault（需 `confirm: true`） |

不要把密钥、token 等敏感信息写进记忆。

## 安装 / 验证 / 卸载

```bash
# 安装
dsh plugin --profile web add "github:wangyihao0001-oss/dsh-task-memory#<40位SHA>"

# 确认 bundle 层已出现
dsh --profile web --dump-config

# 从 profile 移除
dsh plugin --profile web remove dsh-task-memory
```

安装或卸载后，请重启 `dsh web`（或重启 profile），让 Cordis 层重新加载。

卸载**不会**删除 `~/.dsh/storages/task-memory/` 下的 vault 文件——需要备份或清理请自行处理。

## 本地开发（不安装）

```bash
npm install
npm run build
npm test        # node:test 单测
npm run smoke   # 构建 + 冒烟
```

开发时 link 本地 checkout：

```bash
dsh plugin --profile web add "$(pwd)"
```

若从 DSH 源码仓库启动：

```bash
pnpm dsh web --patch /absolute/path/to/dsh-task-memory/cordis.dev.yml
```

请把 `cordis.dev.yml` 里的绝对路径改成指向本仓库编译后的 `lib/index.js`。

## 配置

`cordis.patch.yml` 默认值：

```yaml
injectLimit: 8           # 注入到提示中的记忆条数上限
injectMaxChars: 2400     # 注入块软字符预算
injectMaxEntryChars: 400 # 单条记忆在注入块中的字符上限（超出截断）
injectPrompt: true       # 是否为当前任务注入置顶/近期事实
maxEntries: 500          # 每个 vault 的条目上限（>= 1）；超出时淘汰最旧的非置顶条目
                         # （置顶永不被淘汰；新增超出上限会被拒绝；对已有 key 的更新不受容量限制）
```

可选 `storageRoot` 覆盖默认目录 `~/.dsh/storages/task-memory`。

## 存储与可靠性

```text
~/.dsh/storages/task-memory/
  <task-id>.json
```

每个文件形如：

```json
{
  "taskId": "<task-id>",
  "title": "<title>",
  "updatedAt": 0,
  "entries": [
    {
      "id": "m_…",
      "key": "<key>",
      "content": "…",
      "tags": [],
      "pinned": true,
      "createdAt": 0,
      "updatedAt": 0
    }
  ]
}
```

- 文件是纯 JSON，可直接手工编辑或备份
- 写入通过**临时文件 + 原子 rename**，读取永远看到一致快照
- 同一任务的写入（含 `memory_bind_task` 的标题更新、`save`、`update`）在进程内**串行化**（per-task 锁），并行 agent 并发写不会丢更新。读改写请优先用 `update`，避免 `load` → 修改 → `save` 覆盖并发写入
- 置顶条目**永不被淘汰**；vault 满且可淘汰的只有置顶条目时，**新增** key 会被拒绝并返回明确错误（避免「刚写入就被淘汰」的静默丢失）；对已有 key 的原地更新（upsert）不受容量限制，仍会尽力收缩
- 启动时自动清理崩溃残留的 `*.tmp`（只清理超过 1 小时的，避免误删其他进程的进行中写入）

## 模型体验

当 `injectPrompt` 为 true 时，插件会把一段简短记忆块注入**当前 agent 会话**的系统提示：

- 只包含该会话绑定的 vault（或 cwd 推导的默认任务）
- 优先置顶条目，其次近期条目，受 `injectLimit` / 字符预算约束
- 其他会话、其他任务的记忆不会出现在这段注入里

超出提示预算的内容，仍可通过工具显式 recall / search。

## 已知限制

- 目前是 Host-only 组合包：尚无浏览 vault 的 Web UI（见路线图）
- 搜索是词法匹配（英文 token + 中文 bigram），不是向量检索
- 隔离边界是本插件内的 **task id**，并不沙箱化整个 DSH
- dsh.pub 上架是自动契约检查，不等于安全审计
- 请勿在记忆中存放凭据、token 或个人隐私

## 兼容性

- Node.js `>= 20`
- peer 依赖见 `package.json`（`@deepseek-ai/dsh-*` / `cordis` / `schemastery`）
- 通过 `dsh.bundle.patch` → `cordis.patch.yml` 以 Git bundle 安装
- 目标 profile：`web`（或任何会加载 Host tools 的 profile）

## 路线图

- ✅ 按 session 精确的提示注入（agent 级 scoped context，取代进程级 bind 猜测）
- 在同一套工具背后可选向量检索
- 小型 Web UI：浏览 / 置顶 / 删除 vault

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
