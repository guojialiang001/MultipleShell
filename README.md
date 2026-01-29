# MultipleShell

一个面向本地开发/调试场景的多终端管理器：用“配置模板”一键启动不同类型的终端会话（Claude Code / Codex / OpenCode），在一个窗口内集中管理多个 PowerShell 会话，并提供语音输入、自动更新、加密存储等配套能力。

> 当前实现默认使用 `powershell.exe` 启动终端（偏 Windows 使用场景）。

## 功能一览（按当前代码实现）

- 多标签终端：同一窗口管理多个会话；标签栏支持溢出滚动。
- 新建/关闭保护：新建标签支持“pending”占位；通过 UI 关闭标签/关闭窗口需要输入 `close` 二次确认，避免误操作。
- 配置模板（仅 3 种类型）：`claude-code` / `codex` / `opencode`。
- 配置管理：模板列表、创建/编辑/删除（删除有确认弹窗）。
- Tab 级工作目录：创建会话时可选择工作目录；主进程会拦截系统敏感目录（如 `C:\\Windows\\System32`、`C:\\Program Files` 等）。
- 语音输入：录音 -> 调用转写接口 -> 结果直接写入当前终端输入流。
- 自动更新：基于 `electron-updater`（generic feed），支持检查/下载/重启安装，并向渲染进程实时推送状态。
- 国际化：内置 `zh-CN` / `en`，可在设置中切换。
- 终端可用性增强：
  - 右键：有选区则复制；无选区则粘贴。
  - 选择保护：大量输出时尽量避免干扰鼠标选区/鼠标抬起的选择结束。
  - `clear/cls` 等清屏行为做了额外兜底处理（前端检测 + 强制清屏）。
- 安全存储（重要）：配置与草稿使用 Electron `safeStorage` 加密写入用户目录；系统不支持安全存储时应用会提示并退出。
- Codex 额外隔离：每个会话使用独立临时 `CODEX_HOME`，避免 Codex 在运行时改写用户的模板源文件。
- Windows 安装/卸载体验：NSIS 安装包自定义 “应用正在运行” 检测逻辑，避免不同权限/不同用户启动导致无法卸载/升级。

## 技术栈

- Electron 主进程：`src/main/`
- 预加载：`src/preload/`
- 渲染进程：Vue 3 + Vite，终端渲染使用 xterm.js
- PTY：`node-pty`（当前默认启动 PowerShell）
- 打包：electron-builder（NSIS）

## 快速开始

### 环境要求

- Node.js 22.12+（建议与依赖一致）
- npm
- Windows：若安装 `node-pty` 失败，需要 Visual Studio Build Tools + Python（node-gyp 依赖）

### 安装依赖

```bash
npm install
```

### 启动开发环境

```bash
npm run dev
```

### 打包（Windows）

```bash
npm run build:win
```

其他打包命令见 `package.json` scripts（如 `build` / `build:win:x64` / `build:win:ia32`）。

### 自检（配置加密/写入逻辑）

```bash
npm run selfcheck:rpd
```

## 使用指南

### 新建终端

1. `Ctrl+T` 或点击新建标签。
2. 选择一个配置模板（Claude Code / Codex / OpenCode）。
3. 可选：点击“浏览”选择工作目录（主进程会阻止选择系统目录）。
4. 创建后会启动一个 PowerShell 会话，并在当前 Tab 内显示。

### 关闭标签/关闭窗口（UI 需要确认）

- 关闭标签：点击标签上的关闭按钮后，需要输入 `close` 才会关闭（避免误关）。
- 关闭窗口：点击应用内右上角关闭按钮后，需要输入 `close` 确认。

### 语音输入

- 底部语音栏点击开始录音；再次点击停止。
- 录音结束后自动调用转写接口，识别文本会直接写入当前终端。
- 首次使用会请求麦克风权限；应用只允许“音频”权限，不允许视频权限。

> 转写由主进程通过 HTTPS 请求 `api.siliconflow.cn` 的 `/v1/audio/transcriptions` 完成；模型为 `FunAudioLLM/SenseVoiceSmall`。

### 常用快捷键

- `Ctrl+T`：新建标签
- `Ctrl+W`：关闭当前标签（快捷关闭，不走 UI 输入确认）
- `F12`：切换 DevTools（开发/排查用）

## 配置模板类型说明

应用内仅支持三种类型（对应 UI 下拉框/主进程校验）：

