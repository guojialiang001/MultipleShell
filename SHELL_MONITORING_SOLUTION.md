# MultipleShell 视图方案：缩略图模式监测三大类型执行状态

## 概述

本方案为 MultipleShell 增加一个“缩略卡片（Thumbnail）视图面板”，用于实时观察三种配置类型（`claude-code` / `codex` / `opencode`）会话的运行状态、就绪/完成信号与异常情况。

说明：默认的“缩略图”不是终端画面截图，而是状态摘要卡片（图标 + 时长 + 输出活跃度 + 最后一行/错误提示）。这样可以：
- 默认避免渲染端高频截图导致卡顿
- 默认避免把终端中的敏感信息（token/路径/私有代码）以图片形式持久化
> 可选：应用内可切换“终端画面（缩略图）”预览模式（低频抓取、缩放、仅内存、不落盘、不保留历史）。

### 目标（我们要得到什么）

- 同屏快速判断：哪个会话在跑、哪个已就绪/完成、哪个报错、哪个疑似卡住
- 多会话低开销：只保留少量统计与最后 N 行文本，避免占用大量内存
- 可配置规则：不同工具/版本输出差异较大，完成/错误规则必须可调整
- 与现有架构契合：复用 `terminal:data` / `terminal:exit` / `write-terminal` 事件链路

### 非目标（本方案不解决）

- 读取 Claude/Codex/OpenCode 的“内部进度百分比”
- 语义级任务是否“真的做完”：只能基于进程事件与输出做启发式判断

## 一、视图可行性分析

### ✅ 可以监测的内容

1. **进程状态观察**
   - PTY 进程是否存在
   - 进程退出码（正常/异常退出）
   - 进程运行时长

2. **输出流观察**
   - 终端输出内容实时捕获
   - 关键字匹配（成功/失败/错误标识）
   - 输出行数统计

3. **配置状态观察**
   - 配置文件加载状态
   - 环境变量设置状态
   - 临时目录创建状态

4. **会话活动观察**
   - 最后活动时间
   - 用户输入频率
   - 命令执行次数

### ⚠️ 难以监测的内容

1. **AI 工具内部状态**
   - Claude Code/Codex/OpenCode 的内部任务队列
   - AI 模型响应进度
   - 具体任务完成百分比

2. **语义级别的"完成"**
   - 需要解析 AI 工具的特定输出格式
   - 不同工具的完成标识不统一

### ✅ 实现前提与边界

- PTY 层能够提供每个会话的 `onData` / `onExit` / `pid` 等元数据（node-pty 的 data 流通常是混合流，可按统一输出处理）
- 会话创建时可拿到 `config.type`（本项目内置：`claude-code` / `codex` / `opencode`），用于选择对应规则
- 能在 `write-terminal`（用户输入）处打点：用于更可靠地判断“这一轮任务是否结束/回到提示符”
- UI 侧支持节流/批量更新，避免高频刷新导致卡顿

## 二、视图架构设计

```
┌─────────────────────────────────────────────────────────┐
│                   缩略图视图面板                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │Claude Code│  │  Codex   │  │ OpenCode │              │
│  │  [运行中] │  │  [完成]  │  │  [错误]  │              │
│  │  ████░░░  │  │  ██████  │  │  ███░░░  │              │
│  └──────────┘  └──────────┘  └──────────┘              │
└─────────────────────────────────────────────────────────┘
                        ↑
                   视图数据收集
                        ↓
┌─────────────────────────────────────────────────────────┐
│              Shell 视图服务 (新增)                        │
│  ┌─────────────────────────────────────────────────┐   │
│  │  - 输出流解析器 (Output Parser)                  │   │
│  │  - 状态检测器 (Status Detector)                  │   │
│  │  - 事件聚合器 (Event Aggregator)                 │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                        ↑
                   数据源 (现有)
                        ↓
┌─────────────────────────────────────────────────────────┐
│  PTY Manager + Terminal Sessions                        │
│  - 进程事件 (exit, data, error)                         │
│  - 输出流数据 (stdout/stderr)                           │
│  - 会话元数据 (sessionId, configType, startTime)        │
└─────────────────────────────────────────────────────────┘
```

## 三、视图指标定义

### 3.1 基础状态

