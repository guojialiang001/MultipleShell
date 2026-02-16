# MultipleShell 多 TAB AI 编排智能体：TODO（基于 PRD_MULTI_TAB_AI_AGENT_ZH.md）

说明：
- 本清单用于落地 `PRD_MULTI_TAB_AI_AGENT_ZH.md` 的 MVP（Planner TAB + Tool-Call）。
- 约定：只有“实现 + 自测/验收通过”后，才把对应项从 `- [ ]` 改为 `- [x]`。

## 0. 设计确认（先锁定）

- [ ] 明确 **主体AGENT（Main Agent）= Planner TAB**：Planner 直接复用现有配置模板启动（`claude-code` / `codex` / `opencode`），并约定 Tool-Call 输出格式。
- [ ] Tool-Call 载荷格式定稿：`__MPS_TOOL__ <json>` 与 `__MPS_TOOL_RESULT__ <json>`；是否需要 base64-json；是否需要 `nonce/signature` 防误触发。
- [ ] 最小工具集（MVP）定稿：`tabs.list / tabs.create / tabs.send / monitor.getStates / run.reportDraft`（可按实际收敛）。
- [ ] 风险确认策略定稿：哪些命令属于 `high/medium/low`；`high` 必须确认；确认弹窗展示信息与可配置项。
- [ ] 运行态数据落盘范围定稿：只存元数据（Goal/Plan/结论/命令清单）还是也存部分摘要；与现有“last N 行预览”隐私策略对齐。

## 1. 主进程（Host）落地（核心）

- [ ] 新增 `OrchestratorService`（建议放在 `src/main/`）：维护 Run/Worker/Planner 的内存态与生命周期（start/pause/stop）。
- [ ] 解析 Planner 输出的 Tool-Call 行：从 Planner 会话输出中提取 `__MPS_TOOL__ ...`，并确保不会污染摘要卡片（参考 `src/main/shell-monitor.js` 的 marker 过滤机制）。
- [ ] 执行 Tool-Call：基于现有能力实现最小工具集：
  - [ ] `tabs.list`：返回当前 sessions（可复用 `sessionRegistry` / `sessions.list`）。
  - [ ] `tabs.create`：根据 **现有配置模板** 创建 Worker TAB（复用 `src/main/config-manager.js` + `src/main/pty-manager.js#createSession`）。
  - [ ] `tabs.send`：向指定 TAB 写入文本（复用 `ptyManager.writeToSession`；同时记录到风险审计/报告草稿）。
  - [ ] `monitor.getStates`：读取摘要状态（复用 `shellMonitor.getAllStates()`）。
- [ ] Tool-Call 结果回写：以 `__MPS_TOOL_RESULT__ ...` 的形式回写给 Planner（明确“回写通道”：写入 Planner 会话输入流 vs 由 CLI 侧读取文件/pipe）。
- [ ] 多实例同步：所有 Run/Worker 的创建与写入必须由 Host 执行；Client 侧通过既有 agent RPC 请求（参考 `src/main/agent/` 与 `src/main/index.js` 的 `agent.call(...)` 转发模式）。

## 2. 数据与加密存储

- [ ] 定义 `team-presets.v1.enc` 与 `runs.v1.enc` 的 schema（参考 `src/main/config-manager.js` / `src/main/draft-manager.js` 的 safeStorage 加密写入）。
- [ ] 实现 Team Preset CRUD：创建/编辑/导出/导入（导入需校验与去重策略）。
- [ ] 实现 Run 元数据持久化：创建/更新/结束时落盘；默认不落盘完整终端输出。
- [ ] 历史回放（非必须）：至少能查看最近 N 次 Run 的元数据与报告草稿。

## 3. 渲染进程 UI（MVP 最小闭环）

- [ ] 新增 Team/编排入口：Goal 输入 + Preset 选择 + Start/Stop/Pause。
- [ ] Run 看板（Dashboard）：展示每个 Worker 的状态（running/idle/stuck/error/…）、最近摘要（lastLines）、阻塞点。
- [ ] 操作：对单个 Worker `send`，以及广播（快捷键：`Ctrl+Enter` / `Ctrl+Shift+Enter`）。
- [ ] “接管/聚焦”某个 Worker：点击看板条目切换到对应 TAB。
- [ ] 风险确认弹窗：命中 `high` 规则时阻断并要求确认；展示目标 TAB、命令片段、风险原因。
- [x] 主体AGENT输出面板（语音输入条下方）：显示 Tool-Call/Tool-Result/风控日志，提供输入框发送指令，并支持“绑定当前TAB”为主体AGENT。

## 4. 工具提示词与约定（让 Planner 真能用）

- [ ] 提供一份 Planner 启动时的“协议说明/系统提示词模板”（可放到 `doc/`），包含：
  - Tool-Call 的输出格式与字段含义
  - 何时输出 Tool-Call、何时等待 Tool-Result
  - 如何把 Tool-Result 纳入推理并继续拆解任务
- [ ] 提供至少 1 套 Team Preset 默认示例（Planner/Executor/Tester/Doc）。

## 5. 自检/验收

- [ ] 最小自检脚本：模拟 Planner 输出 Tool-Call 并验证 Host 执行与回写（建议放在 `scripts/`，可复用现有 selfcheck 风格）。
- [ ] 手测用例：创建含 2 个 Worker 的 Run；成功 `tabs.create`、`tabs.send`，看板能实时更新；多实例（Host/Client）下行为一致。