### 1) Claude Code（`claude-code`）

- 你编辑的是一份 `settings.json` 的内容（JSON 文本）。
- 启动会话时主进程会将其写入：`<userData>/claude-homes/<configId>/settings.json`，并设置环境变量 `CLAUDE_CONFIG_DIR` 指向该目录。

示例（项目内默认模板方向）：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your_zhipu_api_key",
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1
  }
}
```

### 2) Codex（`codex`）

- 需要填写两份内容：`config.toml` + `auth.json`（UI 提供双面板/草稿自动保存）。
- 启动会话时：
  - 模板源文件会镜像到：`<userData>/codex-homes/<configId>/`（用于长期保存模板内容）。
  - 运行时会为每个会话创建独立临时 `CODEX_HOME`（如 `%TEMP%\\mps-codex-home-<sessionId>`），并把 `config.toml/auth.json` 写入该临时目录，防止 Codex 自行写回导致模板漂移。
  - 同时会设置：`CODEX_HOME`、`CODEX_CONFIG_TOML(_PATH)`、`CODEX_AUTH_JSON(_PATH)` 等环境变量（并在启动时在终端里打印这些路径，方便排查）。

### 3) OpenCode（`opencode`）

- 你编辑的是一份 `opencode.json`（JSON 文本）。
- 启动会话时主进程会将其写入：`<userData>/opencode-homes/<configId>/opencode.json`，并设置环境变量 `OPENCODE_CONFIG` 指向该文件。
- 该类型支持额外 `envVars`（会注入到会话环境变量里）。

默认模板：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "ask",
    "bash": "ask",
    "webfetch": "allow"
  }
}
```

## 数据与安全

- 加密存储：
  - 配置存储文件：`<userData>/configs.v1.enc`
  - 草稿存储文件（用于 Codex 编辑器自动保存）：`<userData>/drafts.v1.enc`
  - 均使用 Electron `safeStorage` 加密（依赖系统密钥服务：Windows DPAPI / macOS Keychain / Linux libsecret）。
- 额外文件：
  - `claude-homes/`、`codex-homes/`、`opencode-homes/` 用于落地模板文件（便于外部工具读取）。
  - Codex 会话会在临时目录创建 `mps-codex-home-*`，会话退出后自动清理（可用 `MPS_KEEP_CODEX_HOME=1` 禁止清理以便调试）。

## 自动更新（可选启用）

- 通过环境变量控制：
  - `MPS_UPDATE_URL`：generic 更新源地址（未设置则更新功能显示为 disabled）
  - `MPS_UPDATE_DEV=1`：允许在未打包状态下启用更新逻辑（默认仅打包后启用）
- UI：菜单栏设置中提供“检查更新 / 下载进度 / 重启安装”等入口。

## 环境变量（排查/开发用）

- `MPS_UPDATE_URL`：启用自动更新（generic feed）。
- `MPS_UPDATE_DEV=1`：开发环境允许启用更新。
- `MPS_KEEP_CODEX_HOME=1`：不清理每个会话创建的临时 `CODEX_HOME`。
- `MPS_DEBUG_ENV_APPLY=1`：调试 env 注入行为（会在终端输出提示）。
- `MPS_SUPPRESS_DIALOGS=1`：抑制主进程弹窗（自检脚本使用）。

## 常见问题

### 依赖安装失败（node-gyp / node-pty）

这是本地 C++ 编译依赖缺失导致的，建议安装：

- Visual Studio Build Tools
- Python 3.x

安装完成后重新执行 `npm install`。

## 目录结构（简要）

```
src/
  main/        # Electron 主进程（配置存储、pty、更新、语音等）
  preload/     # IPC 桥接
  renderer/    # 前端界面（Vue）
scripts/       # 自检/工具脚本
build/         # NSIS 安装器脚本、图标等
configs/       # 旧版/迁移用模板（应用会尝试导入）
```

## 备注（面向维护者）

- `configs/` 目录内的 JSON 会在首次启动/迁移时尝试导入（详见 `src/main/config-manager.js`）。
- 语音 API Key 当前为内置实现（见 `src/main/built-in-config-manager.js`）；如需改为外部配置/加密文件，可从 `scripts/encrypt-api-key.js` 和 `resources/voice-api.enc` 的思路继续完善。

## 反馈与贡献

欢迎提交 Issue 或 Pull Request。建议在提交前说明复现步骤/预期结果，便于定位问题。