| 状态 | 图标 | 颜色 | 触发条件 |
|------|------|------|----------|
| 未启动 | ⚪ | 灰色 | 会话未创建 |
| 启动中 | 🔵 | 蓝色 | 进程已创建，等待首次输出 |
| 运行中 | 🟢 | 绿色 | 进程活跃，有输出流动 |
| 空闲 | 🟡 | 黄色 | 检测到“提示符返回/等待输入”（推荐），或超过 `idleMs` 无输出（兜底） |
| 卡住 | 🟠 | 橙色 | 超过 `stuckMs` 无输出且未检测到提示符（疑似卡死/无响应） |
| 完成 | ✅ | 绿色 | 检测到明确完成标识（可配置）；或退出码为 0 且无错误信号（可选） |
| 错误 | 🔴 | 红色 | 退出码非 0；或命中严重错误标识（可配置） |
| 已停止 | ⚫ | 黑色 | 进程退出/被终止（退出码 0 但未命中完成标识时可归为 stopped） |

补充约定（建议）：
- `completed`/`error`/`stopped` 为“粘性状态”，直到下一次用户输入（新一轮任务）才被重置为 `running`。
- 默认只在状态变化或节流窗口到期时推送 UI 更新，避免每个 output chunk 都触发渲染刷新。

### 3.2 三大类型的规则体系（提示符 / 完成 / 错误）

建议把规则拆分为三类（均可配置），并基于“新增行”做增量匹配（不要每次扫描全缓冲）：
- `promptPatterns`：提示符/等待输入（优先级高于纯超时的 idle 判断）
- `completionPatterns`：明确成功完成（用于把 idle 升级为 completed）
- `errorPatterns`：明确失败/异常（可分级：soft/hard）

规则强烈建议做成可配置文件（例如 `configs/monitor-rules.json`），并内置默认规则作为兜底。原因是：不同工具版本、不同语言/地区、不同 prompt 主题会导致输出差异非常大。

提示符识别增强（可选但推荐）：
- PowerShell 的默认提示符格式并不稳定（用户可能使用 oh-my-posh、自定义 prompt 等）
- 推荐在会话启动时注入一个不易冲突的 prompt 标记（例如 `__MPS_PROMPT__`），让 monitor 能稳定识别“回到提示符”
  - 当前实现：已内置 `__MPS_PROMPT__` 注入；如需禁用可设置环境变量 `MPS_DISABLE_PROMPT_MARKER=1`

#### Claude Code (`claude-code`) 规则示例
```javascript
{
  promptPatterns: [
    // PowerShell 默认提示符（兜底）
    /(?:^|\n)PS [^>\r\n]+>\s*$/m,
    // 可选：自定义提示符注入（推荐）
    /(?:^|\n)__MPS_PROMPT__\b.*$/m
  ],
  completionPatterns: [
    /\bTask completed\b/i,
    /\bAll tests passed\b/i,
    /\bBuild succeeded\b/i,
    /✓\s*(?:Done|Completed)\b/i
  ],
  errorPatterns: [
    /\bUnhandled (?:exception|error)\b/i,
    /\bTraceback \(most recent call last\)\b/i,
    /\bpanic:\b/i
  ]
}
```

#### Codex (`codex`) 规则示例
```javascript
{
  promptPatterns: [
    /(?:^|\n)PS [^>\r\n]+>\s*$/m,
    /(?:^|\n)__MPS_PROMPT__\b.*$/m,
    /(?:^|\n)codex>\s*$/mi
  ],
  completionPatterns: [
    /\bOperation completed\b/i,
    /\bAll tests passed\b/i
  ],
  errorPatterns: [
    /\bOpenAI\b.*\b(unauthorized|forbidden)\b/i
  ]
}
```

#### OpenCode (`opencode`) 规则示例
```javascript
{
  promptPatterns: [
    /(?:^|\n)PS [^>\r\n]+>\s*$/m,
    /(?:^|\n)__MPS_PROMPT__\b.*$/m,
    /(?:^|\n)opencode>\s*$/mi
  ],
  completionPatterns: [
    /\bSuccessfully completed\b/i,
    /\bAll operations done\b/i
  ],
  errorPatterns: [
    /\bpermission\b.*\bdenied\b/i
  ]
}
```

### 3.3 错误标识（通用兜底 + 排除项）

```javascript
// 注意：尽量加上边界，避免把“0 failed / no error”这类成功信息误判为失败。
ERROR_PATTERNS: [
  /\bfatal\b/i,
  /\bpanic\b/i,
  /\b(unhandled|uncaught)\b.*\b(exception|error)\b/i,
  /\bexception\b/i,
  /\berror\b/i,
  /\bpermission denied\b/i,
  /\btimeout\b/i,
  /\bExit code:\s*[1-9]\d*\b/i
],
ERROR_EXCLUDE_PATTERNS: [
  /\b0 failed\b/i,
  /\bno errors?\b/i,
  /\berrors?:\s*0\b/i
]
```
### 3.4 判定策略优先级（建议）

