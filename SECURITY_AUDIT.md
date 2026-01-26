# MultipleShell 安全审计报告

**审计日期**: 2026-01-26
**项目版本**: 0.1.0
**审计范围**: 完整代码库安全分析

---

## 🔴 严重漏洞 (Critical)

### 1. 硬编码 API 密钥泄露
**位置**: `src/main/index.js:8`

```javascript
const TRANSCRIPTION_TOKEN = 'sk-yyqmrkevamdfuilmfdlfmjzuatoytqlywfalkjkfrzkffvdr'
```

**风险等级**: 🔴 严重
**影响**: API 密钥明文硬编码在源代码中，任何获取源码的人都可以滥用此密钥，导致：
- 未授权使用 SiliconFlow 转录服务
- 产生意外费用
- 服务配额耗尽
- 密钥可能被用于其他恶意目的

**修复建议**:
1. **立即撤销该 API 密钥**
2. 将密钥移至加密配置存储（使用现有的 `config-manager.js` 加密机制）
3. 使用环境变量或用户配置方式管理
4. 实现示例：
```javascript
// 从加密配置中读取
const config = configManager.loadConfigs()
const TRANSCRIPTION_TOKEN = config.transcriptionApiKey || process.env.TRANSCRIPTION_TOKEN
```

---

## 🟠 高危漏洞 (High)

### 2. PowerShell 命令注入风险
**位置**: `src/main/pty-manager.js:27-53`

**问题描述**:
- `escapeForPSSingleQuoted` 函数用于转义 PowerShell 命令
- 环境变量值直接注入到动态构造的 PowerShell 命令中
- 虽然有转义处理，但 PowerShell 的复杂性可能导致绕过

**风险代码**:
```javascript
const cmd =
  `$__mps=@{${pairs}};` +
  `foreach($k in $__mps.Keys){[Environment]::SetEnvironmentVariable($k,$__mps[$k],'Process')};`
```

**攻击场景**:
用户可以通过配置恶意环境变量值来执行任意 PowerShell 命令。

**修复建议**:
1. 避免动态构造 PowerShell 命令
2. 使用 PowerShell 的参数化命令或更安全的 API
3. 对用户输入的环境变量名和值进行严格白名单验证：
```javascript
const ALLOWED_ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/i
const ALLOWED_VALUE_PATTERN = /^[a-zA-Z0-9\-_./:\\@]+$/

function validateEnvVar(key, value) {
  if (!ALLOWED_ENV_VAR_PATTERN.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`)
  }
  if (!ALLOWED_VALUE_PATTERN.test(value)) {
    throw new Error(`Invalid environment variable value for ${key}`)
  }
}
```

### 3. 缺少 Content Security Policy (CSP)
**位置**: `src/main/index.js:26-30`

**问题描述**:
BrowserWindow 配置中未设置 CSP，渲染进程可能受到 XSS 攻击。虽然启用了 `contextIsolation`，但缺少 CSP 仍然是一个重要的防御层缺失。

**修复建议**:
1. 在 BrowserWindow 配置中启用沙箱模式：
```javascript
webPreferences: {
  preload: path.join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true  // 添加沙箱
}
```

2. 在 `dist/index.html` 中添加 CSP meta 标签：
```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self';
               script-src 'self';
               style-src 'self' 'unsafe-inline';
               img-src 'self' data:;
               connect-src 'self' https://api.siliconflow.cn">
