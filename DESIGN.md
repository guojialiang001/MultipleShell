# MultipleShell 设计文档

## 项目概述

基于 Electron + Vue 3 的多标签 PowerShell 终端应用，支持多套环境配置（Claude Code、Codex、OpenCode），最小化内存占用。

## 技术栈

- **Electron**: 跨平台桌面应用框架
- **Vue 3**: UI 层（Composition API）
- **node-pty**: PowerShell 进程管理
- **xterm.js**: 终端渲染引擎
- **electron-builder**: 打包工具

## 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Electron 主窗口                       │
├─────────────────────────────────────────────────────────┤
│  渲染进程 (Vue 3)                                        │
│  ┌───────────────────────────────────────────────────┐  │
│  │  TabBar.vue (标签栏)                              │  │
│  │  [Claude Code] [Codex] [OpenCode] [+]            │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Terminal.vue (xterm.js 实例)                     │  │
│  │  PS C:\> _                                        │  │
│  └───────────────────────────────────────────────────┘  │
│                          ↕ IPC                          │
├─────────────────────────────────────────────────────────┤
│  主进程 (Node.js)                                        │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ PTY Manager │  │Config Manager│  │ IPC Handler  │   │
│  └─────────────┘  └──────────────┘  └──────────────┘   │
│         ↓                                                │
│  ┌─────────────────────────────────────────────────┐   │
│  │  node-pty 进程池                                 │   │
│  │  [powershell.exe] [powershell.exe] [...]        │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 目录结构

```
MultipleShell/
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── index.js            # 主进程入口
│   │   ├── pty-manager.js      # node-pty 封装
│   │   └── config-manager.js   # 配置管理
│   ├── renderer/                # 渲染进程
│   │   ├── App.vue             # 根组件
│   │   ├── components/
│   │   │   ├── TabBar.vue      # 标签栏
│   │   │   ├── Terminal.vue    # 单个终端
│   │   │   └── ConfigSelector.vue  # 配置选择器
│   │   └── main.js             # 渲染进程入口
│   └── preload/
│       └── index.js            # 预加载脚本（IPC 桥接）
├── configs/                     # 配置文件目录
│   ├── claude-code.json
│   ├── codex.json
│   └── opencode.json
├── package.json
└── electron-builder.json        # 打包配置
```

### 数据流

```
用户输入 → Terminal.vue → IPC → PTY Manager → powershell.exe
                                                      ↓
用户界面 ← Terminal.vue ← IPC ← PTY Manager ← stdout/stderr
```

## 核心功能

### 1. 多标签管理

**组件**: `TabBar.vue`

**功能需求**:
- 新建标签（Ctrl+T）
- 关闭标签（Ctrl+W）
- 切换标签（Ctrl+Tab）
- 每个标签独立 PowerShell 会话

**实现方案**:

```vue
<script setup>
import { ref, computed } from 'vue'

const tabs = ref([])
const activeTabId = ref(null)

// 新建标签
const createTab = async (config, workingDir) => {
  const sessionId = await window.electronAPI.createTerminal(config, workingDir)
  tabs.value.push({
    id: sessionId,
    title: config.name,
    config: config
  })
  activeTabId.value = sessionId
}

// 关闭标签
const closeTab = async (tabId) => {
  await window.electronAPI.killTerminal(tabId)
  const index = tabs.value.findIndex(t => t.id === tabId)
  tabs.value.splice(index, 1)
  if (activeTabId.value === tabId && tabs.value.length > 0) {
    activeTabId.value = tabs.value[0].id
  }
}

// 快捷键绑定
onMounted(() => {
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 't') {
      e.preventDefault()
      showConfigSelector.value = true
    }
    if (e.ctrlKey && e.key === 'w') {
      e.preventDefault()
      if (activeTabId.value) closeTab(activeTabId.value)
    }
  })
})
</script>
```

**状态管理**:
- `tabs`: 标签列表数组
- `activeTabId`: 当前激活的标签 ID
- 每个标签存储：`{ id, title, config }`

---

### 2. 终端渲染

**组件**: `Terminal.vue`

**功能需求**:
- xterm.js 实例
- 与 node-pty 进程双向通信
- 支持文本选择、复制、粘贴
- 自适应窗口大小

**实现方案**:

```vue
<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

const props = defineProps(['sessionId', 'isActive'])
const terminalRef = ref(null)
let terminal = null
let fitAddon = null

onMounted(() => {
  // 初始化 xterm.js
  terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    scrollback: 1000,
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      cursor: '#ffffff'
    }
  })
  
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalRef.value)
  fitAddon.fit()
  
  // 监听用户输入
  terminal.onData(data => {
    window.electronAPI.writeToTerminal(props.sessionId, data)
  })
  
  // 监听终端输出
  window.electronAPI.onTerminalData(props.sessionId, (data) => {
    terminal.write(data)
  })
  
  // 窗口大小调整
  window.addEventListener('resize', handleResize)
})

const handleResize = () => {
  if (fitAddon && props.isActive) {
    fitAddon.fit()
    const { cols, rows } = terminal
    window.electronAPI.resizeTerminal(props.sessionId, cols, rows)
  }
}

// 标签激活时重新适配大小
watch(() => props.isActive, (active) => {
  if (active) {
    setTimeout(() => handleResize(), 100)
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  terminal?.dispose()
})
</script>

<template>
  <div ref="terminalRef" class="terminal-container"></div>
</template>

<style scoped>
.terminal-container {
  width: 100%;
  height: 100%;
  padding: 8px;
}
</style>
```

