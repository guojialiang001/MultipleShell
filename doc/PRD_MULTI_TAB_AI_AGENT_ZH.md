# PRD：多 TAB AI 编排智能体（MultipleShell 增强）

- 文档状态：草案
- 版本：v0.1
- 作者：（待填写）
- 更新日期：2026-02-15
- 适用范围：MultipleShell（Electron + Vue + xterm.js + node-pty）
- 代办清单：[PRD_MULTI_TAB_AI_AGENT_TODO_ZH.md](PRD_MULTI_TAB_AI_AGENT_TODO_ZH.md)
- 提示词模板：[PRD_MULTI_TAB_AI_AGENT_PROMPTS_ZH.md](PRD_MULTI_TAB_AI_AGENT_PROMPTS_ZH.md)

## 1. 背景与问题

MultipleShell 已具备「多标签终端 + 模板化启动（Claude Code / Codex / OpenCode）+ 视图模式摘要卡片 + 多实例 Host/Client 同步 + 语音输入 + 加密存储」等能力。当前痛点在于：

1. **复杂目标需要多会话协作**：用户经常需要同时开多个 TAB（写代码/跑测试/查日志/写文档/对比方案），但 TAB 之间的协调依赖人工切换与复制粘贴。
2. **多智能体难以编排**：Claude Code/Codex/OpenCode 各自擅长不同环节（规划/实现/测试/复盘），但目前缺少一个“控制平面”把它们组织成可重复的工作流。
3. **状态分散**：当前 View 模式能看见摘要，但缺少“任务级”状态（目标、计划、子任务、责任人、产出物）与最终报告。

因此需要一个“AI 编排智能体（Orchestrator）”，能基于用户目标**创建/管理多 TAB**，并把每个 TAB 视为一个可协作的“工作智能体（Worker）”，完成拆解、分派、执行与汇总。

## 2. 目标（Goals）

### 2.1 产品目标

- 让用户用一句话目标启动一个「多 TAB + 多智能体」的协作运行（Run）。
- Orchestrator 能自动拆解目标为可并行子任务，分派给不同 Worker TAB，并跟踪进度。
- 运行过程中提供**可视化任务看板 + 关键输出汇总**，最终生成可复制的“运行报告”。
- 全程遵循 MultipleShell 既有安全/隐私策略：**最小日志留存、加密存储、敏感操作确认**，并兼容 Host/Client 多实例同步模型。

### 2.2 体验目标（示例）

- 从“输入目标”到“所有 TAB 就位并开始工作”≤ 30 秒（在已有模板配置的前提下）。
- 用户无需频繁切 TAB：通过看板即可看到每个 Worker 的状态/最近产出/阻塞点。
- 支持随时“接管某个 Worker TAB”，以及把指令广播给所有 Worker。

## 3. 非目标（Non-goals）

- 不做 OS 级强沙箱（不保证彻底阻止智能体在其进程内执行任意命令）；MVP 以 **人机确认 + 规则策略 + 复用上游工具自身的安全机制** 为主。
- 不替代现有的模板系统；Orchestrator 复用现有 `claude-code` / `codex` / `opencode` 模板与会话隔离策略。
- 不做通用“屏幕/网页自动化”；本 PRD 聚焦在 **MultipleShell 的 TAB/PTY 会话编排**。

## 4. 术语与概念

- **TAB/会话（Session）**：MultipleShell 中一个终端实例（xterm.js + node-pty）。
- **Worker（工作智能体）**：一个 TAB 内运行的工具/智能体（如 claude-code/codex/opencode），承担具体子任务。
- **Orchestrator（编排智能体）**：负责把用户目标拆解、分派给 Worker，并汇总结果的控制逻辑（可内置/可由某个“Planner TAB”驱动）。
- **Main Agent（主体AGENT）**：MVP 形态下的“Planner TAB”，作为 Orchestrator 的外置大脑；它**直接复用现有配置模板**（`claude-code` / `codex` / `opencode` 之一）启动，并通过 Tool-Call 协议驱动 Host 执行操作。
- **Run（一次运行）**：从“用户目标”开始，到“结果报告”结束的一次编排流程；包含多个 Worker。
- **Team Preset（团队预设）**：一组可复用的角色配置（角色->模板->默认工作目录/权限策略）。

## 5. 用户画像与核心场景

### 5.1 目标用户

