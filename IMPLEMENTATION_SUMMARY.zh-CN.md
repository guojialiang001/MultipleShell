# MultipleShell 当前实现总结

本文基于仓库 `F:\project\MultipleShell` 的现有代码，对“现在已经实现了什么、怎么跑起来、数据如何流转”做一次实现级别总结（不展开未来规划）。

## 1. 项目定位

- 桌面端应用：Electron（主进程）+ Vue 3（渲染进程）
- 目标：在一个窗口内管理多个 PowerShell 终端 Tab，每个 Tab 对应一个独立 `powershell.exe` 会话
- 配置：支持多套 Profile（工作目录、启动脚本、环境变量），并将其加密存储到每用户本地目录

## 2. 运行与打包

- 开发启动：`npm run dev`
  - Vite 启动渲染进程（默认 `http://localhost:5173`）
  - Electron 主进程入口由 `vite-plugin-electron` 指向 `src/main/index.js`
- 打包：`npm run build` / `npm run build:win`
  - `vite build` 生成渲染进程产物到 `dist/`
  - `electron-builder` 按 `electron-builder.json` 配置打包

关键文件：
- `package.json`：脚本与依赖
- `vite.config.js`：Vite + Electron 插件入口配置
- `electron-builder.json`：Windows 安装包与打包文件集合

## 3. 代码结构与分层

```
src/
  main/        Electron 主进程（窗口、IPC、终端进程、配置存储）
  preload/     预加载脚本（向 renderer 暴露安全的 API）
  renderer/    Vue 3 UI（Tab、终端渲染、配置管理）
configs/       旧版明文配置（仅作为“首次运行导入”的种子）
dist/          Vite 构建产物（打包时加载）
```

## 4. 架构与数据流（高层）

1) 应用启动：主进程加载/修复本地加密配置（Profiles）  
2) UI 启动：渲染进程读取 Profiles，弹出配置选择/管理弹窗  
3) 创建终端：渲染进程请求主进程创建 PTY，会话 id 回传并成为 Tab id  
4) 终端交互：
   - renderer（xterm）将键盘输入通过 IPC 写入 PTY
   - main（node-pty）将 PTY 输出通过 IPC 推送回 renderer

## 5. 主进程（Electron main）

入口：`src/main/index.js`

### 5.1 创建窗口与加载页面

- `BrowserWindow`：`contextIsolation: true`，`nodeIntegration: false`
- preload：`src/preload/index.js`
- 开发模式：加载 `http://localhost:5173` 并默认打开 DevTools
- 生产模式：加载 `dist/index.html`
- 额外：监听 `F12` 切换 DevTools

### 5.2 IPC 接口（renderer -> main）

在 `src/main/index.js` 注册：

- Profiles
  - `get-configs` -> `configManager.loadConfigs()`
  - `save-config` -> `configManager.saveConfig(config)`（upsert）
  - `delete-config` -> `configManager.deleteConfig(configId)`
- Terminal/PTTY
  - `create-terminal` -> `ptyManager.createSession(config, workingDir, mainWindow)` -> `sessionId`
  - `write-terminal` -> `ptyManager.writeToSession(sessionId, data)`
  - `resize-terminal` -> `ptyManager.resizeSession(sessionId, cols, rows)`
  - `kill-terminal` -> `ptyManager.killSession(sessionId)`
- OS 对话框
  - `select-folder`：`dialog.showOpenDialog({ properties: ['openDirectory'] })`

### 5.3 配置存储：加密 Profile Store

实现：`src/main/config-manager.js`

- 存储路径：`app.getPath('userData')/configs.v1.enc`
- 加密方案：`safeStorage.encryptString/decryptString`
  - 落盘内容是 base64 文本（不是可读 JSON）
  - 写入采用临时文件 + rename（原子替换）
- 数据模型（实现上强制归一化）：
  - `id`（缺失则补 UUID）
  - `name`、`workingDirectory`、`envVars`、`startupScript`
  - `createdAt` / `updatedAt`（ISO 字符串）
- 首次初始化/迁移：
  - 若加密文件不存在：尝试导入旧版 `configs/*.json`
  - 若导入失败或为空：创建默认 3 套（Claude Code / Codex / OpenCode）
- 损坏恢复：
  - 解密/解析失败：将原文件重命名为 `configs.v1.enc.corrupt.<timestamp>.bak` 后重建默认 store

### 5.4 终端会话：node-pty 管理

