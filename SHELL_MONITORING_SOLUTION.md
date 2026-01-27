﻿# MultipleShell 监控方案：缩略图模式监测三大类型执行状态

## 概述

本方案提供一个缩略图监控模式，用于实时监测三种 Shell 类型（Claude Code、Codex、OpenCode）的执行完成状态。

## 一、监控可行性分析

### ✅ 可以监测的内容

1. **进程状态监控**
   - PTY 进程是否存在
   - 进程退出码（正常/异常退出）
   - 进程运行时长

2. **输出流监控**
   - 终端输出内容实时捕获
   - 关键字匹配（成功/失败/错误标识）
   - 输出行数统计

3. **配置状态监控**
   - 配置文件加载状态
   - 环境变量设置状态
   - 临时目录创建状态

4. **会话活动监控**
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

- PTY 层能够提供每个会话的 stdout/stderr、退出码与会话元数据
- 会话创建时可拿到 configType，用于选择对应的模式匹配规则
- 输出流能实时捕获（不只依赖落盘日志）
- UI 允许节流/批量更新，避免高频刷新导致卡顿

## 二、监控架构设计

```
┌─────────────────────────────────────────────────────────┐
│                   缩略图监控面板                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │Claude Code│  │  Codex   │  │ OpenCode │              │
│  │  [运行中] │  │  [完成]  │  │  [错误]  │              │
│  │  ████░░░  │  │  ██████  │  │  ███░░░  │              │
│  └──────────┘  └──────────┘  └──────────┘              │
└─────────────────────────────────────────────────────────┘
                        ↑
                   监控数据收集
                        ↓
┌─────────────────────────────────────────────────────────┐
│              Shell 监控服务 (新增)                        │
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

## 三、监控指标定义

### 3.1 基础状态

| 状态 | 图标 | 颜色 | 触发条件 |
|------|------|------|----------|
| 未启动 | ⚪ | 灰色 | 会话未创建 |
| 启动中 | 🔵 | 蓝色 | 进程已创建，等待首次输出 |
| 运行中 | 🟢 | 绿色 | 进程活跃，有输出流动 |
| 空闲 | 🟡 | 黄色 | 进程存在，但 30 秒无输出 |
| 完成 | ✅ | 绿色 | 检测到完成标识 |
| 错误 | 🔴 | 红色 | 进程异常退出或错误输出 |
| 已停止 | ⚫ | 黑色 | 进程正常退出 |

### 3.2 三大类型的完成标识

#### Claude Code
```javascript
completionPatterns: [
  /Task completed successfully/i,
  /✓ Done/i,
  /All tests passed/i,
  /Build succeeded/i,
  // 检测 PowerShell 提示符返回（无活动状态）
  /PS\s+[A-Z]:\\/
]
```

#### Codex
```javascript
completionPatterns: [
  /Codex session ended/i,
  /Operation completed/i,
  /✓/,
  // 检测命令执行完成
  /Exit code:\s*0/i
]
```

#### OpenCode
```javascript
completionPatterns: [
  /OpenCode task finished/i,
  /Successfully completed/i,
  /✓ All operations done/i
]
```

### 3.3 错误标识

```javascript
errorPatterns: [
  /error:/i,
  /failed/i,
  /exception/i,
  /fatal/i,
  /cannot find/i,
  /permission denied/i,
  /timeout/i,
  /Exit code:\s*[1-9]/i  // 非零退出码
]
```
### 3.4 判定策略优先级（建议）

- 退出码优先：非 0 直接判定错误；0 进入完成/停止判定
- 明确完成标识优先于空闲判断
- 空闲只代表“暂无输出”，不等同于完成
- 错误模式匹配作为加权信号，避免误报（stderr 不必然等于失败）


## 四、实现方案

### 4.1 新增文件结构

```
src/
├── main/
│   └── shell-monitor.js          # 新增：Shell 监控服务
├── renderer/
│   └── components/
│       ├── MonitorPanel.vue      # 新增：缩略图监控面板
│       └── SessionThumbnail.vue  # 新增：单个会话缩略图
└── shared/
    └── monitor-constants.js      # 新增：监控常量定义
```

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

#### 4.2.1 Shell 监控服务 (`shell-monitor.js`)

```javascript
class ShellMonitor {
  constructor() {
    this.sessions = new Map(); // sessionId -> MonitorState
    this.outputBuffers = new Map(); // sessionId -> 最近输出缓冲
  }

