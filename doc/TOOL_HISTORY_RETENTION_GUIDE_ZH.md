# MultipleShell：Claude Code / Codex / OpenCode 历史会话留存与恢复方案（含 `.claude.json` 同步）

本文给出一套**“会话历史可追溯 + 工具历史可留存”**的落地方案，覆盖 `claude-code` / `codex` / `opencode` 三类模板。核心目标是：**三类工具的历史会话可留存，并在重启 MultipleShell 后可恢复/续接会话**（取决于工具自身能力）。

> 提示（非硬性约束）：Claude Code 场景下复制/更新 `.claude.json` 时，建议保留配置目录中的 `history.jsonl`（见第 3 节）。

> 术语说明：  
> - **工具级历史**：Claude Code / Codex / OpenCode 自己为了“续接对话 / 恢复会话”写入的文件。  
> - **MultipleShell 级历史**：MultipleShell 自己记录“我开过哪些会话、何时启动/结束、退出码、最后输出摘要、可选完整日志”等。

---

## 1. 目标与原则

### 1.1 目标

1) **工具级（核心）：历史会话留存 + 可恢复/可续接**（优先级最高）：对 Claude Code / Codex / OpenCode，确保其运行态目录（history/state/cache 等）可持久化（或白名单同步），从而在重启 MultipleShell 后仍可恢复/续接会话（取决于工具自身能力）。  
2) **MultipleShell 级（补充）：会话可追溯**：即使 PTY 进程无法续接，也能在应用里看到历史会话列表，并支持“一键按同模板+同工作目录重开新会话”。  

### 1.2 核心原则：模板配置与运行态分离

为避免“工具写回导致模板漂移/串配置”，建议始终把文件分成两类：

- **模板配置（source of truth）**：用户编辑/模板管理写入的配置文件（如 `settings.json`、`config.toml`、`.opencode.json`）。
- **运行态状态/历史（runtime state）**：工具在运行中生成/更新的状态、历史、缓存、会话数据（如 `history.jsonl`、sqlite/db、cache、session metadata）。

实现上要么：

- **稳定 home**：把工具 home 固定到某个“每模板持久目录”，让其状态天然留存；或  
- **临时 home + 白名单同步**：运行在临时目录，但在启动/退出时同步少量“必须保留”的状态/历史文件。

---

## 2. MultipleShell 现有目录约定（建议沿用）

MultipleShell 已使用 `app.getPath('userData')` 下的 per-template 目录落地模板文件（便于隔离与外部工具读取）：

```text
<userData>/
  claude-homes/<configId>/
    settings.json
    .claude.json
    history.jsonl               (不同版本可能在 .claude/history.jsonl)
  codex-homes/<configId>/
    config.toml
    auth.json
  codex-runtime/<configId>/
    persist/history.jsonl
  opencode-homes/<configId>/
    opencode/.opencode.json
  opencode-runtime/<configId>/
    opencode.db                 (另有 `opencode.db-wal` / `opencode.db-shm`)
```

> Windows 上 `<userData>` 通常位于 `%APPDATA%\\<AppName>\\`（以 Electron 实际应用名为准）。

---

## 3. Claude Code：历史会话留存与恢复（每模板 profile）

### 3.1 现状与要求

- Claude Code 在 Windows 会从用户主目录读取 `~/.claude.json`。  
- MultipleShell 为避免不同模板之间**串会话/串项目状态**，会把全局的 `.claude.json` **复制**到 `claude-homes/<configId>/.claude.json`，并把 `HOME/USERPROFILE` 指向该 profile，从而让 Claude Code 的运行态（包含 `history.jsonl`）落在该 profile 内，便于重启后恢复/续接会话。  
- **提示（非硬性约束）**：复制/更新 `.claude.json` 时，尽量不要删除/重建 profile 目录，以免丢失该目录中的 `history.jsonl`（或 `.claude/history.jsonl`）。

### 3.2 会话恢复/续接（怎么做）

Claude Code 的“会话恢复/续接”由工具自身完成。MultipleShell 要做的是：**确保每个模板的 profile 目录稳定可复用，并在启动时把 Claude Code 的 home/config 指向这个目录**，让工具能读到上一轮留下的运行态文件（尤其是 `history.jsonl`）。

> 注意：这里的“恢复/续接”指 **新开一个终端进程** 后，Claude Code 基于 profile 文件恢复对话上下文；并不等同于恢复同一个 PowerShell/PTY 进程。

**程序侧要点（MultipleShell 行为）**

- 每次启动会话都设置 `CLAUDE_CONFIG_DIR=<profileHome>`。  
- Windows 上同时把 `HOME/USERPROFILE` 指向 `<profileHome>`，使 `~/.claude.json` 实际落在 `<profileHome>/.claude.json`。  
- 默认不清理 `history.jsonl`，避免“重启后无法续接/找不到历史”。

**用户侧恢复路径（操作步骤）**