- 退出码优先：非 0 直接判定错误；0 进入完成/停止判定
- 严重错误标识（hard error）可直接置为 `error`（建议分级）
- 明确完成标识优先于空闲判断（将 idle 升级为 completed）
- 提示符返回优先于“纯超时”空闲判断（更快、更稳定）
- 空闲只代表“暂无输出/等待输入”，不等同于“成功完成”
- 用户输入是新一轮任务起点：收到 `write-terminal` 后应重置粘性状态（completed/error）回到 running


## 四、实现方案

### 4.1 新增文件结构

```
src/
├── main/
│   ├── shell-monitor.js          # 新增：Shell 视图服务（状态机 + 规则引擎）
│   └── shell-monitor-rules.js    # 新增：内置默认规则（可被用户配置覆盖）
├── preload/
│   └── index.js                  # 追加：monitor IPC API
├── renderer/
│   └── components/
│       ├── MonitorPanel.vue      # 新增：缩略图视图面板
│       └── SessionThumbnail.vue  # 新增：单个会话缩略图
```
可选（推荐）：`configs/monitor-rules.json`（用户可编辑的规则覆盖文件）。

### 4.2 核心代码实现

#### 4.2.0 输出规范化处理（建议实现）

```text
normalize(data):
  text = stripAnsi(toString(data))
  text = text.replace("\r\n", "\n").replace("\r", "\n")
  text = remainder + text
  lines = text.split("\n")
  remainder = lines.pop()
  return { lines, remainder }
```

要点:
- 去除 ANSI 控制码，统一换行符
- 维护会话级残余行缓冲，避免 chunk 断行导致统计/匹配失真
- stdout/stderr 走同一规范化流程，但保留来源用于诊断

#### 4.2.1 Shell 视图服务 (`shell-monitor.js`)

