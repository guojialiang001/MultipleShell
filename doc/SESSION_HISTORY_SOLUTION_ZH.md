# MultipleShell：历史会话（Session History / Session Restore）实现方案

本文基于当前仓库代码结构（Electron 主进程 `src/main/` + 渲染进程 `src/renderer/` + `node-pty`）给出“重启后还能看到/恢复上次会话”的实现思路与落点。

> 先说结论：**`node-pty` 本身无法“断点续接”一个已经退出的 PTY 进程**。因此“历史会话”通常要拆成两层：
> 1) **会话记录**：把会话的元数据/状态/摘要（可选：输出日志）落盘，重启后可查看、可导出、可一键“以同配置重开”。  
> 2) **真·续接**：把 PTY 后端做成常驻 Host（类似 daemon），UI 重启只是重新连接；这属于更大改造。

---

## 1. 现状（当前代码行为）

### 1.1 MultipleShell 自己的“会话”

- 会话列表仅存在于内存：`src/main/index.js` 里的 `sessionRegistry`（`sessions:changed` 事件源）。
- 终端进程由 `src/main/pty-manager.js` 创建（`pty.spawn('powershell.exe', ...)`），进程退出就不可恢复。
- 所有窗口关闭时，Host 会 `killAllSessions()` 并清空 `sessionRegistry`：`src/main/index.js` 的 `app.on('window-all-closed', ...)`。
- 监控面板状态来自 `src/main/shell-monitor.js`：只保留“最后 N 行”等摘要，且仅在当前进程生命周期内有效。

### 1.2 Claude/Codex/OpenCode 工具自己的“历史”

这是另一个维度：即使 MultipleShell 不做任何“会话记录”，CLI 工具本身也可能通过 home/profile 下的文件支持“恢复历史对话/会话”。

- Claude Code：
  - 每个模板会有一个 profile 目录：`app.getPath('userData')/claude-homes/<configId>/settings.json`（见 `src/main/pty-manager.js` 的 `syncClaudeProfileFiles()`）。
  - **默认会保留 `history.jsonl` 以便 Claude 保留/恢复历史会话**；如需在会话启动时清理，设置：`MPS_CLAUDE_CLEAR_HISTORY=1`。
- Codex：
  - MultipleShell 会为每个会话创建临时 `CODEX_HOME`：`%TEMP%/mps-codex-home-<sessionId>`（见 `ensureCodexHome()`）。
  - 这会导致 Codex 运行期写入的状态/历史天然“不落盘”（除非你设置 `MPS_KEEP_CODEX_HOME=1` 保留临时目录用于排查）。
- OpenCode：
  - 有 per-template 的 `.opencode.json`：`app.getPath('userData')/opencode-homes/<configId>/opencode/.opencode.json`（见 `syncOpenCodeProfileFiles()`，并在会话环境中设置 `XDG_CONFIG_HOME`）。
  - 会话/历史默认落在 `data.directory`（MultipleShell 默认注入为 `app.getPath('userData')/opencode-runtime/<configId>/`，其中包含 `opencode.db` 等）。

---

## 2. 你要的“历史会话”是哪一种？

建议先明确目标（可以同时做）：

1) **MultipleShell 级别历史（推荐先做）**
   - 重启后能看到“上次开的哪些 tab/用的什么模板/工作目录/开始结束时间/退出码/最后 N 行”
   - 支持“一键按同配置重开一个新会话”（不是续接原进程）
   - 可选：保存完整输出日志，支持回放/导出

2) **工具级别历史（Claude/Codex/OpenCode）**
   - 让工具自己支持“对话续接/历史命令/上次 session id”等
   - 通常需要：**不要清理 history 文件** 或 **把临时 home 变成稳定 home** 或 **在稳定 home 与临时 home 之间做白名单同步**

下面的方案以 (1) 为主，同时给出 (2) 的落点建议。

---

## 3. 约束与边界（必须接受的事实）

### 3.1 为什么“重启后续接同一个 PowerShell 会话”很难？

- `node-pty` 管的是一个子进程及其 PTY 句柄，应用退出后句柄关闭，子进程通常也会退出（本项目还会主动 kill）。
- 即便不 kill，跨进程重连也需要底层支持“重新 attach 到同一个 conpty”，这不是 `node-pty` 的常规能力。

### 3.2 想要真·续接，通常要走“常驻 Host”模型

你们已经有 Host/Client 结构（见 `src/main/agent` 与 `src/main/index.js` 的 `agent.role`）：这非常适合演进到：

- Host：常驻后台，持有所有 PTY，会话不断
- Client/UI：可多开、可关闭、可重启；重连后继续显示同一批会话

但这会涉及“关闭窗口不退出 Host”“托盘/后台服务”“升级/崩溃恢复”等一系列产品/工程决策。MVP 建议先做“会话记录 + 一键重开”。

