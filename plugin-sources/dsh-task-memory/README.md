# dsh-task-memory

[![dsh.pub registry status](https://dsh.pub/api/badges/wangyihao0001-oss/dsh-task-memory.svg)](https://dsh.pub/en/plugins/dsh-task-memory/)
[![CI](https://github.com/wangyihao0001-oss/dsh-task-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/wangyihao0001-oss/dsh-task-memory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

English | [中文](README.zh.md)

Task-isolated long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Memories live in per-task vaults under `~/.dsh/storages/task-memory/`. Facts stored for one task are invisible to another unless you deliberately switch.

**Catalog:** [dsh.pub/en/plugins/dsh-task-memory](https://dsh.pub/en/plugins/dsh-task-memory/)

## Why this exists

Most DSH memory plugins are global or workspace-wide. This one treats **task** as the isolation boundary:

1. Default task = derived from session `cwd`
2. `memory_bind_task` rebinds the current session to a named vault
3. Search / recall / prompt injection never cross that boundary — prompt injection is registered at **agent scope**, so each session's system prompt only ever shows its own task's memories

## Quick start

```bash
# Install into the web profile (pin a full commit SHA for production)
dsh plugin --profile web add "github:wangyihao0001-oss/dsh-task-memory"

# Or via the catalog CLI
npx dshpub add wangyihao0001-oss/dsh-task-memory --profile web
```

Restart the web UI (or reboot the profile), then in a session:

1. `memory_bind_task` — e.g. `taskId: "my-app"` (optional `title`)
2. `memory_remember` — `key: "stack"`, `content: "Node 22 + Postgres"`, optionally `pinned: true`
3. `memory_recall` / `memory_search` — read back within the same task
4. `memory_current_task` — confirm which vault this session is on

## Tools

| Tool | Purpose |
|------|---------|
| `memory_bind_task` | Bind this session to a task vault |
| `memory_current_task` | Show the session's current vault (binding or default) |
| `memory_remember` | Upsert a fact by `key` (optional tags / pin / task override) |
| `memory_recall` | Exact-key read |
| `memory_search` | Keyword search (EN + 中文 bigrams); empty query lists recent/pinned |
| `memory_forget` | Delete one key |
| `memory_list_tasks` | List vaults |
| `memory_clear_task` | Wipe one vault (`confirm: true` required) |

Never store secrets in memory entries.

## Install / verify / disable

```bash
# Install
dsh plugin --profile web add "github:wangyihao0001-oss/dsh-task-memory#<40-char-sha>"

# Confirm the bundle layer is present
dsh --profile web --dump-config

# Remove from the profile when done
dsh plugin --profile web remove dsh-task-memory
```

After install or remove, restart `dsh web` (or reboot the profile) so the Cordis layer reloads.

Vault files under `~/.dsh/storages/task-memory/` are **not** deleted on uninstall — back up or delete them yourself if needed.

## Local develop (without installing)

```bash
npm install
npm run build
npm test        # node:test unit tests
npm run smoke   # build + smoke
```

Link a checkout while developing:

```bash
dsh plugin --profile web add "$(pwd)"
```

If you run DSH from a source checkout:

```bash
pnpm dsh web --patch /absolute/path/to/dsh-task-memory/cordis.dev.yml
```

Update the absolute path in `cordis.dev.yml` so it points at this checkout’s built `lib/index.js`.

## Config

`cordis.patch.yml` defaults:

```yaml
injectLimit: 8           # max memories in prompt context
injectMaxChars: 2400     # soft char budget for the injected block
injectMaxEntryChars: 400 # per-entry char cap in the injected block (truncated)
injectPrompt: true       # inject pinned/recent facts for the active task
maxEntries: 500          # vault cap (>= 1); oldest non-pinned entries are evicted first
                         # (pinned are never evicted; new keys over the cap are rejected;
                         # upserts of existing keys are not blocked by capacity)
```

Optional `storageRoot` overrides `~/.dsh/storages/task-memory`.

## Storage & reliability

```text
~/.dsh/storages/task-memory/
  <task-id>.json
```

Each file:

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

- Files are plain JSON — safe to hand-edit or back up
- Writes go through **tmp file + atomic rename**, so readers always see a consistent snapshot
- Mutations for the same task (including `memory_bind_task` title updates, `save`, and `update`) are **serialized** in-process (per-task lock); concurrent agents cannot lose updates. Prefer `update` over `load` → mutate → `save` for read-modify-write
- Pinned entries are **never evicted**; when a full vault has nothing removable but pinned entries, **new keys** are rejected with a clear error instead of silently dropping the just-written fact, while upserts of existing keys are never blocked by capacity (they still shrink best-effort)
- On startup, stale `*.tmp` files from crashed writes are cleaned up (only those older than 1h, so another process's live write is never touched)

## Model experience

When `injectPrompt` is true, the plugin injects a short memory block into the **current agent session's** system prompt:

- Only the vault bound to that session (or the cwd-derived default)
- Prefer pinned entries, then recent ones, up to `injectLimit` / char budgets
- Other sessions and other tasks never appear in this block

Tools remain available for explicit recall/search beyond what fits in the prompt.

## Known limitations

- Host-only bundle: no Web UI for browsing vaults yet (see roadmap)
- Keyword search is lexical (EN tokens + 中文 bigrams), not embeddings / vector search
- Isolation is per **task id** within this plugin — it does not sandbox the rest of DSH
- Catalog listing on dsh.pub is an automated contract check, not a security audit
- Do not store credentials, tokens, or personal secrets in memories

## Compatibility

- Node.js `>= 20`
- DeepSeek Harness peers as declared in `package.json` (`@deepseek-ai/dsh-*` / `cordis` / `schemastery`)
- Installs as a Git bundle via `dsh.bundle.patch` → `cordis.patch.yml`
- Intended profile: `web` (or any profile that loads Host tools)

## Roadmap

- ✅ Per-session prompt injection via agent-scoped context (replaces process-level binding guess)
- Optional vector search behind the same tools
- Tiny Web UI page to browse / pin / delete vaults

## License

MIT — see [LICENSE](./LICENSE).