```javascript
const { EventEmitter } = require('events')
const { RULES_BY_TYPE, ERROR_PATTERNS, ERROR_EXCLUDE_PATTERNS } = require('./shell-monitor-rules')

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g
const stripAnsi = (s) => String(s || '').replace(ANSI_RE, '')

class ShellMonitor extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.sessions = new Map() // sessionId -> state
    this.options = {
      idleMs: 30_000,
      stuckMs: 10 * 60_000,
      maxLastLines: 20,
      maxLineLength: 2048,
      maxRemainderChars: 4096,
      updateThrottleMs: 250,
      ...opts
    }
  }

  isFinal(status) {
    return status === 'stopped' || status === 'error'
  }

  registerSession(sessionId, configType, meta = {}) {
    this.sessions.set(sessionId, {
      sessionId,
      configType,
      status: 'starting',
      startTime: Date.now(),
      endTime: null,
      lastInputTime: null,
      lastOutputTime: null,
      lastActivityTime: Date.now(),
      outputLineCount: 0,
      errorCount: 0,
      completionDetected: false,
      promptDetected: false,
      processExitCode: null,
      lastLine: '',
      lastErrorLine: '',
      lastLines: [],
      remainder: '',
      _dirty: true,
      _notifyTimer: null,
      ...meta
    })
    this.queueNotify(sessionId)
  }

  unregisterSession(sessionId) {
    this.sessions.delete(sessionId)
    this.emit('update', { sessionId, state: null })
  }

  onUserInput(sessionId, data) {
    const state = this.sessions.get(sessionId)
    if (!state || this.isFinal(state.status)) return

    state.lastInputTime = Date.now()
    state.lastActivityTime = state.lastInputTime

    // 新一轮任务：重置粘性标记
    state.completionDetected = false
    state.promptDetected = false

    if (state.status !== 'starting') state.status = 'running'
    state._dirty = true
    this.queueNotify(sessionId)
  }

  normalizeLines(state, data) {
    const text = stripAnsi(data).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const merged = state.remainder + text
    const parts = merged.split('\n')
    state.remainder = parts.pop() || ''
    return parts.filter(Boolean)
  }

  pushLastLines(state, lines) {
    for (const line of lines) {
      const trimmed = String(line).trimEnd()
      if (!trimmed) continue
      state.lastLines.push(trimmed)
      if (state.lastLines.length > this.options.maxLastLines) {
        state.lastLines.splice(0, state.lastLines.length - this.options.maxLastLines)
      }
      state.lastLine = trimmed
    }
  }

  matchAny(lines, patterns) {
    if (!Array.isArray(patterns) || patterns.length === 0) return false
    return lines.some((line) => patterns.some((re) => re.test(line)))
  }

  onData(sessionId, data) {
    const state = this.sessions.get(sessionId)
    if (!state || this.isFinal(state.status)) return

    const now = Date.now()
    state.lastOutputTime = now
    state.lastActivityTime = now

    // 任何新输出都应把 idle/stuck/completed 拉回 running（除非已经 final）
    if (state.status === 'idle' || state.status === 'stuck' || state.status === 'completed') {
      state.status = 'running'
    } else if (state.status === 'starting') {
      state.status = 'running'
    }

    const lines = this.normalizeLines(state, data)
    if (lines.length === 0) return

    state.outputLineCount += lines.length
    this.pushLastLines(state, lines)

    const rules = RULES_BY_TYPE[state.configType] || {}
    const promptHit = this.matchAny(lines, rules.promptPatterns)
    const completionHit = this.matchAny(lines, rules.completionPatterns)

    // 通用错误兜底：先排除再匹配
    const excluded = this.matchAny(lines, ERROR_EXCLUDE_PATTERNS)
    const toolErrorHit = this.matchAny(lines, rules.errorPatterns)
    const fallbackErrorHit = !excluded && this.matchAny(lines, ERROR_PATTERNS)

    if (toolErrorHit || fallbackErrorHit) {
      state.errorCount += 1
      state.lastErrorLine = state.lastLine
      // 可按需要：达到阈值/或命中 hard error 才置为 error
      if (state.errorCount >= 3) state.status = 'error'
    }

    if (completionHit) state.completionDetected = true

    if (promptHit) {
      state.promptDetected = true
      state.status = state.completionDetected ? 'completed' : 'idle'
    }

    state._dirty = true
    this.queueNotify(sessionId)
  }

  onExit(sessionId, exitCode) {
    const state = this.sessions.get(sessionId)
    if (!state) return

    state.processExitCode = exitCode
    state.endTime = Date.now()
    state.status = exitCode === 0 ? (state.completionDetected ? 'completed' : 'stopped') : 'error'

    state._dirty = true
    this.queueNotify(sessionId, { immediate: true })
  }

  // 周期性 tick：idle/stuck 判定（提示符优先，纯超时为兜底）
  tick() {
    const now = Date.now()
    for (const [sessionId, state] of this.sessions) {
      if (this.isFinal(state.status)) continue
      if (state.status !== 'running' && state.status !== 'starting') continue

      const last = state.lastOutputTime || state.lastActivityTime || state.startTime
      const silentMs = now - last

      if (silentMs >= this.options.stuckMs) {
        state.status = 'stuck'
        state._dirty = true
        this.queueNotify(sessionId)
        continue
      }

      if (silentMs >= this.options.idleMs) {
        state.status = 'idle'
        state._dirty = true
        this.queueNotify(sessionId)
      }
    }
  }

  queueNotify(sessionId, { immediate = false } = {}) {
    const state = this.sessions.get(sessionId)
    if (!state) return
    if (state._notifyTimer) return

    const delay = immediate ? 0 : this.options.updateThrottleMs
    state._notifyTimer = setTimeout(() => {
      state._notifyTimer = null
      if (!state._dirty) return
      state._dirty = false

      // 对外只暴露渲染需要的字段（避免把 remainder/内部字段发出去）
      const publicState = {
        sessionId: state.sessionId,
        configType: state.configType,
        status: state.status,
        startTime: state.startTime,
        endTime: state.endTime,
        lastActivityTime: state.lastActivityTime,
        outputLineCount: state.outputLineCount,
        errorCount: state.errorCount,
        processExitCode: state.processExitCode,
        lastLine: state.lastLine,
        lastErrorLine: state.lastErrorLine,
        lastLines: state.lastLines
      }

      this.emit('update', { sessionId, state: publicState })
    }, delay)
  }

  getAllStates() {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      configType: s.configType,
      status: s.status,
      startTime: s.startTime,
      endTime: s.endTime,
      lastActivityTime: s.lastActivityTime,
      outputLineCount: s.outputLineCount,
      errorCount: s.errorCount,
      processExitCode: s.processExitCode,
      lastLine: s.lastLine,
      lastErrorLine: s.lastErrorLine,
      lastLines: s.lastLines
    }))
  }
}

module.exports = new ShellMonitor()
```

#### 4.2.2 视图面板组件 (`MonitorPanel.vue`)