  // 注册会话监控
  registerSession(sessionId, configType) {
    this.sessions.set(sessionId, {
      sessionId,
      configType,
      status: 'starting',
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      outputLineCount: 0,
      errorCount: 0,
      completionDetected: false,
      processExitCode: null
    });
  }

  // 处理输出数据
  onData(sessionId, data) {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    // 更新活动时间
    state.lastActivityTime = Date.now();
    state.outputLineCount += data.split('\n').length;

    // 缓冲最近 1000 行输出用于模式匹配
    let buffer = this.outputBuffers.get(sessionId) || '';
    buffer += data;
    buffer = buffer.split('\n').slice(-1000).join('\n');
    this.outputBuffers.set(sessionId, buffer);

    // 检测完成标识
    if (this.detectCompletion(state.configType, buffer)) {
      state.status = 'completed';
      state.completionDetected = true;
    }

    // 检测错误
    if (this.detectError(buffer)) {
      state.errorCount++;
      if (state.errorCount > 3) {
        state.status = 'error';
      }
    }

    // 更新运行状态
    if (state.status === 'starting') {
      state.status = 'running';
    }

    // 通知渲染进程
    this.notifyUpdate(sessionId);
  }

  // 处理进程退出
  onExit(sessionId, exitCode) {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    state.processExitCode = exitCode;

    if (exitCode === 0) {
      state.status = state.completionDetected ? 'completed' : 'stopped';
    } else {
      state.status = 'error';
    }

    this.notifyUpdate(sessionId);
  }

  // 检测完成模式
  detectCompletion(configType, output) {
    const patterns = COMPLETION_PATTERNS[configType] || [];
    return patterns.some(pattern => pattern.test(output));
  }

  // 检测错误模式
  detectError(output) {
    return ERROR_PATTERNS.some(pattern => pattern.test(output));
  }

  // 检测空闲状态
  checkIdleSessions() {
    const now = Date.now();
    for (const [sessionId, state] of this.sessions) {
      if (state.status === 'running') {
        const idleTime = now - state.lastActivityTime;
        if (idleTime > 30000) { // 30 秒无活动
          state.status = 'idle';
          this.notifyUpdate(sessionId);
        }
      }
    }
  }

  // 通知渲染进程更新
  notifyUpdate(sessionId) {
    const state = this.sessions.get(sessionId);
    if (state && global.mainWindow) {
      global.mainWindow.webContents.send('monitor:update', {
        sessionId,
        state: { ...state }
      });
    }
  }

  // 获取所有会话状态
  getAllStates() {
    return Array.from(this.sessions.values());
  }
}

module.exports = new ShellMonitor();
```

#### 4.2.2 监控面板组件 (`MonitorPanel.vue`)

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
      <span>错误: {{ errorCount }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import SessionThumbnail from './SessionThumbnail.vue';

const sessions = ref([]);
const isCollapsed = ref(false);

const runningCount = computed(() =>
  sessions.value.filter(s => s.status === 'running').length
);

const completedCount = computed(() =>
  sessions.value.filter(s => s.status === 'completed').length
);

const errorCount = computed(() =>
  sessions.value.filter(s => s.status === 'error').length
);

// 监听监控更新
const handleMonitorUpdate = (event, { sessionId, state }) => {
  const index = sessions.value.findIndex(s => s.sessionId === sessionId);
  if (index >= 0) {
    sessions.value[index] = state;
  } else {
    sessions.value.push(state);
  }
};

// 聚焦到指定会话
const focusSession = (sessionId) => {
  window.electronAPI.focusSession(sessionId);
};

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value;
};

onMounted(() => {
  window.electronAPI.on('monitor:update', handleMonitorUpdate);
  // 请求初始状态
  window.electronAPI.getMonitorStates().then(states => {
    sessions.value = states;
  });
});

onUnmounted(() => {
  window.electronAPI.off('monitor:update', handleMonitorUpdate);
});
</script>

<style scoped>
.monitor-panel {
  position: fixed;
  bottom: 0;
  right: 0;
  width: 400px;
  background: rgba(30, 30, 30, 0.95);
  border: 1px solid #444;
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
  border-top: 1px solid #444;
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
    </div>

    <div class="thumbnail-footer" v-if="session.errorCount > 0">
      <span class="error-badge">{{ session.errorCount }} 错误</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  session: {
    type: Object,
    required: true
  }
});

const statusIcon = computed(() => {
  const icons = {
    'unstarted': '⚪',
    'starting': '🔵',
    'running': '🟢',
    'idle': '🟡',
    'completed': '✅',
    'error': '🔴',
    'stopped': '⚫'
  };
  return icons[props.session.status] || '❓';
});

const showProgress = computed(() => {
  return ['starting', 'running', 'idle'].includes(props.session.status);
});

const progressPercent = computed(() => {
  // 基于输出行数的简单进度估算
  // 实际应用中可以根据具体工具调整
  const lines = props.session.outputLineCount;
  return Math.min(100, (lines / 100) * 100);
});

const tooltipText = computed(() => {
  return `${props.session.configType} - ${props.session.status}\n` +
         `运行时长: ${formatDuration(props.session.startTime)}\n` +
         `输出行数: ${props.session.outputLineCount}\n` +
         `错误数: ${props.session.errorCount}`;
});

const formatDuration = (startTime) => {
  const duration = Date.now() - startTime;
  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};
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

### 4.3 集成到现有代码

#### 修改 `pty-manager.js`

```javascript
const shellMonitor = require('./shell-monitor');