```

### 4. 加密存储降级风险
**位置**: `src/main/config-manager.js:268-275`

**问题描述**:
当 `safeStorage.isEncryptionAvailable()` 返回 `false` 时，系统自动降级到明文存储配置文件，用户可能不知情。这会导致敏感信息（如 API 密钥、认证令牌）以明文形式存储。

**风险场景**:
- 在不支持加密的系统上运行
- 系统密钥链服务故障
- 用户数据目录被其他程序访问

**修复建议**:
1. 在降级时强制要求用户确认：
```javascript
const result = dialog.showMessageBoxSync({
  type: 'warning',
  title: '加密不可用',
  message: '系统不支持加密存储，配置将以明文保存。是否继续？',
  buttons: ['退出应用', '继续（不安全）'],
  defaultId: 0,
  cancelId: 0
})
if (result === 0) {
  app.quit()
}
```

2. 在 UI 中明确显示当前加密状态
3. 考虑实现应用级加密作为后备方案

---

## 🟡 中危漏洞 (Medium)

### 5. IPC 输入验证不足
**位置**: `src/main/index.js:93-107`

**问题描述**:
IPC 处理器缺少输入验证，可能导致：
- 类型错误导致应用崩溃
- 恶意渲染进程发送非法参数
- 资源耗尽攻击

**受影响的处理器**:
- `create-terminal`: 未验证 `config` 和 `workingDir` 参数
- `write-terminal`: 未验证 `sessionId` 和 `data` 参数
- `resize-terminal`: 未验证 `cols` 和 `rows` 参数

**修复建议**:
```javascript
ipcMain.handle('write-terminal', (event, sessionId, data) => {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('Invalid sessionId')
  }
  if (typeof data !== 'string') {
    throw new Error('Invalid data')
  }
  if (data.length > 1024 * 1024) { // 1MB 限制
    throw new Error('Data too large')
  }
  ptyManager.writeToSession(sessionId, data)
})

ipcMain.handle('resize-terminal', (event, sessionId, cols, rows) => {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('Invalid sessionId')
  }
  if (!Number.isInteger(cols) || cols < 1 || cols > 1000) {
    throw new Error('Invalid cols')
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 1000) {
    throw new Error('Invalid rows')
  }
  ptyManager.resizeSession(sessionId, cols, rows)
})
```

### 6. 路径遍历风险
**位置**: `src/main/index.js:109-121`, `src/main/pty-manager.js:250`

**问题描述**:
- `select-folder` 允许用户选择任意目录作为工作目录
- 未验证路径合法性，可能访问敏感系统目录
- 可能导致意外的文件操作或信息泄露

**修复建议**:
```javascript
const FORBIDDEN_PATHS = [
  'C:\\Windows\\System32',
  'C:\\Windows\\SysWOW64',
  'C:\\Program Files',
  process.env.APPDATA
]

function isPathSafe(selectedPath) {
  const normalized = path.normalize(selectedPath).toLowerCase()
  return !FORBIDDEN_PATHS.some(forbidden =>
    normalized.startsWith(path.normalize(forbidden).toLowerCase())
  )
}

ipcMain.handle('select-folder', async () => {
  // ... existing code ...
  const result = await selectFolderPromise
  if (!result.canceled && result.filePaths[0]) {
    const selectedPath = result.filePaths[0]
    if (!isPathSafe(selectedPath)) {
      dialog.showErrorBox('路径不安全', '不允许选择系统目录')
      return null
    }
    return selectedPath
  }
  return null
})
```

### 7. 临时文件清理不完整
**位置**: `src/main/pty-manager.js:92-102`

**问题描述**:
Codex 临时目录（`mps-codex-home-*`）在某些错误情况下可能不会被清理，导致：
- 磁盘空间浪费
- 敏感配置文件残留
- 潜在的信息泄露

**修复建议**:
1. 在应用启动时清理遗留临时文件：
```javascript
// 在 app.whenReady() 中添加
function cleanupOrphanedTempDirs() {
  const tmpDir = os.tmpdir()
  try {
    const entries = fs.readdirSync(tmpDir)
    for (const entry of entries) {
      if (entry.startsWith('mps-codex-home-')) {
        const fullPath = path.join(tmpDir, entry)
        fs.rmSync(fullPath, { recursive: true, force: true })
      }
    }
  } catch (err) {
    console.warn('Failed to cleanup orphaned temp dirs:', err)
  }
}
```

2. 使用 `try-finally` 确保清理：
```javascript
cleanupCodexHome(sessionId) {
  const home = this.codexTempHomes.get(sessionId)
  if (!home) return
  this.codexTempHomes.delete(sessionId)

  try {
    if (fs.existsSync(home)) {
      fs.rmSync(home, { recursive: true, force: true })
    }
  } catch (err) {
    console.error(`Failed to cleanup ${home}:`, err)
    // 记录到日志文件以便后续手动清理
  }
}
```

---

## 🔵 低危问题 (Low)

### 8. 控制台日志泄露敏感信息
**位置**: `src/renderer/components/Terminal.vue:352-390`

**问题描述**:
大量 `console.log` 输出可能泄露：
- 用户输入内容
- 选择状态
- 内部状态信息

**修复建议**:
```javascript
const DEBUG = process.env.NODE_ENV === 'development'