```vue
<template>
  <div class="monitor-panel" :class="{ collapsed: isCollapsed }">
    <div class="panel-header">
      <h3>{{ $t('monitor.title') }}</h3>
      <button @click="toggleCollapse">
        {{ isCollapsed ? '▼' : '▲' }}
      </button>
    </div>

    <div v-if="!isCollapsed" class="thumbnails-grid">
      <SessionThumbnail
        v-for="session in sessions"
        :key="session.sessionId"
        :session="session"
        @click="focusSession(session.sessionId)"
      />
    </div>

    <!-- 统计信息 -->
    <div v-if="!isCollapsed" class="stats">
      <span>运行中: {{ runningCount }}</span>
      <span>完成: {{ completedCount }}</span>
      <span>卡住: {{ stuckCount }}</span>
      <span>错误: {{ errorCount }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import SessionThumbnail from './SessionThumbnail.vue'

const emit = defineEmits(['focus'])

const sessions = ref([])
const isCollapsed = ref(false)
let unsubscribe = null

const runningCount = computed(() =>
  sessions.value.filter(s => s.status === 'running').length
)

const completedCount = computed(() =>
  sessions.value.filter(s => s.status === 'completed').length
)

const stuckCount = computed(() =>
  sessions.value.filter(s => s.status === 'stuck').length
)

const errorCount = computed(() =>
  sessions.value.filter(s => s.status === 'error').length
)

// 监听视图更新
const handleMonitorUpdate = (event, { sessionId, state }) => {
  const index = sessions.value.findIndex(s => s.sessionId === sessionId)
  if (index >= 0) sessions.value[index] = state
  else sessions.value.push(state)
}

// 聚焦到指定会话（建议：父组件接收到 focus 后直接设置 activeTabId）
const focusSession = (sessionId) => {
  emit('focus', sessionId)
}

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value
}

onMounted(() => {
  unsubscribe = window.electronAPI.onMonitorUpdate(handleMonitorUpdate)
  window.electronAPI.monitorGetStates().then(states => {
    sessions.value = Array.isArray(states) ? states : []
  })
})

onUnmounted(() => {
  if (typeof unsubscribe === 'function') unsubscribe()
  unsubscribe = null
})
</script>

<style scoped>
.monitor-panel {
  position: fixed;
  bottom: 0;
  right: 0;
  width: 400px;
  background: rgba(20, 20, 20, 0.92);
  border: 1px solid var(--border-color, #444);
  border-radius: 8px 8px 0 0;
  padding: 10px;
  z-index: 1000;
  transition: height 0.3s ease;
}

.monitor-panel.collapsed {
  height: 40px;
  overflow: hidden;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.thumbnails-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
  max-height: 300px;
  overflow-y: auto;
}

.stats {
  display: flex;
  justify-content: space-around;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border-color, #444);
  font-size: 12px;
}
</style>
```

#### 4.2.3 会话缩略图组件 (`SessionThumbnail.vue`)

```vue
<template>
  <div
    class="session-thumbnail"
    :class="[`status-${session.status}`, session.configType]"
    :title="tooltipText"
  >
    <div class="thumbnail-header">
      <span class="status-icon">{{ statusIcon }}</span>
      <span class="config-type">{{ session.configType }}</span>
    </div>

    <div class="thumbnail-body">
      <div class="progress-bar" v-if="showProgress">
        <div
          class="progress-fill"
          :style="{ width: progressPercent + '%' }"
        ></div>
      </div>

      <div class="stats-mini">
        <span>{{ formatDuration(session.startTime) }}</span>
        <span>{{ session.outputLineCount }} 行</span>
      </div>

      <div class="last-line" v-if="session.lastLine">
        {{ session.lastLine }}
      </div>
    </div>

    <div class="thumbnail-footer" v-if="session.errorCount > 0">
      <span class="error-badge">{{ session.errorCount }} 错误</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  session: {
    type: Object,
    required: true
  }
})

const statusIcon = computed(() => {
  const icons = {
    unstarted: '⚪',
    starting: '🔵',
    running: '🟢',
    idle: '🟡',
    stuck: '🟠',
    completed: '✅',
    error: '🔴',
    stopped: '⚫'
  }
  return icons[props.session.status] || '❓'
})

const showProgress = computed(() => {
  return ['starting', 'running', 'idle', 'stuck'].includes(props.session.status)
})

const progressPercent = computed(() => {
  // 注意：这里只是“活跃度指示”，不是准确的任务进度条
  const lines = props.session.outputLineCount || 0
  return Math.min(100, (lines / 100) * 100)
})

const tooltipText = computed(() => {
  return `${props.session.configType} - ${props.session.status}\n` +
         `运行时长: ${formatDuration(props.session.startTime)}\n` +
         `输出行数: ${props.session.outputLineCount}\n` +
         `错误数: ${props.session.errorCount}\n` +
         `最后输出: ${props.session.lastLine || ''}`
})

const formatDuration = (startTime) => {
  const duration = Date.now() - startTime
  const seconds = Math.floor(duration / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}
</script>

<style scoped>
.session-thumbnail {
  border: 2px solid #444;
  border-radius: 6px;
  padding: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  background: #2a2a2a;
}

.session-thumbnail:hover {
  transform: scale(1.05);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
}

.status-running { border-color: #4caf50; }
.status-completed { border-color: #8bc34a; background: #1b5e20; }
.status-error { border-color: #f44336; background: #b71c1c; }
.status-idle { border-color: #ffc107; }
.status-stuck { border-color: #ff9800; background: #3b2b00; }

.thumbnail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.status-icon {
  font-size: 20px;
}

.config-type {
  font-size: 10px;
  font-weight: bold;
  text-transform: uppercase;
  color: #aaa;
}

.progress-bar {
  height: 4px;
  background: #444;
  border-radius: 2px;
  overflow: hidden;
  margin: 6px 0;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4caf50, #8bc34a);
  transition: width 0.3s ease;
}

.stats-mini {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #888;
}

.last-line {
  margin-top: 6px;
  font-size: 10px;
  color: #9aa0a6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thumbnail-footer {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid #444;
}

.error-badge {
  font-size: 10px;
  color: #f44336;
  font-weight: bold;
}
</style>
```