class PTYManager {
  createSession(sessionId, config, workingDirectory) {
    // ... 现有代码 ...

    // 注册监控
    shellMonitor.registerSession(sessionId, config.type);

    // 监听输出
    ptyProcess.onData((data) => {
      // ... 现有代码 ...
      shellMonitor.onData(sessionId, data);
    });

    // 监听退出
    ptyProcess.onExit(({ exitCode }) => {
      // ... 现有代码 ...
      shellMonitor.onExit(sessionId, exitCode);
    });
  }
}
```

#### 修改 `main/index.js` 添加 IPC 处理

```javascript
const shellMonitor = require('./shell-monitor');

// 获取所有监控状态
ipcMain.handle('get-monitor-states', () => {
  return shellMonitor.getAllStates();
});

// 聚焦到指定会话
ipcMain.handle('focus-session', (event, sessionId) => {
  mainWindow.webContents.send('focus-tab', sessionId);
});

// 定期检查空闲会话
setInterval(() => {
  shellMonitor.checkIdleSessions();
}, 5000);
```

## 五、使用场景

### 5.1 开发调试场景
- 同时运行多个 AI 工具进行对比测试
- 实时监控哪个工具先完成任务
- 快速定位出错的会话

### 5.2 批量任务场景
- 启动多个配置执行批量操作
- 通过缩略图快速查看整体进度
- 完成后自动通知

### 5.3 长时间运行场景
- 监控长时间运行的任务状态
- 检测空闲或卡死的会话
- 自动记录完成时间

## 六、扩展功能建议

### 6.1 高级监控
- **输出日志记录**: 保存每个会话的完整输出到文件
- **性能指标**: CPU/内存使用率监控
- **网络监控**: API 调用次数和响应时间

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
- 使用滑动窗口缓冲（只保留最近 1000 行）
- 异步处理输出数据，避免阻塞主线程
- 使用 Web Worker 进行模式匹配

### 7.3 挑战：无法准确判断"完成"
**解决方案**:
- 结合多个指标综合判断（进程退出 + 输出模式 + 空闲时间）
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

1. **第一阶段**: 实现基础监控服务和数据收集
2. **第二阶段**: 开发缩略图 UI 组件
3. **第三阶段**: 集成到现有 PTY 管理器
4. **第四阶段**: 添加完成检测逻辑
5. **第五阶段**: 优化性能和用户体验
6. **第六阶段**: 添加高级功能（通知、日志等）

## 九、总结

**可行性**: ✅ 高度可行

通过监控进程状态、输出流和特定模式，可以有效监测三种 Shell 类型的执行状态。虽然无法 100% 准确判断 AI 工具的内部完成状态，但通过综合多个指标可以达到 80-90% 的准确率。

**核心优势**:
- 实时可视化多个会话状态
- 快速定位问题会话
- 提升多任务管理效率

**建议优先级**:
1. 基础状态监控（进程、输出）
2. 缩略图 UI 实现
3. 完成检测逻辑
4. 通知和日志功能