**关键技术点**:
- `FitAddon`: 自动适配终端大小
- `onData`: 捕获用户输入并发送到主进程
- `onTerminalData`: 接收主进程输出并渲染
- 仅在标签激活时执行 resize 操作（性能优化）

---

### 3. 配置管理

**文件**: `config-manager.js` (主进程)

**配置结构**:
```json
{
  "name": "Claude Code",
  "workingDirectory": "C:\\Projects\\MyApp",
  "envVars": {
    "ANTHROPIC_API_KEY": "sk-...",
    "NODE_ENV": "development"
  },
  "startupScript": "init.ps1"
}
```

**实现方案**:

```javascript
const fs = require('fs')
const path = require('path')

class ConfigManager {
  constructor() {
    this.configDir = path.join(__dirname, '../../configs')
    this.configs = []
  }
  
  // 加载所有配置文件
  loadConfigs() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true })
      this.createDefaultConfigs()
    }
    
    const files = fs.readdirSync(this.configDir)
    this.configs = files
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const content = fs.readFileSync(path.join(this.configDir, f), 'utf-8')
        return JSON.parse(content)
      })
    
    return this.configs
  }
  
  // 创建默认配置
  createDefaultConfigs() {
    const defaults = [
      {
        name: 'Claude Code',
        workingDirectory: '',
        envVars: {},
        startupScript: ''
      },
      {
        name: 'Codex',
        workingDirectory: '',
        envVars: {},
        startupScript: ''
      },
      {
        name: 'OpenCode',
        workingDirectory: '',
        envVars: {},
        startupScript: ''
      }
    ]
    
    defaults.forEach(config => {
      const filename = config.name.toLowerCase().replace(/\s+/g, '-') + '.json'
      fs.writeFileSync(
        path.join(this.configDir, filename),
        JSON.stringify(config, null, 2)
      )
    })
  }
  
  // 获取配置
  getConfig(name) {
    return this.configs.find(c => c.name === name)
  }
  
  // 保存配置
  saveConfig(config) {
    const filename = config.name.toLowerCase().replace(/\s+/g, '-') + '.json'
    fs.writeFileSync(
      path.join(this.configDir, filename),
      JSON.stringify(config, null, 2)
    )
    this.loadConfigs()
  }
}

module.exports = new ConfigManager()
```

**功能**:
- 自动扫描 `configs/` 目录
- 首次运行创建默认配置文件
- 支持动态加载和保存配置

---

### 4. PTY 进程管理

**文件**: `pty-manager.js` (主进程)

**核心 API**:
```javascript
createSession(config, workingDir) → sessionId
writeToSession(sessionId, data)
resizeSession(sessionId, cols, rows)
killSession(sessionId)
```

**实现方案**:

```javascript
const pty = require('node-pty')
const { v4: uuidv4 } = require('uuid')
const path = require('path')
const fs = require('fs')

class PTYManager {
  constructor() {
    this.sessions = new Map()
  }
  
  // 创建新会话
  createSession(config, workingDir, mainWindow) {
    const sessionId = uuidv4()
    
    // 合并环境变量
    const env = {
      ...process.env,
      ...config.envVars
    }
    
    // 确定工作目录
    const cwd = workingDir || config.workingDirectory || process.env.USERPROFILE
    
    // 启动 PowerShell 进程
    const ptyProcess = pty.spawn('powershell.exe', [], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: cwd,
      env: env
    })
    
    // 监听输出
    ptyProcess.onData(data => {
      mainWindow.webContents.send('terminal:data', {
        sessionId,
        data
      })
    })
    
    // 监听退出
    ptyProcess.onExit(({ exitCode }) => {
      mainWindow.webContents.send('terminal:exit', {
        sessionId,
        code: exitCode
      })
      this.sessions.delete(sessionId)
    })
    
    this.sessions.set(sessionId, ptyProcess)
    
    // 执行启动脚本
    if (config.startupScript) {
      const scriptPath = path.join(cwd, config.startupScript)
      if (fs.existsSync(scriptPath)) {
        ptyProcess.write(`& "${scriptPath}"\r`)
      }
    }
    
    return sessionId
  }
  
  // 写入数据
  writeToSession(sessionId, data) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.write(data)
    }
  }
  
  // 调整大小
  resizeSession(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.resize(cols, rows)
    }
  }
  
  // 终止会话
  killSession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.kill()
      this.sessions.delete(sessionId)
    }
  }
  
  // 清理所有会话
  killAllSessions() {
    this.sessions.forEach(session => session.kill())
    this.sessions.clear()
  }
}

module.exports = new PTYManager()
```