#### 4.2.4 应用左上角模式切换（视图模式 / 多命令行窗口模式，无缝衔接）

为了让“视图”与“多命令行交互”能**随意切换、无缝衔接**，建议提供应用级别的 UI 模式切换（放在应用左上角，和现有按钮同一行）：

- **多命令行窗口模式（Shell Mode）**：现有布局（TabBar + Terminal），用于输入/交互。
- **视图模式（View Mode）**：用“视图大盘”作为主视图，展示所有会话缩略卡片与统计信息（终端会话仍在后台运行，不中断任务）。

无缝衔接（硬性要求）：

1. **切换模式不销毁终端 UI 状态**：不能因为从 Shell 切到 Monitor 就 `unmount/dispose` xterm，否则会丢失 scrollback/历史输出与选择状态。
2. **切换模式不影响会话运行**：PTY 会话持续运行；视图订阅持续更新；Shell 视图隐藏期间不丢输出（至少不丢“显示层”的历史）。
3. **切换模式不改变当前焦点会话**：`activeTabId` 在两种模式之间保持一致。
4. **从 Monitor 切回 Shell 时自动修正尺寸**：需要触发一次 `fit()/resize`（例如 `nextTick` 后派发 `resize` 事件），避免 xterm 宽高计算错误。

交互约定（避免强制跳转，允许用户自由切换）：

- 左上角 toggle 负责**纯模式切换**：`Shell <-> Monitor`，用户可随时切换。
- 视图模式点击会话卡片：**仅聚焦**（例如设置 `activeTabId=sessionId`），不强制自动切回 Shell。
  - 可选增强：卡片提供一个显式操作（例如“打开终端”按钮/双击）用于一键切回 Shell 并聚焦，提升效率但不破坏“自由切换”。
- 模式记忆（可选）：用 `localStorage`/`draftManager` 记住上次模式。

实现建议（与现有组件配合）：

- `App.vue` 维护 `uiMode`：`'shell' | 'monitor'`。
- `MenuBar.vue` 左侧新增一个 segmented toggle（例如：`Shell / Monitor`），通过 `emit('changeMode', nextMode)` 通知父组件。
- 为了满足“无缝衔接”，**建议使用 `v-show`（或 `<KeepAlive>`）隐藏/显示视图**，避免终端组件卸载导致输出丢失。

伪代码示意（仅用于说明结构）：

```vue
<MenuBar :mode="uiMode" @changeMode="uiMode = $event" />

<div v-show="uiMode === 'shell'">
  <TabBar ... />
  <Terminal ... />
</div>

<div v-show="uiMode === 'monitor'">
  <MonitorPanel
    variant="page"
    @focus="(id) => { activeTabId = id }"
    @open="(id) => { activeTabId = id; uiMode = 'shell' }"
  />
</div>
```

### 4.3 集成到现有代码

#### 修改 `src/main/pty-manager.js`

```javascript
const shellMonitor = require('./shell-monitor')

class PTYManager {
  createSession(config, workingDir, mainWindow) {
    // ... 现有代码（生成 sessionId、spawn pty 等）...

    // 注册视图
    shellMonitor.registerSession(sessionId, config.type, {
      configName: config.name,
      cwd
    })

    // 监听输出
    ptyProcess.onData((data) => {
      // ... 现有代码 ...
      shellMonitor.onData(sessionId, data)
    })

    // 监听退出
    ptyProcess.onExit(({ exitCode }) => {
      // ... 现有代码 ...
      shellMonitor.onExit(sessionId, exitCode)
    })
  }
}
```

