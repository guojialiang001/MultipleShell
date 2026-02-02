# MultipleShell Shell 视图实现待办（基于 SHELL_MONITORING_SOLUTION.md）

说明：
- 本清单用于落地 `SHELL_MONITORING_SOLUTION.md` 的“缩略卡片视图面板”方案。
- 只有“实现 + 自测/验收通过”后才能把对应项从 `- [ ]` 改为 `- [x]`。

## 0. 验收标准（先锁定）

- [x] 状态机枚举固定为：`starting / running / idle / completed / stuck / error / stopped`
- [x] 对外 state 字段固定为：`sessionId / configType / status / startTime / endTime / lastActivityTime / outputLineCount / errorCount / processExitCode / lastLine / lastErrorLine / lastLines`
- [x] 性能参数明确：`maxLastLines / maxLineLength / maxRemainderChars / updateThrottleMs`（含默认值）
- [ ] 性能验收：10+ 会话不卡顿（至少可用，需手测/压测 UI）
- [x] 隐私约束明确：默认不截图（卡片模式）、不落盘全量日志；可选“终端画面（缩略图）”但仍仅内存存放

## 0.1 资源节省方案清单（卡片/缩略图）

参考：`MONITOR_CARD_THUMBNAIL_SAVING_ZH.md` 与 `SHELL_MONITORING_SOLUTION.md` 的 4.4 节。

- [x] 默认不截图：卡片模式使用摘要卡片；可选“终端画面（缩略图）”模式（仅内存、低频抓取）
- [x] 只保留最后 N 行：`lastLines` 滑动窗口（默认 `maxLastLines=20`），不落盘全量日志
- [x] 单行长度截断：默认 `maxLineLength=2048`（避免超长单行输出导致内存飙升）
- [x] 增量解析/匹配：去 ANSI + 统一换行 + `remainder` 断行缓冲，仅对新增行做规则匹配
- [x] `remainder` 上限：默认 `maxRemainderChars=4096`（避免无换行输出导致内存无限增长）
- [x] 主进程节流推送：默认 `updateThrottleMs=250`，仅 dirty 时推送 `monitor:update`
- [x] 渲染端增量更新：按 `sessionId` diff apply；用 1s 时钟刷新“耗时/空闲时长”
- [x] IPC 字段最小化：`buildPublicState()` 仅暴露必要字段，避免全量输出通过 IPC 广播
- [x] 退出后冻结状态：进程退出后忽略后续 `onData/onUserInput/tick`（防止状态回写）

## 1. 规则与配置（monitor-rules）

- [x] 新增 `src/main/shell-monitor-rules.js`：内置默认规则（`claude-code / codex / opencode` + `ERROR_PATTERNS / ERROR_EXCLUDE_PATTERNS`）

## 2. 视图核心（ShellMonitor）

- [x] 新增 `src/main/shell-monitor.js`：实现 `ShellMonitor(EventEmitter)`
- [x] 实现会话生命周期：`registerSession / unregisterSession`
- [x] 实现输出规范化：去 ANSI、CRLF/CR 统一为 LF、remainder 断行缓冲
- [x] 实现 `lastLines` 滑动窗口（最大 `maxLastLines`），并维护 `lastLine / lastErrorLine`
- [x] 实现规则匹配：`promptPatterns / completionPatterns / errorPatterns` + 通用错误兜底（含 exclude）
- [x] 实现状态机转移：`starting→running→idle/stuck`；`completion+prompt→completed`；`exitCode!=0→error`；`exitCode==0→completed/stopped`
- [x] 实现 `onUserInput`：输入后重置 `completionDetected/promptDetected`，并把 `completed/idle/stuck` 拉回 `running`
- [x] 实现 `tick()`：按 `idleMs/stuckMs` 做超时判定（仅对 `starting/running` 生效）
- [x] 实现对外输出：`getAllStates()` 与 `update` 事件（仅暴露 public 字段）
- [x] 实现 update 节流/合并：`updateThrottleMs`（避免高频 IPC/渲染抖动）

## 3. 主进程集成（PTY + IPC）

- [x] 修改 `src/main/pty-manager.js`：创建会话时 `shellMonitor.registerSession(sessionId, config.type, meta)`
- [x] 修改 `src/main/pty-manager.js`：`ptyProcess.onData` 中调用 `shellMonitor.onData(sessionId, data)`
- [x] 修改 `src/main/pty-manager.js`：`ptyProcess.onExit` 中调用 `shellMonitor.onExit(sessionId, exitCode)`
- [x] 修改 `src/main/pty-manager.js`：`killSession/killAllSessions` 后视图状态能正确清理（无残留 session）
- [x] 修改 `src/main/index.js`：监听 `shellMonitor.on('update')` 并转发 `monitor:update` 到渲染进程
- [x] 修改 `src/main/index.js`：新增 `ipcMain.handle('monitor:getStates', ...)`
- [x] 修改 `src/main/index.js`：在 `write-terminal` 内调用 `shellMonitor.onUserInput(sessionId, data)`
- [x] 修改 `src/main/index.js`：启动定时器 `setInterval(() => shellMonitor.tick(), 1000)` 并确保退出时清理