1) 重启 MultipleShell。  
2) 选择同一个 Claude Code 模板（同 `configId`）重新开一个会话。  
3) 若希望保持与上次一致的“项目上下文/相对路径”，选择相同的工作目录；若不需要项目级设置，工作目录可落在 `<profileHome>` 以减少项目目录下 `.claude/settings.json` 的干扰。  
4) 在终端里用 Claude Code 的恢复参数续接会话：

```bash
claude --continue                 # 续接最近一次会话
claude --resume                   # 打开会话选择器（按会话 ID 恢复）
claude --resume <sessionId>       # 直接按会话 ID 恢复
claude --resume --fork-session    # 恢复但分叉为新会话（保留旧会话不被覆盖）
```

**验证/排障**

- 检查 `<profileHome>/history.jsonl`（或 `<profileHome>/.claude/history.jsonl`）是否存在且在对话后持续增长（时间戳/文件大小）。  
- 确认 `CLAUDE_CONFIG_DIR` 与 `HOME/USERPROFILE` 指向同一 `<profileHome>`（避免读到真实用户主目录导致串配置/串历史）。

### 3.3 历史会话管理（按模板隔离 / 新历史 / 清理）

MultipleShell 的策略是“每模板一个 Claude profile”，因此历史会话的管理基本等同于管理 `<profileHome>` 下的运行态文件：

- **继续使用同一历史**：保持 `history.jsonl` 不动即可。  
- **为不同项目/场景创建独立历史**：复制/新建一个模板（生成新的 `configId`）即可得到新的 `<profileHome>`，历史互不干扰。  
- **从零开始（清空历史）**：使用 `MPS_CLAUDE_CLEAR_HISTORY=1`（见 3.5）。  
- **归档/备份/还原**：清理前手动拷贝 `<profileHome>/history.jsonl`（以及 `<profileHome>/.claude/` 目录，如存在）到其它位置；需要还原时再拷回即可。  
- **工具内会话列表**：MultipleShell 默认不解析 `history.jsonl`；查看/切换/分叉历史会话以 Claude Code 自身的交互为准（常用入口是 `claude --resume` / `claude --continue` / `--fork-session`）。

### 3.4 推荐同步策略（文件级覆盖，不做目录级清理）

1) **只覆盖文件**：仅写入/覆盖 `<profileHome>/.claude.json` 与 `<profileHome>/settings.json`。  
2) **禁止目录级 rm**：不要对 `<profileHome>` 执行 `rm -r`/`Remove-Item -Recurse` 之类操作。  
3) **保留历史**：默认不触碰 `history.jsonl`；仅在用户显式要求时清理（例如环境变量开关）。  
4) **最小清洗**：为了减少跨模板串联，建议从 `.claude.json` 里删除可能携带会话/项目状态的字段（例如 `lastSessionId`、`projects`），但不影响历史文件留存。

### 3.5 清理历史（可选开关）

如果你希望每次启动都“尽量不要自动续接旧会话”，可以提供一个显式开关：

```text
MPS_CLAUDE_CLEAR_HISTORY=1
```

行为建议：

- 仅删除 `<profileHome>/history.jsonl` 与 `<profileHome>/.claude/history.jsonl`（若存在）。  
- 不删除其它文件与目录。

---

## 4. Codex：历史会话留存与恢复（两条主路线）

### 4.1 背景

MultipleShell 当前的典型做法是：**每次会话创建一个临时 `CODEX_HOME`**，并把 `config.toml/auth.json` 写到临时目录，以避免 Codex 运行时改写模板文件。  
代价是：**历史/状态天然不落盘**（会话结束清理临时目录后就没了），从而影响重启后的会话恢复/续接。

补充（已在本机验证）：Codex 会在 `CODEX_HOME` 下写入 `history.jsonl` 保存会话历史，例如 Windows 默认的 `%USERPROFILE%\.codex\history.jsonl`（如 `C:\Users\Administrator\.codex\history.jsonl`）。因此无论走路线 A 还是路线 B，至少要确保该文件被持久化/同步。

### 4.2 路线 A：稳定 `CODEX_HOME`（最简单）

做法：

- 把 `CODEX_HOME` 固定为 per-template 的稳定目录，例如：
  - `<userData>/codex-runtime/<configId>/`（推荐与 `codex-homes/` 分离，避免模板与状态混杂）
- 每次启动时把 `config.toml/auth.json` 写入该稳定目录（或通过环境变量把 config/auth 路径指向模板文件）。

优点：实现简单，Codex 的历史/状态自然持久化。  
缺点：Codex 可能会写回该目录中的文件（需接受或做保护/覆盖策略）。

### 4.3 路线 B：临时 `CODEX_HOME` + 白名单同步（推荐折中）

做法：

1) 仍然每次创建临时 `CODEX_HOME`。  
2) 启动前：从稳定目录（例如 `<userData>/codex-runtime/<configId>/persist/`）拷贝“白名单状态文件”到临时目录。  
3) 退出后：把临时目录中的白名单文件拷回稳定目录。  

优点：既能保留历史/状态，又能避免模板文件漂移。  
难点：需要先确认 Codex “哪些文件”承载历史/状态。

**如何确定白名单：**