- 本地开发/调试的工程师：需要同时跑服务、看日志、写代码、跑测试。
- 使用 AI CLI 工具的工程师：在不同任务阶段切换 Claude Code/Codex/OpenCode。
- 需要在 RDP/RemoteApp 多实例环境中工作的用户：希望跨实例看到一致的任务状态。

### 5.2 核心场景（Top）

1. **“实现一个功能 + 跑测试 + 写变更说明”**：Orchestrator 同时启动实现 Worker、测试 Worker、文档 Worker，并在看板汇总产出。
2. **“定位线上/本地 bug”**：一组 Worker 分别负责复现、日志分析、最小化用例、修复验证。
3. **“多方案对比”**：多个 Worker 各自提出方案/风险/落地步骤，Orchestrator 汇总对比表。

## 6. 方案概览

### 6.1 入口与总体流程

新增入口：`Team / 编排`（可作为新模式或 Shell 模式侧边面板）。

基本流程：

1. 用户输入目标（Goal），选择 Team Preset（或手动配置角色）。
2. 创建 Run：自动创建若干 Worker TAB（来自模板）并标注角色。
3. Orchestrator 下发首轮指令（Prompt/任务卡）给各 Worker。
4. Orchestrator 持续采集 Worker 状态（复用现有 Monitor：lastLines/status/cwd/错误计数），必要时追加追问/补充信息。
5. 用户可随时介入：暂停/继续/终止 Run、接管某个 Worker、批准风险操作。
6. Run 结束：生成结构化报告（目标、完成项、产出物、未解决问题、复现/验证步骤）。

### 6.2 两种实现形态（建议先 MVP 后扩展）

#### A. MVP（推荐）：Planner TAB + 工具调用协议（Tool-Call）

- 新建一个“Planner/Orchestrator TAB”（即 **Main Agent/主体AGENT**）：**直接复用当前已有配置模板**（`claude-code` / `codex` / `opencode` 之一）启动；无需新增模板类型。
- MultipleShell 提供一套**结构化工具调用协议**：Planner 在终端输出特定标记行请求操作；主进程解析并执行（创建 TAB、发送消息、读取摘要等），再把结果回写给 Planner。
- 优点：不引入新的 LLM SDK/鉴权；复用现有 AI CLI 的推理能力；工程改动集中在“协议 + 工具集 + UI 看板”。
- 风险：需要为各类 AI CLI 适配“输出工具调用”的方式（可通过系统提示词/启动脚本/文档约定缓解）。

#### B. V1+：内置 Orchestrator（主进程/服务层 LLM）

- Orchestrator 直接调用 LLM（可选接入 CC Switch/代理策略），无需 Planner TAB。
- 优点：更稳定可控；UI 交互更原生；可做更强的策略与回放。
- 风险：需要新增 API Key 管理、计费/速率限制、网络失败策略等。

本 PRD 以 **A 作为 MVP**，并在“开放问题”里保留 B 的演进空间。

## 7. 功能需求（按优先级）

### 7.1 P0（MVP 必须）

#### FR-001 创建 Run（目标 -> 团队）

- 用户输入 `Goal`（文本；支持从语音转写填充）。
- 选择 `Team Preset`：
  - 最少包含 2 个角色：`Planner`、`Executor`
  - 可扩展角色：`Tester`、`Reviewer`、`Doc`
- 每个角色绑定一个“配置模板”（claude-code/codex/opencode 之一）与默认工作目录（可选）。
- 点击开始后：自动创建对应 TAB，并在 TAB 标题/徽标上标注角色。

#### FR-002 Run 看板（任务级状态）

- 列出所有 Worker：
  - 角色、TAB 名称、工具类型、状态（running/idle/stuck/completed/error）、当前 cwd（若可得）、最近 N 行摘要（复用 Monitor lastLines）。
- 支持操作：
  - 聚焦 TAB
  - 发送消息（对单个 Worker / 广播）
  - 标记“已完成/阻塞/需要用户输入”
  - 结束 Run（可选：仅结束编排，不强制杀掉所有 TAB；或一键关闭全部 Worker）

#### FR-003 基础编排（首轮分派 + 汇总）

- Orchestrator 能完成最小闭环：
  - 把 Goal 变成 2~5 条可执行子任务（计划文本）。
  - 对每个子任务指定负责 Worker，并向对应 TAB 注入指令（相当于“代用户输入一段提示词”）。
  - 监听 Worker 的完成信号（可先用人工按钮 + completion pattern 的组合），生成“Run 报告草稿”。

#### FR-004 Tool-Call 协议（Planner TAB 控制多 TAB）

定义协议（建议）：