#### 修改 `src/main/index.js` 添加 IPC + 推送

```javascript
const shellMonitor = require('./shell-monitor')

// 1) 主进程把 monitor update 推给渲染进程
shellMonitor.on('update', (payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('monitor:update', payload)
})

// 2) 初始拉取（渲染进程首次打开面板时用）
ipcMain.handle('monitor:getStates', () => shellMonitor.getAllStates())

// 3) 用户输入打点：write-terminal 时通知 monitor（用于重置粘性状态、标记新一轮任务）
ipcMain.handle('write-terminal', (event, sessionId, data) => {
  // ... 原有参数校验 ...
  shellMonitor.onUserInput(sessionId, data)
  ptyManager.writeToSession(sessionId, data)
})

// 4) 周期性 idle/stuck 判定（提示符优先，超时兜底）
setInterval(() => shellMonitor.tick(), 1000)
```

#### 修改 `src/preload/index.js` 暴露视图 API

```javascript
monitorGetStates: () => ipcRenderer.invoke('monitor:getStates'),
onMonitorUpdate: (callback) => {
  const handler = (event, payload) => callback(event, payload)
  ipcRenderer.on('monitor:update', handler)
  return () => ipcRenderer.removeListener('monitor:update', handler)
},
```

UI 侧聚焦建议直接走组件事件：`MonitorPanel` 发出 `focus(sessionId)`，`App.vue` 将 `activeTabId` 设置为该值即可（无需再走 IPC）。

### 4.4 资源节省与隐私策略（缩略卡片/Thumbnail）

> 说明：视图模式的“缩略图”默认不是截图终端画面，而是状态摘要卡片；同时也提供可选“终端画面（缩略图）”预览模式。完整落地版说明见 `MONITOR_CARD_THUMBNAIL_SAVING_ZH.md`。

#### 4.4.1 默认不截图：用“摘要卡片”替代“终端画面缩略图”

- 不做高频截图（避免 CPU/GPU 负载与渲染抖动）
- 不把终端敏感信息（token/路径/私有代码）以图片形式持久化/扩散

#### 4.4.2 只保留“最后 N 行”，不保留全量日志

- 主进程仅在内存中维护 `lastLines` 滑动窗口
- 默认 `maxLastLines = 20`（避免内存随输出量无限增长）
- 单行长度截断：默认 `maxLineLength = 2048`（避免单行超长输出导致内存飙升）
- 只额外维护 `lastLine / lastErrorLine` 与计数器，不做全量 scrollback 镜像

#### 4.4.3 增量解析 + 增量匹配（避免重复扫描）

- 对输出做规范化：去 ANSI、统一 CRLF/CR 为 LF
- 维护 `remainder` 断行缓冲：只对“新增行 + 尾巴”做规则匹配
- `remainder` 上限：默认 `maxRemainderChars = 4096`（避免无换行输出导致内存无限增长）
- 错误兜底命中采用 exclude 规则，降低误报（避免把 `0 failed/no error` 判成失败）

#### 4.4.4 IPC/UI 节流（避免高频刷新）

- 主进程更新节流：默认 `updateThrottleMs = 250`
- 只在 state 变更（dirty）时推送 `monitor:update`
- 渲染侧只做增量 apply（按 `sessionId` 更新/删除），并用 1s 时钟刷新“耗时/空闲时长”

#### 4.4.5 边界约束

- 进程退出后“冻结状态”：忽略后续输出/输入（防止状态回写）
- 视图链路只传递“必要字段”，避免把完整输出通过 IPC 广播

### 4.5 当前落地实现备注（与本文差异点）

- 规则覆盖文件：当前未实现 `configs/monitor-rules.json`；规则维护在 `src/main/shell-monitor-rules.js`
- UI 形态：支持“视图大盘 page 视图 + 卡片 grid”；同时支持 Shell 模式下的 dock 浮窗（可收起/关闭）
- prompt 识别：默认开启 `__MPS_PROMPT__` 注入（提升自定义 prompt 场景稳定性）；可用 `MPS_DISABLE_PROMPT_MARKER=1` 关闭
- 内存保护：`maxLastLines/maxLineLength/maxRemainderChars` 已在主进程默认开启，避免 monitor 因极端输出无限增长

### 4.6 排查与自检（当前项目内置）

- 自检脚本（monitor 核心）：`npm run selfcheck:monitor`
- 自检脚本（kill/unregister 回归）：`node scripts/monitor-pty-selfcheck.js`
- 自检脚本（压力/内存边界）：`node scripts/monitor-stresscheck.js`
- prompt 识别异常排查：
  - 先临时设置 `MPS_DISABLE_PROMPT_MARKER=1`，确认是否为 prompt 注入兼容性问题
  - 根据实际输出（PowerShell/oh-my-posh/codex/opencode）调整 `src/main/shell-monitor-rules.js`