---

## 4. 推荐方案（分两级，先易后难）

### 4.1 MVP：会话清单 + 状态摘要落盘（默认开启也相对安全）

**落盘内容（建议）**

- 会话元数据：`configId/type/name`、`workingDir`、`createdAt/startTime/endTime`、`exitCode/status`
- 状态摘要：复用 `shell-monitor` 的 `lastLines`/`lastErrorLine`/`outputLineCount`（只要几十行）

**重启后的体验**

- 新增一个“历史”面板：列出最近 N 次会话，显示状态/时长/最后几行
- 点击“重开”：以同模板 + 同工作目录创建一个新的 session

### 4.2 可选增强：输出日志（Transcript）落盘（默认建议关闭/显式开启）

如果你需要“像 tmux scrollback 一样”重启后还能回看完整输出，可以追加输出日志：

- 仅记录 `terminal:data`（输出）就能满足大多数“回放”诉求
- 记录 `terminal.write`（输入）会显著增加敏感信息风险（token/密码/私钥），建议默认不记录

---

## 5. 数据存储位置与格式（建议）

### 5.1 只让 Host 写入（符合现有多实例安全策略）

当前 Client 会切换到独立 `userData`（`ensureClientUserData()`），所以：

- **会话历史必须由 Host 写入 Host 的 `app.getPath('userData')`**
- Client/UI 通过 agent RPC 或 IPC 向 Host 拉取历史

### 5.2 目录结构（建议）

在 Host 的 `app.getPath('userData')` 下新增：

```
session-history/
  manifest.v1.enc            # 加密：会话清单/索引（小文件）
  logs/                      # 可选：输出日志（可能很大）
    <historyId>.jsonl
```

### 5.3 manifest（清单）数据模型（示例）

```jsonc
{
  "version": 1,
  "updatedAt": "2026-02-04T12:00:00.000Z",
  "items": [
    {
      "historyId": "uuid",
      "sessionId": "uuid",                // 运行时 sessionId（可选，仅用于追踪）
      "config": { "id": "...", "type": "codex", "name": "..." },
      "workingDir": "F:\\project",
      "createdAt": "ISO",
      "startTime": 1730000000000,
      "endTime": 1730000012345,
      "status": "completed|error|stopped",
      "exitCode": 0,
      "summary": {
        "outputLineCount": 123,
        "errorCount": 0,
        "lastErrorLine": "",
        "lastLines": ["... up to N ..."]
      },
      "log": { "enabled": true, "path": "logs/<historyId>.jsonl", "bytes": 1048576 }
    }
  ]
}
```

### 5.4 log（输出日志）格式（建议 JSONL）

JSONL 好处：可流式追加、无需一次性读写整个文件。

```jsonc
{"t":1730000000123,"type":"data","sid":"<sessionId>","data":"...raw chunk..."}
{"t":1730000000456,"type":"exit","sid":"<sessionId>","code":0}
```

> `data` 建议存 **原始 PTY chunk**（包含 ANSI 控制码），这样回放到 xterm 时显示一致；如果只想纯文本可额外存 `text`（strip ANSI）。

---

## 6. 主进程实现落点（建议改哪些文件）

### 6.1 新增模块：`src/main/session-history.js`

职责：

- 维护 manifest（加密存储，参考 `src/main/config-manager.js` / `src/main/draft-manager.js` 的 `safeStorage` 用法）
- 管理每个 session 的日志写入流（可选）
- 提供 API：`startSession() / onData() / onExit() / list() / get() / clear() / prune()`

### 6.2 Hook 点（关键：把“运行态事件”落到历史里）

建议最小接入点如下：

1) **会话创建**：`src/main/index.js`
   - 在 `ptyManager.createSession(...)` 成功后，立刻 `history.startSession({ sessionId, config, workingDir })`

2) **输出数据**：两种选法（二选一）
   - A（更靠近 PTY）：`src/main/pty-manager.js` 的 `ptyProcess.onData(...)`
   - B（更统一）：`src/main/index.js` 的 `sendFromHostPty('terminal:data', payload)`

   若你需要“Host/Client 都能录”，选 A 或 B 都可以；但**必须保证只在 Host 录**。

3) **进程退出**：`src/main/pty-manager.js` 的 `ptyProcess.onExit(...)`
   - `history.onExit(sessionId, exitCode)`

4) **用户主动 kill**：`src/main/index.js` 的 `terminal.kill` / `kill-terminal`
   - 也应该 `history.onExit(sessionId, /*synthetic*/ 143)` 或单独记录 `killed: true`

5) **摘要同步**：复用 `shellMonitor.on('update', ...)`
   - `src/main/index.js` 已监听 `shellMonitor.on('update', ...)`，这里可以把 `state.lastLines` 持久化到 manifest（节流写盘）

### 6.3 IPC / Agent 方法（给 UI 用）

