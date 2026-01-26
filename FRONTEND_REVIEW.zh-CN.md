# MultipleShell 前端审查（问题点 + 推荐实现）

审查范围：`src/renderer/*`（Vue 3 UI）与 `src/preload/index.js`（renderer 可见的 IPC API；会直接影响前端性能/内存/交互）。

## 结论摘要（优先级从高到低）

1) **IPC 订阅与窗口事件存在明显“监听器泄漏/累积”风险**  
   - `src/preload/index.js` 的 `onTerminalData/onTerminalExit` 每调用一次就 `ipcRenderer.on(...)` 注册一个新监听器，且不提供取消订阅。  
   - `src/renderer/components/Terminal.vue` 每个 tab 都 `window.addEventListener('resize', ...)`，tab 越多监听器越多（即使非激活 tab 也会挂着监听器）。

2) **高频 IPC 使用 `invoke` 不合适（键盘输入/resize 属于高频事件）**  
   - `Terminal.vue` 在 `terminal.onData` 中调用 `window.electronAPI.writeToTerminal(...)`，而该 API 目前是 `ipcRenderer.invoke`。输入每个字符都会创建 Promise/RPC 往返，容易引入卡顿/队列堆积与未处理的 Promise reject 风险。  
   - `resizeTerminal` 同样是高频事件，更适合单向消息（`send`）。

3) **全局快捷键监听未清理，且可能抢走终端输入**  
   - `src/renderer/App.vue` 在 `onMounted` 里 `window.addEventListener('keydown', ...)`，但没有在卸载时移除。  
   - 该监听会在焦点位于 xterm/输入框时仍拦截 `Ctrl+W/Ctrl+T`，可能与终端内部快捷键冲突，导致误关闭 tab 或无法输入。

4) **组件间事件设计存在“伪 async”与状态体验问题**  
   - `src/renderer/components/ConfigSelector.vue` 中 `await emit(...)` 实际不会等待父组件的异步逻辑（Vue `emit` 不返回 Promise），可能造成 UI 状态与数据刷新不同步的错觉。

5) **可访问性/交互一致性不足（modal、按钮、键盘操作）**  
   - modal 没有遮罩层、未声明 `role="dialog"`、无 ESC 关闭、无 focus trap；在 Electron 中仍可勉强使用，但可维护性/易用性会下降。

6) **工程化基础较薄（缺少 lint/format/typecheck）**  
   - 当前为纯 JS + SFC 内联样式，缺少 ESLint/Prettier/类型约束，长期会增加回归成本。

## 发现的“不合适点”（带文件定位）

### A. 监听器泄漏 / 监听器数量随 tab 增长（高）

- `src/preload/index.js`  
  - `onTerminalData(sessionId, cb)` 内部直接 `ipcRenderer.on('terminal:data', ...)`，每创建一个 tab 都会新增一个 channel 监听器；tab 越多，每条终端输出都会触发 N 次回调过滤（O(N)）。  
  - 无法取消订阅：关闭 tab、卸载组件后监听器仍然存在（泄漏）。

- `src/renderer/components/Terminal.vue`  
  - `onMounted` 里 `window.addEventListener('resize', handleResize)`，每个 Terminal 组件实例都会注册一次窗口 resize。即使 `handleResize` 内部用 `props.isActive` 判断，也仍会造成监听器数量膨胀。

### B. 高频 IPC 使用 `invoke`（高）

- `src/preload/index.js`：`writeToTerminal/resizeTerminal` 使用 `ipcRenderer.invoke`。  
- `src/renderer/components/Terminal.vue`：`terminal.onData` 中调用 `writeToTerminal`，每次按键都触发一次 `invoke`。  
  - 更合适的模式：`send`（单向）+ `ipcMain.on`，避免 RPC 语义与 Promise 负担。

### C. 全局快捷键与清理问题（中-高）

- `src/renderer/App.vue`：`onMounted` 中注册 `window.addEventListener('keydown', ...)`，无对应 `removeEventListener`。  
- 拦截范围过宽：不判断当前焦点是否在 `input/textarea/contenteditable/xterm`，可能打断终端输入行为。

### D. 组件事件流与异步一致性（中）

- `src/renderer/components/ConfigSelector.vue`  
  - `await emit('saveTemplate', config)`、`await emit('deleteTemplate', template.id)`：`await` 无实际意义，容易误导维护者，并可能引发“按钮点了但列表还没刷新”的体验问题。  
  - 建议：由父组件传入明确的 async 函数（props function），或让子组件直接调用 `electronAPI` 并管理 loading 状态。

### E. 细节与可维护性（中-低）

- `src/renderer/components/TabBar.vue`  
  - `activeTabId: { type: [String, null], default: null }`：`null` 不是有效的 prop `type` 构造器（建议改为 `type: String, default: null`）。

- `src/renderer/App.vue` / 多个组件  
  - 样式大量重复且分散在各 SFC 内，缺少统一主题变量（颜色、间距、按钮态），后续改 UI 会很费力。  

- `index.html`：`lang="zh-CN"` 但界面文案以英文为主（语言一致性问题）。

## 推荐实现（可直接落地的改造方案）

### 1) 让 IPC 订阅可取消，并避免 O(N) 监听器（强烈推荐）

