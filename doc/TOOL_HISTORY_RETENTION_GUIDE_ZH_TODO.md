# MultipleShell：Claude Code / Codex / OpenCode 工具历史留存落地待办清单（基于 TOOL_HISTORY_RETENTION_GUIDE_ZH.md）

面向目标：实现 **“工具级历史可留存 + 重启 MultipleShell 后可恢复/续接会话（取决于工具自身能力）”**，并确保“模板配置与运行态”分离，避免配置漂移/串历史。

参考文档：

- `TOOL_HISTORY_RETENTION_GUIDE_ZH.md`
- `SESSION_HISTORY_SOLUTION_ZH.md`（MultipleShell 自身会话历史）

说明：

- 本清单用于把方案落地到代码与默认行为中。
- 只有“实现 + 自测/验收通过”后才能把对应项从 `- [ ]` 改为 `- [x]`。

---

## 0. 验收标准（先锁定）

- [ ] **工具级历史留存**：Claude Code / Codex / OpenCode 三类模板，重启 MultipleShell 后用同模板重开会话，工具侧能读到上一轮留下的历史/状态文件（是否能“续接对话”取决于工具自身实现）。
- [ ] **隔离性**：不同模板之间不串配置、不串会话历史（尤其是 Claude 的 project settings / OpenCode 的项目本地配置覆盖）。
- [ ] **模板配置与运行态分离**：工具运行态写入的文件不会污染模板源文件；运行态可单独备份/清理。
- [ ] **隐私与清理策略明确**：默认是否保留工具历史、清理开关命名、清理范围在文档/README/代码中一致。

---

## 1. 目录与隔离（`userData`）

- [x] 目录约定落地：`claude-homes/<id>/`、`codex-homes/<id>/`、`codex-runtime/<id>/persist/`、`opencode-homes/<id>/opencode/`、`opencode-runtime/<id>/`（见 `src/main/config-manager.js` / `src/main/pty-manager.js`）。
- [x] OpenCode：创建 `opencode-runtime/<id>/` 并注入到 `.opencode.json` 的 `data.directory`（见 `src/main/config-manager.js` / `src/main/pty-manager.js`）。
- [x] Codex：补充稳定运行态目录：`codex-runtime/<id>/persist/`，用于白名单同步（见 `src/main/config-manager.js` / `src/main/pty-manager.js`）。
- [ ] 权限/安全：确认 Windows 下敏感文件（`auth.json`、各类历史文件）落地位置与访问权限策略（至少要可定位、可清理、可迁移）。

---

## 2. Claude Code（per-template profile）

- [x] 启动会话时设置 `CLAUDE_CONFIG_DIR=<profileHome>` 并隔离 `HOME/USERPROFILE` 到 `<userData>/claude-homes/<id>`（见 `src/main/pty-manager.js`）。
- [x] `.claude.json` 同步到 profile：复制并去除会话携带字段（`lastSessionId/projects`），避免串配置（见 `src/main/pty-manager.js`）。
- [x] 默认历史策略对齐：默认保留模板 profile 下的 `history.jsonl`；提供 `MPS_CLAUDE_CLEAR_HISTORY=1` 显式清理（见 `src/main/pty-manager.js`）。
- [x] 文档对齐：`README.md`、`doc/README.zh-CN.md`、`doc/SESSION_HISTORY_SOLUTION_ZH.md`、`doc/TOOL_HISTORY_RETENTION_GUIDE_ZH.md` 的开关名与默认值保持一致。
- [ ] 回归：当工作目录含 `./.claude/settings.json` 时，不应覆盖/干扰 per-template `CLAUDE_CONFIG_DIR` 的隔离策略；必要时在文档中明确“推荐默认工作目录”的行为。

---

## 3. Codex（临时 `CODEX_HOME` + 白名单同步）

- [x] 每会话临时 `CODEX_HOME=%TEMP%\\mps-codex-home-<sessionId>`，退出清理（`MPS_KEEP_CODEX_HOME=1` 可保留用于排查）（见 `src/main/pty-manager.js`）。
- [x] 模板源文件落地：`codex-homes/<id>/config.toml` 与 `codex-homes/<id>/auth.json`（见 `src/main/config-manager.js` / `src/main/pty-manager.js`）。
- [ ] 探测 Codex 写入文件（一次即可）：用 `MPS_KEEP_CODEX_HOME=1` 跑一轮，对比新增/变更文件，确定“历史/状态白名单”（只同步体积可控且确实影响续接/恢复的文件）。
- [x] 实现白名单同步（最小集）：
  - [x] 会话启动前：从 `codex-runtime/<id>/persist/` 复制白名单文件到临时 `CODEX_HOME`。
  - [x] 会话退出后：从临时 `CODEX_HOME` 把白名单文件拷回 `codex-runtime/<id>/persist/`。
  - [x] 默认覆盖：`history.jsonl`（可用 `MPS_CODEX_PERSIST_WHITELIST=...` 覆盖白名单）。
- [x] 冲突/并发策略：使用 per-template lock 文件 + delta 追加合并，避免同时写入覆盖（见 `src/main/pty-manager.js`）。
- [x] 清理开关：`MPS_CODEX_CLEAR_HISTORY=1`（会按白名单清理 `codex-runtime/<id>/persist/` 下的文件，避免误删 `codex-homes/<id>/` 模板源文件）。
- [ ] 自测：重启后同模板新会话具备恢复历史的基础能力（取决于 Codex 自身）。

---

## 4. OpenCode（SQLite + `data.directory`）

- [x] per-template `.opencode.json` 写入 `<userData>/opencode-homes/<id>/opencode/.opencode.json`（见 `src/main/config-manager.js` / `src/main/pty-manager.js`）。
- [x] 启动会话时设置 `XDG_CONFIG_HOME=<userData>/opencode-homes/<id>`（见 `src/main/pty-manager.js`）。
- [x] per-template 运行态目录：`data.directory=<userData>/opencode-runtime/<id>`，SQLite（含 WAL）自然持久化（见 `src/main/config-manager.js`）。
- [x] 提示/防踩坑：项目目录存在 `./.opencode.json` 时会覆盖全局配置；已在文档与 UI 提示中明确说明（见 `README.md` / `doc/README.zh-CN.md` / `src/renderer/components/ConfigEditor.vue`）。
- [ ] 回归：删除模板时同时清理 `opencode-runtime/<id>/`（实现已在 `src/main/config-manager.js`，补充验收验证）。

---

## 5. MultipleShell 自身“会话历史”（可选但推荐）

- [ ] MVP：落盘摘要 manifest（模板/工作目录/时间/退出码/最后 N 行），默认不存全量输出（降低泄露风险）。
- [ ] 增强：可选 transcript（显式开启 + 风险提示 + prune/上限策略）。
- [ ] 参考实现与验收：`doc/SESSION_HISTORY_SOLUTION_ZH.md`。

---

## 6. 端到端验收回归（建议脚本 + 手测）

- [ ] 端到端：分别启动 3 类工具产生会话/输出 → 退出应用 → 重启 → 同模板重开，验证历史/状态文件仍在且工具能读取。
- [ ] 隔离性：两个不同模板重复上述流程，确认不会串历史/串配置。
- [ ] 安全：确认不会把 token/key 意外同步到错误目录；清理开关不误删模板源文件。