**实现要点**:
- 使用 UUID 作为会话 ID
- 每个标签对应一个独立的 `node-pty` 实例
- 通过 IPC 与渲染进程双向通信
- 标签关闭时自动清理进程
- 支持启动脚本自动执行

---

### 5. 配置选择器

**组件**: `ConfigSelector.vue`

**功能需求**:
- 显示所有可用配置
- 选择工作目录（可选）
- 创建新标签

**实现方案**:

```vue
<script setup>
import { ref, onMounted } from 'vue'

const emit = defineEmits(['create'])
const configs = ref([])
const selectedConfig = ref(null)
const customWorkingDir = ref('')

onMounted(async () => {
  configs.value = await window.electronAPI.getConfigs()
})

const selectFolder = async () => {
  const result = await window.electronAPI.selectFolder()
  if (result) {
    customWorkingDir.value = result
  }
}

const createTerminal = () => {
  if (selectedConfig.value) {
    emit('create', selectedConfig.value, customWorkingDir.value)
  }
}
</script>

<template>
  <div class="config-selector">
    <h3>选择配置</h3>
    <div class="config-list">
      <div 
        v-for="config in configs" 
        :key="config.name"
        :class="['config-item', { active: selectedConfig === config }]"
        @click="selectedConfig = config"
      >
        {{ config.name }}
      </div>
    </div>
    
    <div class="folder-selector">
      <label>工作目录（可选）:</label>
      <div class="folder-input">
        <input 
          v-model="customWorkingDir" 
          type="text" 
          placeholder="使用配置默认目录"
          readonly
        />
        <button @click="selectFolder">浏览...</button>
      </div>
    </div>
    
    <div class="actions">
      <button @click="createTerminal" :disabled="!selectedConfig">
        创建终端
      </button>
    </div>
  </div>
</template>
```

**文件夹选择实现** (主进程):

```javascript
const { dialog } = require('electron')

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})
```

## IPC 通信协议

### 主进程 → 渲染进程

| 事件 | 数据 | 说明 |
|------|------|------|
| `terminal:data` | `{ sessionId, data }` | 终端输出 |
| `terminal:exit` | `{ sessionId, code }` | 进程退出 |

### 渲染进程 → 主进程

| 事件 | 数据 | 说明 |
|------|------|------|
| `terminal:create` | `{ config, workingDir }` | 创建会话 |
| `terminal:write` | `{ sessionId, data }` | 写入输入 |
| `terminal:resize` | `{ sessionId, cols, rows }` | 调整大小 |
| `terminal:kill` | `{ sessionId }` | 终止会话 |

## 内存优化策略

1. **按需加载**: xterm.js 实例仅在标签激活时渲染
2. **进程复用**: 后台标签的 PTY 进程保持运行，但暂停渲染
3. **限制历史**: xterm.js scrollback 限制为 1000 行
4. **懒加载配置**: 配置文件仅在需要时读取

## 打包配置

**文件**: `electron-builder.json`

```json
{
  "appId": "com.multipleshell.app",
  "productName": "MultipleShell",
  "directories": {
    "output": "dist"
  },
  "win": {
    "target": "nsis",
    "icon": "build/icon.ico"
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true
  }
}
```

**打包命令**:
```bash
npm run build:win
```

**输出**:
- `dist/MultipleShell-Setup-1.0.0.exe` (~80-100MB)

## 开发流程

### 安装依赖
```bash
npm install
```

### 开发模式
```bash
npm run dev
```

### 打包
```bash
npm run build:win
```

## 配置文件示例

### claude-code.json
```json
{
  "name": "Claude Code",
  "workingDirectory": "C:\\Projects\\ClaudeProject",
  "envVars": {
    "ANTHROPIC_API_KEY": "sk-ant-xxx"
  },
  "startupScript": ""
}
```

### codex.json
```json
{
  "name": "Codex",
  "workingDirectory": "C:\\Projects\\CodexProject",
  "envVars": {
    "OPENAI_API_KEY": "sk-xxx"
  },
  "startupScript": ""
}
```

### opencode.json
```json
{
  "name": "OpenCode",
  "workingDirectory": "C:\\Projects\\OpenCodeProject",
  "envVars": {
    "CUSTOM_VAR": "value"
  },
  "startupScript": "setup.ps1"
}
```

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| Ctrl+T | 新建标签 |
| Ctrl+W | 关闭当前标签 |
| Ctrl+Tab | 切换到下一个标签 |
| Ctrl+Shift+Tab | 切换到上一个标签 |
| Ctrl+C | 复制选中文本 |
| Ctrl+V | 粘贴 |

## 技术细节

### xterm.js 配置
```javascript
{
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Consolas, monospace',
  scrollback: 1000,
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4'
  }
}
```

### node-pty 启动参数
```javascript
pty.spawn('powershell.exe', [], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: workingDirectory,
  env: { ...process.env, ...customEnvVars }
})
```

## 未来扩展

- [ ] 主题切换
- [ ] 分屏功能
- [ ] 会话保存/恢复
- [ ] 配置热重载
- [ ] 快捷命令面板