- Planner 输出一行：`__MPS_TOOL__ <json>`（或 base64-json），触发工具调用。
- 主进程执行后回写一行：`__MPS_TOOL_RESULT__ <json>` 到 Planner TAB。

MVP 工具集（最小可用）：

- `tabs.list`：列出当前 Run 的 Worker 列表与状态摘要
- `tabs.create`：按模板创建新 Worker TAB（参数：role/templateId/workingDir）
- `tabs.send`：向指定 TAB 发送输入（参数：tabId/text/enter）
- `tabs.read`：读取指定 TAB 最近 N 行输出摘要（复用 Monitor，不落盘）
- `run.report_draft`：写入/更新 Run 报告草稿片段（便于 UI 展示）

安全要求：

- 默认对 `tabs.send` 的“危险命令”启用二次确认（见 FR-006）。

#### FR-005 与 Host/Client 同步兼容

- Run 状态属于“有状态写入/副作用”，必须遵循现有模型：**Host 负责持久化与执行，Client 仅通过 RPC 操作**。
- Client 打开看板可实时看到 Run 状态与 Worker 摘要（复用现有实时同步通道/机制）。

#### FR-006 风险操作确认（人机协作）

新增“风险等级”策略（MVP 规则即可）：

- 对通过 Orchestrator 执行的下发输入（`tabs.send`）做本地规则检测：
  - 命中高风险：`rm`, `del`, `rmdir`, `Remove-Item -Recurse`, `format`, `diskpart`, `reg delete`, `shutdown`, `Stop-Computer`, `git reset --hard`, `git clean -fdx` 等
  - 或包含系统敏感路径（与现有“工作目录拦截”策略一致）
- 命中时在 UI 弹窗要求用户确认（可展示即将发送的命令片段与目标 TAB）。

> 说明：该确认仅覆盖“通过 Orchestrator 下发”的输入，不保证拦截 Worker 进程内部自行执行的命令；需配合上游工具自身的确认机制与提示词约束。

### 7.2 P1（增强体验）

- FR-101 Team Preset 管理：创建/编辑/导出/导入团队预设（加密存储；可分享为 JSON）。
- FR-102 自动重试与“卡住”处理：Worker stuck 时自动追问/重启 Worker（需用户允许）。
- FR-103 产出物收集：支持把关键内容归档到 Run 报告（例如：补丁摘要、测试结果、命令清单、待办清单）。
- FR-104 角色协作模板：内置常见团队（实现+测试+文档、排障三件套、方案对比等）。
- FR-105 Run 历史：加密保存 Run 元数据（目标/角色/结论/关键链接），不保存完整终端日志。

### 7.3 P2（长期演进）

- FR-201 内置 Orchestrator LLM（无 Planner TAB）。
- FR-202 更细粒度权限：按角色/模板配置允许的工具与命令范围。
- FR-203 远程模式联动：Run 报告可生成 Remote/Guacamole 深链（用于把结论带到移动端）。

## 8. 交互与信息架构（IA）

### 8.1 新增 UI 模块

- `Team 面板`（建议可停靠/浮层，类似现有 View 面板体验）：
  - 顶部：Goal 输入框 + Team Preset 选择 + Start/Stop/Pause
  - 中部：Worker 列表（状态、最近摘要、操作按钮）
  - 底部：Run 报告草稿（可复制、可一键发送到某个 Worker 继续完善）

### 8.2 关键交互细节

- **消息发送**：支持快捷键 `Ctrl+Enter` 发送到当前选中 Worker；`Ctrl+Shift+Enter` 广播。
- **接管**：用户聚焦某个 Worker TAB 后，仍可随时从看板发送指令，不打断终端正常交互。
- **可解释性**：Orchestrator 在看板中展示“当前计划/下一步/等待用户输入点”。

## 9. 数据与存储

### 9.1 数据分类与原则

- 仅加密存储：
  - Team Preset（角色绑定模板、默认工作目录、策略）
  - Run 元数据（目标、开始/结束时间、结论、关键步骤/命令清单）
- 不落盘（默认）：
  - 完整终端输出（遵循现有“缩略卡片仅保留 last N 行”的隐私原则）

### 9.2 建议的数据结构（示例）

- `team-presets.v1.enc`
- `runs.v1.enc`

字段建议：

- `Run`：`id, goal, createdAt, updatedAt, status, workers[], plan[], reportDraft, risks[]`
- `Worker`：`tabId, role, templateId, configType, workingDir, statusSnapshot`