新增（示例）：

- `history:list`：返回 manifest 的 items（可分页/按时间倒序）
- `history:get`：返回单条详情（含摘要、log 元信息）
- `history:streamLog`：读取 log 并按 chunk 返回（或直接让渲染进程读文件路径，但要注意 sandbox/安全）
- `history:clear` / `history:deleteOne`
- `history:restore`：给定 `historyId`，从记录里拿到 `configId + workingDir`，调用现有 `terminal.create`

多实例下：

- Host：实现真实逻辑
- Client：通过 `agent.call('history.list', ...)` 转发

---

## 7. 渲染进程 UI 建议（最小可用）

### 7.1 新增一个 History 面板

实现方式任选其一：

- 在 `App.vue` 增加 `uiMode = 'history'`，新建 `src/renderer/components/HistoryPanel.vue`
- 或把历史入口放进现有 `ConfigSelector` 的 `manage` 模式里

### 7.2 History 列表项建议展示字段

- 模板名（config.name）+ 类型（claude/codex/opencode）
- 工作目录
- 状态（completed/error/stopped）+ 时长
- 最后几行（来自 `shell-monitor` 的 `lastLines`）
- 操作：`重开` / `查看日志` / `删除`

### 7.3 日志回放（可选）

两种方案：

- **只读 xterm 回放**：复用 `Terminal.vue` 的渲染能力，但禁用键盘/鼠标输入，把 log 内容 `terminal.write(...)` 回放进去
- **纯文本查看器**：更轻量（strip ANSI），适合快速定位错误

---

## 8. 工具级别“历史会话”如何保留（Claude/Codex/OpenCode）

如果你的诉求是“AI 工具能续接上次对话”，优先看这一节。

### 8.1 Claude Code（已内置开关）

- 当前默认行为：保留 `claude-homes/<configId>/history.jsonl`，以便 Claude 使用其 history/session 机制。
- 如需避免自动续接旧会话：启动时设置环境变量清理历史：

```bash
set MPS_CLAUDE_CLEAR_HISTORY=1
```

> 这会在会话启动时删除模板 profile 下的历史记录，从而降低 Claude 自动续接旧会话的概率（取决于 Claude Code 版本与其策略）。

### 8.2 Codex（当前是“临时 CODEX_HOME”，天然不保留）

如果你希望 Codex 能恢复历史/状态，有三种路径：

1) **直接用稳定 CODEX_HOME（简单但有副作用）**
   - 把 `CODEX_HOME` 指到 `userData/codex-homes/<configId>`（而不是 temp）
   - 缺点：Codex 可能会改写其中的文件（项目里原本就是为避免这个才用 temp）

2) **白名单同步（推荐折中）**
   - 仍然运行在临时 `CODEX_HOME`
   - 会话启动前：从 `userData/codex-homes/<configId>/` 拷贝“历史/状态文件白名单”到 temp
   - 会话退出后：再把白名单文件从 temp 拷回持久目录
   - 这样既能保留历史，又避免 config/auth 源文件被漂移

3) **仅调试用途：保留 temp**
   - 设置 `MPS_KEEP_CODEX_HOME=1`，你会在 `%TEMP%/mps-codex-home-<sessionId>` 里看到 Codex 写了哪些历史/状态文件，然后再决定白名单要同步哪些

### 8.3 OpenCode

同样建议先确认 OpenCode 的状态/历史文件落在哪（可能在其 home 下，也可能在项目目录）。确认后可按“稳定 home”或“白名单同步”实现。

---

## 9. 安全与隐私（强烈建议写进产品默认行为）

终端输出/输入里非常容易出现：

- API Key / Token（含 Bearer）
- 私有代码、路径、用户名
- SSH 私钥片段、密码

因此建议：

- **默认只持久化“摘要”（lastLines）**，不存全量 transcript
- transcript 存储必须显式开启（设置项或环境变量），并提供“一键清空”
- manifest 使用 `safeStorage` 加密（与 configs/drafts 一致）
- transcript 若不加密，要在文档与 UI 明示风险；若要加密，需要考虑大文件的流式加密/解密成本
- 做“保留天数/最大条目/最大日志大小”与自动清理（prune）

---

## 10. 验收清单（建议）

MVP（摘要落盘）：

1. 打开 MultipleShell，新建 2 个会话并产生输出
2. 关闭窗口（触发退出），重新启动应用
3. “历史面板”能看到 2 条记录（含模板名/工作目录/状态/最后 N 行）
4. 点击“重开”，会创建一个新的 session（新 sessionId），工作目录与模板一致
5. 删除/清空历史正常；重启后不再出现

增强（输出日志）：

1. 开启 transcript 选项后重复上述流程
2. 退出重启后可回放 log，且渲染不卡顿（需要分页/流式）
3. 达到上限后自动清理旧日志，manifest 与 logs 一致不残留