terminal.onData(data => {
  if (DEBUG) {
    console.log('Input:', data.charCodeAt(0))
  }
  // ... rest of code
})
```

### 9. 错误处理不完善
**位置**: 多处使用 `catch (_) {}` 静默忽略错误

**问题描述**:
静默忽略错误会导致：
- 难以调试问题
- 用户不知道操作失败
- 潜在的数据丢失

**修复建议**:
实现统一的错误日志系统：
```javascript
const log = require('electron-log')

try {
  // risky operation
} catch (err) {
  log.error('Operation failed:', err)
  // 可选：向用户显示友好的错误消息
}
```

### 10. 依赖版本过时
**当前版本**:
- `electron@28.3.3` (最新稳定版: 33.x)
- `xterm@5.3.0` (最新: 5.5.x)
- `node-pty@1.1.0` (最新: 1.1.0 ✓)

**风险**:
旧版本可能包含已知安全漏洞。

**修复建议**:
```bash
npm update electron xterm xterm-addon-fit
npm audit fix
```

定期检查更新：
```bash
npm outdated
```

---

## ✅ 安全优势

项目已实现的良好安全实践：

1. **Context Isolation**: 已启用 `contextIsolation: true`
2. **Node Integration**: 已禁用 `nodeIntegration: false`
3. **加密存储**: 使用 Electron `safeStorage` API 加密敏感配置
4. **IPC 隔离**: 通过 `contextBridge` 暴露有限 API
5. **环境变量隔离**: 每个会话使用独立的环境变量
6. **临时目录隔离**: Codex 会话使用独立的临时目录

---

## 📋 修复优先级

### 立即修复 (24小时内)
1. ✅ **撤销并移除硬编码 API 密钥** (`src/main/index.js:8`)
   - 撤销 SiliconFlow API 密钥
   - 从代码中移除
   - 实现安全的密钥管理

### 高优先级 (1周内)
2. ✅ **添加 Content Security Policy** (`src/main/index.js`)
3. ✅ **加强 IPC 输入验证** (`src/main/index.js:93-107`)
4. ✅ **改进加密降级处理** (`src/main/config-manager.js:268-275`)

### 中优先级 (2周内)
5. ✅ **改进 PowerShell 命令注入防护** (`src/main/pty-manager.js:27-53`)
6. ✅ **添加路径验证** (`src/main/index.js:109-121`)
7. ✅ **完善临时文件清理** (`src/main/pty-manager.js:92-102`)

### 低优先级 (1个月内)
8. ✅ **移除生产环境日志** (`src/renderer/components/Terminal.vue`)
9. ✅ **完善错误处理** (全局)
10. ✅ **更新依赖版本** (`package.json`)

---

## 🔒 安全开发建议

### 代码审查清单
- [ ] 所有用户输入都经过验证
- [ ] 敏感信息不以明文存储
- [ ] 错误信息不泄露系统细节
- [ ] 使用参数化查询/命令
- [ ] 实现最小权限原则

### 安全测试
1. **静态分析**: 使用 ESLint 安全插件
```bash
npm install --save-dev eslint-plugin-security
```

2. **依赖扫描**: 定期运行
```bash
npm audit
```

3. **渗透测试**: 考虑聘请专业安全团队进行测试

### 持续安全
- 订阅 Electron 安全公告
- 定期更新依赖
- 实施安全代码审查流程
- 建立漏洞响应流程

---

## 📞 联系信息

如有安全问题或发现新漏洞，请通过以下方式报告：
- 项目 Issue: [GitHub Issues]
- 安全邮件: [security@example.com]

**请勿公开披露未修复的安全漏洞。**

---

**审计完成时间**: 2026-01-26 19:16
**下次审计建议**: 2026-04-26 (3个月后)
