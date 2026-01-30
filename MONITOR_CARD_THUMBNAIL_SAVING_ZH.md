# MultipleShell 当前视图方案：缩略卡片/Thumbnail 与资源节省方案

MultipleShell 的“视图模式（View Mode）”不是截图式缩略图，而是“状态摘要卡片”。核心目标是在不打断终端会话的前提下，低开销地观察多个会话（`claude-code` / `codex` / `opencode`）的运行状态、是否空闲/卡住、是否完成/报错。

## 1. 当前实现对应的代码位置

- 视图核心（主进程）：`src/main/shell-monitor.js`
- 规则（主进程）：`src/main/shell-monitor-rules.js`
- PTY 接入（主进程）：`src/main/pty-manager.js`
- IPC 转发（主进程）：`src/main/index.js`（`monitor:update` + `monitor:getStates`）
- Preload API：`src/preload/index.js`（`monitorGetStates()` / `onMonitorUpdate()`）
- 视图面板（渲染进程）：`src/renderer/components/MonitorPanel.vue`
- 会话卡片（渲染进程）：`src/renderer/components/SessionThumbnail.vue`
- UI 集成：`src/renderer/App.vue`（`uiMode === 'monitor'`）

## 2. 卡片（缩略图）显示什么

每个会话一张卡片，展示以下“最小必要信息”（不做终端画面截图）：

- 基本：`sessionId`、`configType`（类型）、标题（Tab title/config name）
- 状态：`starting / running / idle / completed / stuck / error / stopped`
- 时长：`now - startTime`
- 活跃度：`now - lastActivityTime`
- 统计：`outputLineCount`、`errorCount`
- 文本预览：`lastLine`；当 `status === 'error'` 时优先显示 `lastErrorLine`

交互约定（当前实现）：

- 单击卡片：仅聚焦会话（更新 `activeTabId`），不强制切回 Shell
- 双击卡片或点击“打开”：切回 Shell 并打开对应会话

## 3. 状态机与判定（当前默认值）

主进程维护每个会话的状态机：

- 初始：`starting`（创建后，等待输出/活动）
- 有输出/活动：`running`
- 提示符命中：`idle`（或“完成 + 提示符”命中：`completed`）
- 超时兜底：
  - `idleMs = 30_000`：无输出/活动超过 30s 进入 `idle`
  - `stuckMs = 10 * 60_000`：无输出/活动超过 10min 进入 `stuck`
- 进程退出：
  - `exitCode === 0`：`completed`（若之前检测到 completion）或 `stopped`
  - `exitCode !== 0`：`error`

视图只基于进程事件与输出启发式判断；不尝试获取 AI 工具内部进度百分比。

## 4. 资源节省方案（卡片/缩略图的关键点）

### 4.1 不截图：用“摘要卡片”替代“终端画面缩略图”

- 不做高频截图（避免 CPU/GPU 负载与渲染抖动）
- 不把终端敏感信息（token/路径/私有代码）以图片形式持久化/扩散

### 4.2 只保留“最后 N 行”，不保留全量日志

- 主进程仅在内存中维护 `lastLines` 滑动窗口
- 默认 `maxLastLines = 20`（避免内存随输出量无限增长）
- 单行长度截断：默认 `maxLineLength = 2048`（避免单行超长输出导致内存飙升）
- 只额外维护 `lastLine / lastErrorLine` 与计数器，不做全量 scrollback 镜像

### 4.3 增量解析 + 增量匹配，避免重复扫描

- 对输出做规范化：去 ANSI、统一 CRLF/CR 为 LF
- 维护 `remainder` 断行缓冲：只对“新增行 + 尾巴”做规则匹配
- `remainder` 上限：默认 `maxRemainderChars = 4096`（避免无换行输出导致内存无限增长）
- 错误兜底命中采用 exclude 规则，降低误报

### 4.4 IPC/UI 节流，避免高频刷新

- 主进程更新节流：默认 `updateThrottleMs = 250`
- 只在 state 变更（dirty）时推送 `monitor:update`
- 渲染侧只做增量 apply（按 `sessionId` 更新/删除），并用 1s 时钟刷新“耗时/空闲时长”

### 4.5 额外边界

- 进程退出后“冻结状态”：忽略后续输出/输入（防止状态回写）
- UI 与视图链路仅传递“必要字段”，避免把完整输出通过 IPC 广播

## 5. 可选：终端画面（缩略图）预览（已实现，可在设置切换）

为满足“希望在视图面板里看到终端画面”的需求，应用提供了一个可选的“终端画面（缩略图）”模式：

- 入口：设置 -> 视图显示 -> 终端画面（缩略图）
- 行为：每个会话卡片展示一张“低分辨率终端截图”（不是完整可交互终端）

实现要点（当前代码）：

- 终端渲染：xterm 使用 `canvas` renderer（便于抓取画面）
- 抓取方式：从 xterm 的 canvas 取最大画布，按固定上限缩放后编码为 `webp/png`
- 节流：单会话抓取节流（默认约 300ms 一次；首帧更快；且仅在输出/清屏/resize 发生后 dirty 才抓取）
- 存储：仅内存（ObjectURL），不落盘；每次抓取会立即替换并释放上一张（不保留历史）；会话销毁或切回“卡片模式”会清理当前缩略图

注意：

- 该模式会增加 CPU/GPU/内存开销，默认仍建议使用“卡片（摘要）”
- 缩略图会直接暴露终端输出内容（敏感信息风险更高），请按场景选择是否启用

## 6. Prompt 稳定性增强：`__MPS_PROMPT__` 注入（已实现）

为提升 `promptDetected` 的稳定性（尤其是用户自定义 prompt / oh-my-posh 等场景），主进程会在 PowerShell 启动时注入一个“提示符标记”：

- 标记文本：`__MPS_PROMPT__`
- 触发方式：PowerShell 每次显示提示符时都会短暂输出该标记（并通过 `\r` + 清行尽量不影响终端显示）
- Monitor 侧处理：`__MPS_PROMPT__` 行不会计入 `outputLineCount`，也不会污染 `lastLine/lastLines`，仅用于 prompt 识别

如需禁用（排查 prompt 相关兼容性问题）：

- 环境变量：`MPS_DISABLE_PROMPT_MARKER=1`