- 已知（本机可见）的关键文件：`history.jsonl`（位于 `CODEX_HOME/history.jsonl`），建议至少纳入白名单同步。

**MultipleShell 默认实现（当前代码）：**

- 默认白名单：`history.jsonl`。
- 可用 `MPS_CODEX_PERSIST_WHITELIST=...` 覆盖白名单（逗号/分号分隔）。
- 如需“从零开始”，设置 `MPS_CODEX_CLEAR_HISTORY=1`（会按白名单清理 `<userData>/codex-runtime/<configId>/persist/` 下的文件）。
- 启用调试保留临时目录（一次即可），观察 Codex 实际写入了哪些文件，再决定同步哪些：

```text
MPS_KEEP_CODEX_HOME=1
```

然后检查 `%TEMP%\\mps-codex-home-<sessionId>\\` 中新增/变更的文件，挑出“确实与历史/状态相关且体积可控”的部分纳入白名单。

---

## 5. OpenCode（`opencode`）：历史会话留存与恢复（SQLite + `data.directory`）

基于上游开源项目 `opencode-ai/opencode` 的实现，OpenCode 的“会话/历史”主要落在 **SQLite 数据库**，路径由配置 `data.directory` 决定：

- **默认**：`data.directory = ".opencode"`（相对当前工作目录）。  
- **会话库**：`<data.directory>/opencode.db`（WAL 模式，可能同时出现 `opencode.db-wal`、`opencode.db-shm`）。  
- **其他状态**：例如 `<data.directory>/init`、`<data.directory>/commands/` 等。

同时，OpenCode 的配置文件名为 **`.opencode.json`**，会按下列位置读取并合并（后者可覆盖前者同名字段）：

1) `$HOME/.opencode.json`  
2) `$XDG_CONFIG_HOME/opencode/.opencode.json`  
3) `$HOME/.config/opencode/.opencode.json`  
4) `./.opencode.json`（项目本地）

### 5.1 推荐策略：每模板稳定 `data.directory`（不污染项目目录）

做法：

1) MultipleShell 将每模板的 `.opencode.json` 写入 `<userData>/opencode-homes/<configId>/opencode/.opencode.json`。  
2) 启动会话时设置 `XDG_CONFIG_HOME=<userData>/opencode-homes/<configId>`，让 OpenCode 读取该配置（无需依赖不存在的 `OPENCODE_CONFIG` 环境变量）。  
3) 在 `.opencode.json` 中设置：

```json
{
  "data": { "directory": "<userData>/opencode-runtime/<configId>" }
}
```

优点：OpenCode 的 `opencode.db` 自然按模板隔离并持久化，重启 MultipleShell 后仍可恢复/续接会话。  
注意：若用户项目目录存在 `./.opencode.json`，其字段会覆盖全局配置；需要在产品/文档中提示这一点。

### 5.2 备选：沿用默认 `./.opencode/`（项目内持久化）

如果允许在项目目录生成 `.opencode/`，则无需额外同步：重启后在同一工作目录运行，OpenCode 会复用该目录下的 `opencode.db`。  
缺点：同一项目目录下不同模板会共享同一份状态库，可能出现“串会话/串状态”的风险。

---

## 6. MultipleShell 自身的“历史会话记录”（推荐同时做）

工具级历史解决的是“CLI 能否续接/恢复会话”。但从产品角度，MultipleShell 还应记录：

- 会话列表（模板类型/名称、工作目录、开始结束时间、退出码、状态）
- 监控摘要（例如最后 N 行输出、错误计数）
- 可选完整日志（JSONL/文本），用于回放/导出

实现建议与 Hook 点可直接复用已有文档：`doc/SESSION_HISTORY_SOLUTION_ZH.md`。

---

## 7. 推荐默认组合（最少踩坑）

1) **Claude Code**：保持现有“per-template profile + 只覆盖 `.claude.json` 文件”的策略，默认保留 `history.jsonl`；提供 `MPS_CLAUDE_CLEAR_HISTORY=1` 作为显式清理开关。  
2) **Codex**：优先走“临时 `CODEX_HOME` + 白名单同步”；先用 `MPS_KEEP_CODEX_HOME=1` 探测一次写入文件，再确定白名单。  
3) **OpenCode**：默认使用“每模板稳定 `data.directory`”，并通过 `XDG_CONFIG_HOME` 隔离 per-template 的 `.opencode.json`。  
4) **MultipleShell 级历史**：至少落盘摘要（manifest），完整 transcript 必须显式开启并提示安全风险。

---

## 8. 验收清单（建议）

1) 分别启动 `claude-code` / `codex` / `opencode` 三种模板各 1 个会话并产生输出/对话。  
2) 关闭 MultipleShell，重启应用。  
3) 检查对应目录下的历史/状态文件仍存在（Claude：`history.jsonl`；Codex：按白名单；OpenCode：`opencode.db` / `opencode.db-wal` / `opencode.db-shm`）。  
4) 重开同模板会话，确认工具侧具备“可恢复/可续接会话”的基础能力（取决于工具自身功能）。  