## 4. Preload 暴露 API

- [x] 修改 `src/preload/index.js`：新增 `monitorGetStates()`
- [x] 修改 `src/preload/index.js`：新增 `onMonitorUpdate(callback)`（返回 unsubscribe）

## 5. 渲染进程 UI（缩略卡片面板）

- [x] 修改 `src/renderer/components/MenuBar.vue`：应用左上角增加模式切换（视图模式 / 多命令行窗口模式）
- [x] 修改 `src/renderer/App.vue`：新增 `uiMode('shell'|'monitor')`，并按模式切换布局（Shell=TabBar+Terminal，Monitor=视图大盘）
- [x] 无缝衔接：模式切换使用 `v-show`/`<KeepAlive>`，确保切换不卸载 Terminal（不丢 scrollback/历史输出）
- [x] 无缝衔接：从 Monitor 切回 Shell 后触发一次 `fit/resize`（避免 xterm 尺寸错误）
- [x] 新增 `src/renderer/components/MonitorPanel.vue`：grid 列表 + 统计（running/completed/stuck/error）
- [x] （可选）`MonitorPanel.vue`：折叠/收起面板（dock 形态）
- [x] 新增 `src/renderer/components/SessionThumbnail.vue`：单卡片展示（类型、状态、时长、活跃度、lastLine/lastErrorLine）
- [x] “终端画面（缩略图）”模式：基于 xterm canvas 抓取低分辨率截图（低频、缩放、随抓取随释放），在 Monitor 卡片中预览；设置项可切换“卡片 / 终端画面”
- [x] （可选）`SessionThumbnail.vue`：类型图标（Claude/Codex/OpenCode）
- [x] 修改 `src/renderer/App.vue`：挂载 `MonitorPanel`（布局/样式定稿）
- [x] `MonitorPanel.vue`：首次加载 `monitorGetStates()` 并订阅 `onMonitorUpdate()` 做增量更新
- [x] 修改 `src/renderer/App.vue`：视图模式下点击缩略图只聚焦（更新 `activeTabId`），不强制切换模式
- [x] （可选）缩略图提供“打开终端/进入会话”显式操作：触发 `uiMode='shell'` + `focus(sessionId)`
- [x] （可选）模式记忆：使用 `localStorage`/`draftManager` 记住上次模式

## 6. i18n 文案

- [x] 修改 `src/renderer/i18n/messages/zh-CN.js`：新增 monitor 相关文案键
- [x] 修改 `src/renderer/i18n/messages/en.js`：新增 monitor 相关文案键（与 zh-CN 对齐）

## 7. 测试与验收

- [x] 最小自测覆盖：normalize、规则匹配、状态机转移、tick（`npm run selfcheck:monitor`）
- [x] 回归自检：`killSession()` / “会话已退出但关闭 tab” 场景能正确 `unregister`（`node scripts/monitor-pty-selfcheck.js`）
- [x] 压力自检（monitor 核心）：10+ 会话 + 大量输出下 monitor 内存边界稳定（`node scripts/monitor-stresscheck.js`）
- [ ] UI 压力测试：10+ 会话、连续大输出（多 MB）下 UI 不明显掉帧
- [ ] 手工测试：同时开 3 个会话（claude-code/codex/opencode），面板状态随输出变化
- [ ] 手工测试：输入触发新一轮任务后，`completed/error` 能回到 `running`（粘性状态正确重置）
- [ ] 回归：关闭 tab / kill session 后视图卡片消失（无僵尸会话，UI 行为）

## 8. 文档与发布

- [x] 更新 `SHELL_MONITORING_SOLUTION.md`：补充 4.4 “资源节省与隐私策略（卡片/缩略图）”
- [x] 新增 `MONITOR_CARD_THUMBNAIL_SAVING_ZH.md`：沉淀“摘要卡片视图”节省方案与当前默认参数
- [x] 更新 `README.md`：补充“视图模式（缩略卡片）”入口/交互与节省策略说明
- [x] 更新 `SHELL_MONITORING_SOLUTION.md`：补充最终实现差异点、可配置项与排查/自检方式

## 可选增强（确认后再做）

- [x] PowerShell prompt 注入 `__MPS_PROMPT__`（提升 promptDetected 稳定性，可用 `MPS_DISABLE_PROMPT_MARKER=1` 关闭）
- [ ] 完成/错误桌面通知
- [ ] 历史统计（只存统计，不存全量输出）

## 已决定不做（当前版本）

- 不提供外部覆盖规则文件 `configs/monitor-rules.json`（规则仅维护在 `src/main/shell-monitor-rules.js`）
- 不做“规则加载失败/格式错误降级”逻辑（因为不读取外部规则文件）