目标：`ipcRenderer.on('terminal:data')` **只注册一次**，通过 Map 分发到对应 `sessionId` 的订阅者；并且返回 `unsubscribe()` 供前端组件卸载时调用。

建议实现位置：`src/preload/index.js`

示例（思路代码）：

```js
const { contextBridge, ipcRenderer } = require('electron')

const terminalDataSubscribers = new Map() // sessionId -> Set<fn>
const terminalExitSubscribers = new Map() // sessionId -> Set<fn>

ipcRenderer.on('terminal:data', (_event, { sessionId, data }) => {
  const set = terminalDataSubscribers.get(sessionId)
  if (!set) return
  for (const fn of set) fn(data)
})

ipcRenderer.on('terminal:exit', (_event, { sessionId, code }) => {
  const set = terminalExitSubscribers.get(sessionId)
  if (!set) return
  for (const fn of set) fn(code)
})

function subscribe(map, sessionId, callback) {
  let set = map.get(sessionId)
  if (!set) { set = new Set(); map.set(sessionId, set) }
  set.add(callback)
  return () => {
    set.delete(callback)
    if (set.size === 0) map.delete(sessionId)
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  onTerminalData: (sessionId, cb) => subscribe(terminalDataSubscribers, sessionId, cb),
  onTerminalExit: (sessionId, cb) => subscribe(terminalExitSubscribers, sessionId, cb),
})
```

前端 `Terminal.vue` 在 `onUnmounted` 中调用返回的 `unsubscribe()`，避免泄漏。

### 2) 高频事件改为 `send`（输入与 resize）

目标：输入/resize 不需要返回值，用单向消息减少开销。

建议改造：
- `src/preload/index.js`：把 `writeToTerminal/resizeTerminal` 从 `invoke` 改为 `send`
- `src/main/index.js`：把对应 handler 从 `ipcMain.handle` 改为 `ipcMain.on`

示例（思路代码）：

```js
// preload
writeToTerminal: (sessionId, data) => ipcRenderer.send('write-terminal', sessionId, data),
resizeTerminal: (sessionId, cols, rows) => ipcRenderer.send('resize-terminal', sessionId, cols, rows),
```

```js
// main
ipcMain.on('write-terminal', (_event, sessionId, data) => ptyManager.writeToSession(sessionId, data))
ipcMain.on('resize-terminal', (_event, sessionId, cols, rows) => ptyManager.resizeSession(sessionId, cols, rows))
```

### 3) 终端组件：只保留必要监听器，并做完整清理

建议在 `src/renderer/components/Terminal.vue`：
- 保存 `offTerminalData/offTerminalExit`，卸载时调用
- 只在激活 tab 时做 fit/resize（或使用 `ResizeObserver` 观察容器尺寸变化，替代全局 window resize）

示例（思路代码）：

```js
let offData = null
onMounted(() => {
  offData = window.electronAPI.onTerminalData(props.sessionId, data => terminal.write(data))
})
onUnmounted(() => {
  offData?.()
})
```

### 4) 全局快捷键：收敛作用域 + 卸载清理

建议在 `src/renderer/App.vue`：
- 把 keydown handler 抽成具名函数，在 `onUnmounted` 里 `removeEventListener`
- 只在“非可编辑区域/非终端焦点”时处理（避免抢走终端按键）
- 或者使用 Electron Menu / globalShortcut（更符合桌面应用习惯）

示例判断（思路代码）：

```js
const isEditable = (el) =>
  el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)

if (isEditable(document.activeElement)) return
```

### 5) ConfigSelector：去掉 `await emit`，引入明确的 loading/错误展示

推荐两种方式之一：
- A) 父组件通过 props 传入 `async saveTemplate(config)` / `async deleteTemplate(id)`，子组件直接 `await props.saveTemplate(...)`
- B) 子组件直接调用 `window.electronAPI.*`，并用 `isSaving/isDeleting` 控制按钮禁用与提示

### 6) Modal 可用性（遮罩、ESC、焦点）

建议：
- 加遮罩层（backdrop），点击遮罩关闭
- `role="dialog"`、`aria-modal="true"`、首个可交互元素自动 focus
- ESC 关闭、Tab 焦点循环（focus trap）

### 7) 样式与工程化（中期收益）

建议最小落地：
- 抽一个全局样式：`src/renderer/styles/base.css` + `theme.css`（CSS 变量：颜色/间距/圆角）
- 引入 ESLint + Prettier（Vue3 推荐规则），加 `npm run lint`/`npm run format`
- 若准备继续扩展：把 renderer 升级到 TypeScript（至少为 `window.electronAPI` 提供类型声明）

## 依赖安全检查

- `npm audit --omit=dev --registry=https://registry.npmjs.org/`：`found 0 vulnerabilities`
- 注意：默认 registry 若指向 `npmmirror`，可能出现 audit endpoint 不支持的问题（你这里已出现过一次）。
- 构建提示：运行 `npx vite build` 时出现 `Vite's Node API CJS build is deprecated` 警告，通常来自依赖仍在用 CJS 方式调用 Vite（可考虑升级 `vite-plugin-electron`/相关依赖到兼容版本，或按 Vite 文档调整调用方式）。