## 五、使用场景

### 5.1 开发调试场景
- 同时运行多个 AI 工具进行对比测试
- 实时查看哪个工具先完成任务
- 快速定位出错的会话

### 5.2 批量任务场景
- 启动多个配置执行批量操作
- 通过缩略图快速查看整体进度
- 完成后自动通知

### 5.3 长时间运行场景
- 查看长时间运行的任务状态
- 检测空闲或卡死的会话
- 自动记录完成时间

## 六、扩展功能建议

### 6.1 高级视图
- **输出日志记录**: 保存每个会话的完整输出到文件
- **性能指标**: CPU/内存使用率统计
- **网络指标**: API 调用次数和响应时间

### 6.2 智能分析
- **AI 输出解析**: 使用正则或 AI 解析工具的结构化输出
- **任务进度估算**: 基于历史数据预测完成时间
- **异常检测**: 识别异常输出模式

### 6.3 通知系统
- **桌面通知**: 任务完成或出错时弹出通知
- **声音提示**: 不同状态使用不同提示音
- **邮件/Webhook**: 集成外部通知渠道

### 6.4 可视化增强
- **实时输出预览**: 缩略图显示最后几行输出
- **图表统计**: 显示历史任务完成率、平均时长等
- **热力图**: 显示不同时间段的活动强度

## 七、技术挑战与解决方案

### 7.1 挑战：不同工具输出格式不统一
**解决方案**:
- 为每种工具定义独立的模式匹配规则
- 提供用户自定义模式的配置选项
- 使用机器学习识别常见完成模式

### 7.2 挑战：大量输出导致性能问题
**解决方案**:
- 使用滑动窗口缓冲（只保留最近 N 行，默认 `maxLastLines=20`）
- 异步处理输出数据，避免阻塞主线程
- 使用 Web Worker 进行模式匹配

### 7.3 挑战：无法准确判断"完成"
**解决方案**:
- 结合多个指标综合判断（进程退出 + 输出模式 + 提示符/空闲时间）
- 优先识别“提示符返回/回合边界”（必要时注入 `__MPS_PROMPT__` 标记增强稳定性）
- 提供手动标记完成的功能
- 学习用户的标记行为，优化自动检测

### 7.4 挑战：输出编码、ANSI 控制码与换行差异
**解决方案**:
- 统一 UTF-8 解码，必要时提供 iconv 转码选项
- 去除 ANSI 控制码，避免影响模式匹配
- 统一 CRLF/CR 换行，并处理 chunk 断行

### 7.5 挑战：事件顺序导致状态不一致
**解决方案**:
- 维护单向状态机（starting → running → idle/completed/error/stopped）
- 进程退出后冻结状态，忽略后续 onData 触发的回写
- 记录 endTime，避免 UI 显示“已完成但仍在运行”

### 7.6 挑战：高频 IPC 更新引发渲染抖动
**解决方案**:
- 使用节流/批量合并（如 250-500ms）
- 只推送有变化的字段，避免全量状态刷写
- 渲染侧做最小 diff 更新

## 八、实施步骤

1. **第一阶段**: 实现基础视图服务和数据收集
2. **第二阶段**: 开发缩略图 UI 组件
3. **第三阶段**: 集成到现有 PTY 管理器
4. **第四阶段**: 添加完成检测逻辑
5. **第五阶段**: 优化性能和用户体验
6. **第六阶段**: 添加高级功能（通知、日志等）

### 8.1 验收与测试（建议）

- 单元测试：输出规范化、规则匹配、状态机转移（starting→running→idle/stuck→completed/error/stopped）
- 压力测试：高输出（多 MB）、多会话（10+）下 CPU/内存与 UI 流畅度
- 误报/漏报回归：收集真实输出样本，更新默认 `monitor-rules`，并允许用户覆盖
- 隐私/安全：monitor:update 只发统计与最后 N 行（可配置），不落盘、不截图


## 九、总结

**可行性**: ✅ 高度可行

通过观察进程状态、输出流和特定模式，可以有效监测三种 Shell 类型的执行状态。虽然无法 100% 准确判断 AI 工具的内部完成状态，但通过综合多个指标可以达到 80-90% 的准确率。

**核心优势**:
- 实时可视化多个会话状态
- 快速定位问题会话
- 提升多任务管理效率

**建议优先级**:
1. 基础状态观察（进程、输出）
2. 缩略图 UI 实现
3. 完成检测逻辑
4. 通知和日志功能