实现：`src/main/pty-manager.js`

- 进程：每个 Tab 对应一个 `powershell.exe` 的 PTY，会话 id 为 UUID
- cwd 选择优先级：
  1) UI 传入的 `workingDir`（创建时可单次覆盖）
  2) Profile 的 `workingDirectory`
  3) `process.env.USERPROFILE`
- 环境变量：`env = { ...process.env, ...config.envVars }`
- 数据回传：
  - PTY `onData` -> `mainWindow.webContents.send('terminal:data', { sessionId, data })`
  - PTY `onExit` -> `mainWindow.webContents.send('terminal:exit', { sessionId, code })`
- 启动脚本（可选）：
  - `config.startupScript` 为 PowerShell 脚本文本（可多行）
  - 单行：直接写入该命令并回车
  - 多行：主进程将其写入临时 `.ps1` 并只发送一次 `. '<temp.ps1>'` 执行（避免交互提示时后续行被当作输入）

## 6. 预加载层（preload）

实现：`src/preload/index.js`

通过 `contextBridge.exposeInMainWorld('electronAPI', ...)` 暴露给 renderer：

- Profiles：`getConfigs/saveConfig/deleteConfig`
- Terminal：`createTerminal/writeToTerminal/resizeTerminal/killTerminal`
- Dialog：`selectFolder`
- Event 订阅：
  - `onTerminalData(sessionId, cb)`：监听 `terminal:data` 并按 sessionId 过滤
  - `onTerminalExit(sessionId, cb)`：监听 `terminal:exit` 并按 sessionId 过滤

## 7. 渲染进程（Vue 3）

入口：`src/renderer/main.js` -> `src/renderer/App.vue`

### 7.1 Tab 与会话生命周期

实现：`src/renderer/App.vue`

- `tabs[]`：每项包含 `id`（会话 id）、`title`、`config`、`workingDir`
- 新建 Tab：
  - 先创建一个临时 `pending-*` Tab
  - 弹出配置选择（`ConfigSelector`）
  - 调 `electronAPI.createTerminal(...)` 返回 `sessionId`
  - 用 `sessionId` 替换临时 Tab 的 `id`，并激活该 Tab
- 关闭 Tab：调用 `electronAPI.killTerminal(tabId)` 后从数组移除
- 快捷键（App 里监听）：
  - `Ctrl+T`：打开配置选择
  - `Ctrl+W`：关闭当前 Tab

### 7.2 终端渲染（xterm.js）

实现：`src/renderer/components/Terminal.vue`

- 创建 `xterm.Terminal` + `FitAddon`，并把输入通过 `writeToTerminal` 写回主进程
- 接收 `onTerminalData(sessionId, ...)` 输出并写入 xterm
- resize：
  - window resize 时若该 Tab 激活：`fit()` 后调用 `resizeTerminal(sessionId, cols, rows)`
  - `isActive` 从 false->true 时延迟触发一次 resize

### 7.3 Profile 选择/管理 UI

- 选择/管理入口：`src/renderer/components/ConfigSelector.vue`
  - `mode=create`：选择模板 + 可选工作目录（单次覆盖）+ “创建终端”
  - `mode=manage`：列出模板，支持新增/编辑/删除（调用持久化 API）
- 编辑器：`src/renderer/components/ConfigEditor.vue`
  - `envVars` 以多行 `KEY=VALUE` 文本编辑，保存时解析成对象
  - `workingDirectory` 通过 `selectFolder` 选目录
  - `startupScript` 为字符串字段（主进程会按 `cwd` 拼接为路径执行）

## 8. 已知注意点（基于现状代码）

- Windows 依赖：主进程固定启动 `powershell.exe`（未做跨平台 shell 选择）
- 加密可用性：`safeStorage.isEncryptionAvailable()` 为 false 时会抛错，当前启动流程未捕获该异常（等价于应用启动失败）
- 打包文件集：`electron-builder.json` 目前未显式包含 `src/preload/**/*`，而运行时需要 `src/preload/index.js` 作为 preload（若打包后 preload 缺失会导致 renderer 无法访问 `electronAPI`）
- 打包图标：`electron-builder.json` 指定了 `build/icon.ico`，仓库当前未见该文件/目录时可能导致打包失败或回退默认图标
- 文本编码：多个 Vue/MD 文件中的中文字符串呈现为乱码（疑似编码/字体或保存格式问题），不影响核心逻辑但影响 UI/文档可读性