## 10. 技术方案（MVP 取向）

### 10.1 架构位置

- **主进程（Host）**：实现 `OrchestratorService`（创建 Run、解析 Tool-Call、驱动 tabs、持久化加密存储、同步到 Client）。
- **渲染进程**：实现 Team 面板 UI（展示 Run 状态、发送操作）。
- **复用现有能力**：
  - 会话管理：PTY manager（创建/写入/关闭）
  - 状态摘要：Shell monitor（status/lastLines/cwd）
  - 多实例：现有 Host/Client agent 通道
  - 加密存储：safeStorage（参考 drafts/config 的实现）

### 10.2 Tool-Call 协议细节（建议）

**请求行：**

- 前缀：`__MPS_TOOL__`
- 载荷：JSON（建议包含 `id`、`method`、`params`）

示例：

```text
__MPS_TOOL__ {"id":"t1","method":"tabs.list","params":{"runId":"r1"}}
```

**返回行：**

```text
__MPS_TOOL_RESULT__ {"id":"t1","ok":true,"result":{"tabs":[...]}}
```

约束：

- 必须是单行，避免输出被分割；必要时用 base64 包裹 JSON。
- MVP 落地建议：主进程以“向 Planner TAB 注入一行输入（模拟回车）”的方式回注 Tool Result，使 Planner 将其作为下一条输入消息处理。
- 解析失败应忽略（不影响普通终端输出）。
- 该类 marker 行不进入“缩略卡片 lastLines”（与 `__MPS_PROMPT__`、`__MPS_CWD__` 同类处理）。

### 10.3 风险确认策略（建议）

- 在执行 `tabs.send` 前，对 `text` 做规则扫描并计算风险等级：`low/medium/high`。
- `high` 必须弹窗确认；`medium` 可设置为确认/不确认；`low` 默认放行。
- 弹窗内容：目标 TAB、将发送的命令片段、风险原因（命中规则）。

## 11. 指标（Metrics）与验收标准（Acceptance Criteria）

### 11.1 核心指标

- Run 创建成功率（创建 Worker TAB 并进入可交互状态）
- 平均 Run 时长、手动切 TAB 次数（可选：近似统计）
- Worker “stuck” 发生率与恢复率
- 用户满意度（可选问卷）

### 11.2 MVP 验收（必须满足）

- 能创建一个 Run，至少包含 2 个 Worker TAB，并在看板看到实时状态与摘要。
- Planner TAB 能通过 Tool-Call 创建/列出/发送消息到 Worker，并收到 Tool 结果回写。
- Run 报告草稿可生成并可复制导出。
- 对命中高风险命令的 `tabs.send` 必须弹窗确认。
- 在 Host/Client 多实例下：Client 能看到 Run 看板状态；所有写入/执行仍由 Host 统一完成。

## 12. 里程碑（Milestones）

- M0（设计评审）：确认 Team Preset、Tool-Call 协议与安全策略
- M1（MVP）：Run + Team 面板 + Tool-Call 最小工具集 + 报告草稿 + 风险确认
- M2（体验增强）：Preset 管理、卡住处理、Run 历史（元数据）
- M3（演进）：内置 Orchestrator LLM（可选）、更细粒度权限

> 日期待排期；建议每个里程碑保持可独立交付与可回滚。

## 13. 风险与对策

- **不同 AI CLI 的可控性差异**：优先通过“提示词约定 + 工具调用协议”实现；必要时提供启动脚本/模板参数辅助。
- **输出解析不稳定**：Tool-Call 采用强标记前缀 + 单行载荷 + base64 可选；解析失败不影响终端体验。
- **安全风险**：默认高风险命令确认；并在文档中明确“无法 OS 级隔离”的边界，鼓励启用上游工具自带确认机制。
- **性能与隐私**：沿用现有“仅保留 last N 行摘要”的策略；不保存完整日志；节流更新。

## 14. 开放问题（待确认）

1. MVP 的 Planner TAB 默认用哪个工具类型更合适（codex / claude-code / opencode）？是否允许用户选择？
2. Tool-Call 的载荷格式：纯 JSON vs base64-json；是否需要签名/nonce 防止误触发？
3. Worker 的“完成”判定：依赖 completion pattern + 手动按钮，还是增加显式 `run.complete` 工具调用？
4. Run 报告的导出形态：仅复制 Markdown，还是生成文件/分享到剪贴板/打开新 TAB？
5. 是否需要把 Team Preset 与现有 Config Template 管理界面合并，还是独立入口？
