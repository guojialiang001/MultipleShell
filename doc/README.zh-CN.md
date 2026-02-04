# MultipleShell

[English](../README.md) | 简体中文

一个面向本地开发/调试场景的多终端管理器：用“配置模板”一键启动不同类型的终端会话（Claude Code / Codex / OpenCode），在一个窗口内集中管理多个 PowerShell 会话，并提供语音输入、自动更新、加密存储等配套能力。

> 当前实现默认使用 `powershell.exe` 启动终端（偏 Windows 使用场景）。
>
> 可选：提供 **Remote 模式** 作为 Guacamole RemoteApp/VNC 的快捷入口（打开/复制直达链接），便于手机/浏览器访问。

## 关键词

- 多终端管理器 / multi-terminal manager
- 多标签终端 / tabbed terminal / terminal emulator
- PowerShell session manager（Windows）
- Electron + Vue 3 + Vite + xterm.js + node-pty
- Claude Code / OpenAI Codex / OpenCode
- Guacamole / RemoteApp / VNC / RDP / PWA

## 功能一览（按当前代码实现）

- 多标签终端：同一窗口管理多个会话；标签栏支持溢出滚动。
- 多实例同步（Host/Client）：同一台 Windows 上可同时运行多个 MultipleShell（含 RDP RemoteApp 会话），共享同一批终端会话；会话列表与终端输出在不同实例间实时同步。
- 多实例安全：Client 使用独立 `userData`（避免 Chromium profile 并发），configs/drafts/monitor/update/voice 等“有状态写入/副作用”统一收敛到 Host。
- 新建/关闭保护：新建标签支持“pending”占位；通过 UI 关闭标签/关闭窗口需要输入 `close` 二次确认，避免误操作。
- 配置模板（仅 3 种类型）：`claude-code` / `codex` / `opencode`。
- CC Switch 集成（可选）：从 CC Switch 读取 providers/proxy/failover 配置；一键覆盖导入为模板；创建会话时可“跟随当前 provider”或“走 CC Switch 代理”（配合自动故障转移）。
- 配置管理：模板列表、创建/编辑/删除（删除有确认弹窗）。
- Tab 级工作目录：创建会话时可选择工作目录；主进程会拦截系统敏感目录（如 `C:\\Windows\\System32`、`C:\\Program Files` 等）。
- 语音输入：录音 -> 调用转写接口 -> 结果直接写入当前终端输入流。
- 自动更新：基于 `electron-updater`（generic feed），支持检查/下载/重启安装，并向渲染进程实时推送状态。
- 国际化：内置 `zh-CN` / `en`，可在设置中切换。
- 视图模式（缩略卡片）：用“摘要卡片”在一个大盘里查看所有会话状态（运行/空闲/卡住/完成/错误）；不做终端画面截图，仅保留最后 N 行输出预览（默认 20 行）以节省资源并降低敏感信息暴露风险。
- 远程模式（Remote）：配置 Guacamole 入口 URL + RemoteApp/VNC 连接名，一键“打开/复制”直达链接（`/#/client/c/<连接ID>`），适合手机浏览器/PWA。
- 终端可用性增强：
  - 右键：有选区则复制；无选区则粘贴。
  - 选择保护：大量输出时尽量避免干扰鼠标选区/鼠标抬起的选择结束。
  - `clear/cls` 等清屏行为做了额外兜底处理（前端检测 + 强制清屏）。
- 安全存储（重要）：配置与草稿使用 Electron `safeStorage` 加密写入用户目录；系统不支持安全存储时应用会提示并退出。
- Codex 额外隔离：每个会话使用独立临时 `CODEX_HOME`，避免 Codex 在运行时改写用户的模板源文件。
- Claude Code 会话隔离：每个模板使用独立 `CLAUDE_CONFIG_DIR` + HOME/USERPROFILE；默认会清理模板 profile 下的 `history.jsonl`，避免自动续接旧会话（如需保留，设置 `MPS_CLAUDE_PRESERVE_HISTORY=1`）。
- Windows 安装/卸载体验：NSIS 安装包自定义 “应用正在运行” 检测逻辑，避免不同权限/不同用户启动导致无法卸载/升级。

## 技术栈

- Electron 主进程：`../src/main/`
- 预加载：`../src/preload/`
- 渲染进程：Vue 3 + Vite，终端渲染使用 xterm.js
- PTY：`node-pty`（当前默认启动 PowerShell）
- CC Switch 读取：`sql.js`（WASM SQLite，用于读取 CC Switch 的 `cc-switch.db`）
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

其他打包命令见 `../package.json` scripts（如 `build` / `build:win:x64` / `build:win:ia32`）。

> 打包产物默认输出到 `release/<arch>/`（见 `../electron-builder.json`）。

### 自检（配置加密/写入逻辑）

```bash
npm run selfcheck:rpd
```

### 自检（视图状态机）

```bash
npm run selfcheck:monitor
```

可选补充（更偏压力/边界检查）：

```bash
node .\\scripts\\monitor-pty-selfcheck.js
node .\\scripts\\monitor-stresscheck.js
```

## 使用指南

### 新建终端

1. `Ctrl+T` 或点击新建标签。
2. 选择一个配置模板（Claude Code / Codex / OpenCode）。
3. 可选：点击“浏览”选择工作目录（主进程会阻止选择系统目录）。
4. 创建后会启动一个 PowerShell 会话，并在当前 Tab 内显示。

### CC Switch（可选）

- 用途：复用 CC Switch 的 providers/代理/故障转移配置，在 MultipleShell 中一键导入并创建会话。
- 配置目录：默认 `~/.cc-switch`；Windows 会尝试从 `%APPDATA%\\com.ccswitch.desktop\\app_paths.json` 自动探测；可用 `MPS_CC_SWITCH_CONFIG_DIR`（或 `CC_SWITCH_CONFIG_DIR`）覆盖。
- 一键导入：在“管理配置”里点击“从 CC Switch 覆盖导入”，会同步（含删除）所有以 `ccswitch-` 开头的模板，不影响你手动创建的模板。
- 默认开关（创建会话面板）：
  - “只使用 CC Switch 配置”：默认关闭（显示全部模板）。
  - “自动检测”：默认关闭（不会后台轮询）；可手动开启或点击“刷新”。
- 未安装/未初始化 CC Switch：如果解析到的配置目录下不存在 `cc-switch.db`，不会报错中断，只会在 UI 中提示“未检测到 CC Switch”。
- 运行方式：
  - “使用 CC Switch”：在创建会话时将 CC Switch 的 provider 配置合并到当前模板；`CC Switch Provider ID` 留空表示跟随 CC Switch 当前 provider。
  - “走 CC Switch 代理”：将请求指向 CC Switch proxy（配合 CC Switch 的 auto-failover；需在 CC Switch 中启用 proxy）；OpenCode 使用 CC Switch 的 Codex proxy 配置。

### 多实例同步（桌面端 + RemoteApp）

- 自动 Host 选举：第一个启动的实例成为 Host（唯一持有 PTY + 会话注册表）；后续实例成为 Client（仅 UI，通过本机 IPC 访问 Host）。
- 会话同步：tabs/会话列表以 Host 为准（`sessions:changed` 广播）；任一端新建/输入/关闭会话，其他实例实时可见。
- 写入集中：Client 不直接读写 configs/drafts/monitor/update/voice 等共享状态，统一通过 Host RPC 执行，避免并发写用户目录导致损坏。
- Profile 隔离：Client 会将 Chromium `userData` 切到 `%LOCALAPPDATA%\\MultipleShell\\clients\\<pid>`，避免多个实例共享同一 profile 造成锁冲突。
- 传输与鉴权：默认使用按用户派生的 Windows Named Pipe；握手 token 存在 `%APPDATA%\\MultipleShell\\agent-token`；可用 `MPS_AGENT_PIPE` 覆盖 pipe 名用于排查。
- 设计文档（含分阶段计划）：[REMOTEAPP_DESKTOP_SYNC_PLAN_ZH.md](REMOTEAPP_DESKTOP_SYNC_PLAN_ZH.md)。

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

### 视图模式（缩略卡片）

- 入口：窗口左上角“模式切换”选择“视图”。
- dock 浮窗：在 Shell 模式右下角点击“视图”可打开浮窗面板（可收起/关闭），无需切换模式。
- 内容：每个会话对应一张卡片，顶部显示终端名称；卡片内展示工作目录、类型、状态、运行时长、最近活跃时间、输出行数与错误计数。
- 操作：单击卡片仅聚焦会话；双击卡片或点击“打开”进入终端并切回 Shell。
- 资源节省：不截图、不落盘全量日志；仅内存保留最近 N 行（默认 20 行）+ 统计字段，并对视图更新做节流合并（默认 250ms）。

实现细节与取舍说明见：[MONITOR_CARD_THUMBNAIL_SAVING_ZH.md](MONITOR_CARD_THUMBNAIL_SAVING_ZH.md)、[SHELL_MONITORING_SOLUTION.md](SHELL_MONITORING_SOLUTION.md)。

### 远程模式（Remote / Guacamole 快捷入口）

该模式用于把 Guacamole 门户/RemoteApp/VNC 的入口收敛到一个桌面客户端里（不在应用内嵌远程画面，只是生成链接并用系统默认浏览器打开）。

1. 打开设置 -> 远程访问：
   - `入口 URL`：Guacamole 的 base URL（例如 `https://remote.example.com/guacamole/`；如果你把 Guacamole 反代到域名根路径，也可以填 `https://remote.example.com/`）。
   - `系统 RDP 端口`：本机系统 RDP 端口（默认 `3389`）。
   - `加载 RDP 配置`：在 Windows 上一键开启 RDP+NLA、写入防火墙规则，并注册 RemoteApp 应用别名 `||MultipleShell`（需要以管理员权限运行 MultipleShell；同时建议先关闭多余 MultipleShell 实例，避免 RemoteApp 启动异常）。
   - `RemoteApp 快捷入口`：开关（关闭时 RemoteApp 入口永远不可用）。
   - `连接名 Base64 编码`：开关（开启后会把下面填写的连接名做 Base64 编码再生成直达链接，用于部分 Guacamole/网关部署）。
   - `RemoteApp 连接名` / `VNC 连接名`：推荐用 Guacamole 地址栏 `#/client/c/<...>` 的 `<...>`；也可用 `user-mapping.xml` 里的 `<connection name="...">`（若直达链接要求 Base64，请打开上面的 Base64 开关）。
2. 切换到顶部模式“远程”，即可看到：
   - 打开入口 / 复制入口链接
   - 打开 RemoteApp / 复制 RemoteApp 直达链接
   - 打开 VNC / 复制 VNC 直达链接

注意：

- 远程配置保存在渲染进程 `localStorage`（不加密、仅本机），不要在这里存放密码类敏感信息。

## 可选：远程访问部署（Guacamole / RemoteApp / RD Web Client）

仓库内包含一套“手机浏览器直达 RemoteApp/VNC/SSH”的参考配置与脚本（与 MultipleShell 核心终端功能解耦，不使用也不影响本地开发）。

- Guacamole（Docker）：
  - `../docker-compose.yml`：`guacd` + `guacamole`，使用 `user-mapping.xml`（file auth）作为认证/连接定义示例。
  - `../extensions/`：可挂载 Guacamole 扩展 JAR；本仓库也提供 `../extensions/custom-theme` 作为可选静态主题资源。
  - 启动示例：

    ```bash
    docker compose up -d
    ```

    默认仅监听 `127.0.0.1:8080`，入口通常为 `http://127.0.0.1:8080/guacamole/`（建议用 Nginx 反代到 443 对外提供）。
- Nginx 反代示例：
  - `nginx.conf`：包含 Guacamole WebSocket 反代示例与 `sub_filter` 注入自定义 CSS/JS 的示例片段（按你的域名/证书路径调整）。
- Windows RemoteApp 侧辅助脚本：
  - `../scripts/win-remoteapp-ensure.ps1`：开启 RDP+NLA、配置防火墙、从 `user-mapping.xml` 读取 `remote-app` 并注册到 `TSAppAllowList`（使 `||alias` 形式可用）。
  - `../scripts/test-rdp-connection.ps1`：RDP 端口 TCP 可达性检查（排查网络/防火墙）。
- RD Web Client（官方 HTML5）路线（可替代 Guacamole）：
  - 方案说明：[RD_WEB_CLIENT_WINDOWS_ZH.md](RD_WEB_CLIENT_WINDOWS_ZH.md)
  - 证书绑定辅助脚本：`../scripts/rds-rdwebclient-cert.ps1`
- Guacamole 自定义主题（可选）：
  - 说明：[../extensions/custom-theme/README.md](../extensions/custom-theme/README.md)
  - 一键部署：`../scripts/deploy-guacamole-theme.sh`

## 配置模板类型说明

应用内仅支持三种类型（对应 UI 下拉框/主进程校验）：

### 1) Claude Code（`claude-code`）

- 你编辑的是一份 `settings.json` 的内容（JSON 文本）。
- 启动会话时主进程会将其写入：`<userData>/claude-homes/<configId>/settings.json`，并设置环境变量 `CLAUDE_CONFIG_DIR` 指向该目录。
- Windows：会话会统一使用 `C:\\Users\\<username>\\.claude.json` 作为 Claude Code 的主目录配置；若不存在会自动创建 `{}`（不会复制/使用 `.claude.json.backup`）。
- 启动会话时会把 `.claude.json` 复制到 `<userData>/claude-homes/<configId>/.claude.json`，并删除会话相关字段（`lastSessionId`、`projects`），保证写回的是合法 JSON，避免不同配置之间串会话/项目状态。

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

- 你编辑的是一份 `.opencode.json`（JSON 文本）。
- 启动会话时主进程会将其写入：`<userData>/opencode-homes/<configId>/opencode/.opencode.json`，并设置 `XDG_CONFIG_HOME=<userData>/opencode-homes/<configId>` 让上游 OpenCode 自动读取该配置。
- 若未显式设置，MultipleShell 会注入 `data.directory=<userData>/opencode-runtime/<configId>`，把 OpenCode 会话历史落到 per-template 的稳定目录。
- 该类型支持额外 `envVars`（会注入到会话环境变量里）。

默认模板：

```json
{}
```

## 数据与安全

- 加密存储：
  - 配置存储文件：`<userData>/configs.v1.enc`
  - 草稿存储文件（用于 Codex 编辑器自动保存）：`<userData>/drafts.v1.enc`
  - 均使用 Electron `safeStorage` 加密（依赖系统密钥服务：Windows DPAPI / macOS Keychain / Linux libsecret）。
- 额外文件：
  - `claude-homes/`、`codex-homes/`、`opencode-homes/` 用于落地模板文件（便于外部工具读取）。
  - Codex 会话会在临时目录创建 `mps-codex-home-*`，会话退出后自动清理（可用 `MPS_KEEP_CODEX_HOME=1` 禁止清理以便调试）。
  - 多实例 agent 握手 token：`%APPDATA%\\MultipleShell\\agent-token`（Host 启动时生成；Client 用于握手鉴权）。
  - Client 独立 profile：`%LOCALAPPDATA%\\MultipleShell\\clients\\<pid>`（每个 Client 独立；删除后会自动重建）。
- 安全提醒（务必看）：
  - `user-mapping.xml` 为 Guacamole file auth 示例，包含明文账号/密码与目标主机信息；部署前务必替换，并避免把真实凭据提交到仓库。
  - 语音转写 API Key 当前由 `../src/main/built-in-config-manager.js` 提供（示例实现）；生产环境建议改为从外部配置/安全存储注入，并做好密钥轮换。

## 自动更新（可选启用）

- 通过环境变量控制：
  - `MPS_UPDATE_URL`：generic 更新源地址（未设置则更新功能显示为 disabled）
  - `MPS_UPDATE_DEV=1`：允许在未打包状态下启用更新逻辑（默认仅打包后启用）
- UI：菜单栏设置中提供“检查更新 / 下载进度 / 重启安装”等入口。

## 环境变量（排查/开发用）

- `MPS_AGENT_PIPE`：覆盖本机 agent 的 Named Pipe 名（默认按当前用户派生，桌面端与 RemoteApp 端共享同一条 pipe）。
- `MPS_CC_SWITCH_CONFIG_DIR` / `CC_SWITCH_CONFIG_DIR`：覆盖 CC Switch 配置目录（用于读取 `cc-switch.db`）。
- `MPS_UPDATE_URL`：启用自动更新（generic feed）。
- `MPS_UPDATE_DEV=1`：开发环境允许启用更新。
- `MPS_REMOTEAPP_EXE_PATH`：RemoteApp 注册时强制指定 `MultipleShell.exe` 路径（开发/自定义安装路径排查用）。
- `MPS_KEEP_CODEX_HOME=1`：不清理每个会话创建的临时 `CODEX_HOME`。
- `MPS_DEBUG_ENV_APPLY=1`：调试 env 注入行为（会在终端输出提示）。
- `MPS_SUPPRESS_DIALOGS=1`：抑制主进程弹窗（自检脚本使用）。
- `MPS_CLAUDE_PRESERVE_HISTORY=1`：保留 Claude Code 在模板 profile 下的 `history.jsonl`（默认会清理，避免续接旧会话）。

## 常见问题

### 依赖安装失败（node-gyp / node-pty）

这是本地 C++ 编译依赖缺失导致的，建议安装：

- Visual Studio Build Tools
- Python 3.x

安装完成后重新执行 `npm install`。

### 光标闪烁太快 / 多个光标框

- xterm 没有公开的“闪烁频率”选项；需要 patch xterm 内部常量或切换 DOM renderer 并改动画时长。
- 参考：[CURSOR_BLINKING_ISSUES.md](CURSOR_BLINKING_ISSUES.md)

### 看不到滚动条 / 无法回滚到更早内容

- 常见原因包括：overlay scrollbar、输出只用 `\r` 不换行、`clear/cls` 清屏、全屏 TUI（alternate screen）等。
- 参考：[SHELL_SCROLLBAR_ANALYSIS.md](SHELL_SCROLLBAR_ANALYSIS.md)

## 目录结构（简要）

```
src/
  main/        # Electron 主进程（配置存储、pty、更新、语音等）
  preload/     # IPC 桥接
  renderer/    # 前端界面（Vue）
scripts/       # 自检/工具脚本
build/         # NSIS 安装器脚本、图标等
configs/       # 旧版/迁移用模板（应用会尝试导入）
extensions/    # Guacamole 扩展/自定义主题静态资源（可选）
dist/          # Vite 构建产物（自动生成）
dist-electron/ # Vite Electron 构建产物（自动生成）
release/       # electron-builder 输出目录（自动生成）

docker-compose.yml  # Guacamole + guacd（file auth）示例
nginx.conf          # Nginx 反代/HTTPS/Guacamole WebSocket 示例
user-mapping.xml    # Guacamole file auth 示例（请替换账号/密码）
electron-builder.json
```

## 备注（面向维护者）

- `configs/` 目录内的 JSON 会在首次启动/迁移时尝试导入（详见 `../src/main/config-manager.js`）。
- 语音 API Key 当前为内置实现（见 `../src/main/built-in-config-manager.js`）；如需改为外部配置/加密文件，可从 `../scripts/encrypt-api-key.js`（生成 `../resources/voice-api.enc`）的思路继续完善。
- NSIS 安装/卸载“运行中检测 + 可选调试日志”实现位于 `../build/installer.nsh`，相关说明见 [UNINSTALL_RUNNING_CHECK_SOLUTION.md](UNINSTALL_RUNNING_CHECK_SOLUTION.md)。

## 文档索引（仓库内）

- 终端视图设计与取舍：
  - [SHELL_MONITORING_SOLUTION.md](SHELL_MONITORING_SOLUTION.md)
  - [MONITOR_CARD_THUMBNAIL_SAVING_ZH.md](MONITOR_CARD_THUMBNAIL_SAVING_ZH.md)
  - [SHELL_MONITORING_TODO.md](SHELL_MONITORING_TODO.md)
- 终端体验问题分析：
  - [CURSOR_BLINKING_ISSUES.md](CURSOR_BLINKING_ISSUES.md)
  - [SHELL_SCROLLBAR_ANALYSIS.md](SHELL_SCROLLBAR_ANALYSIS.md)
- Windows 安装/卸载（NSIS）：
  - [UNINSTALL_RUNNING_CHECK_SOLUTION.md](UNINSTALL_RUNNING_CHECK_SOLUTION.md)
- 远程访问（浏览器 / 手机）方案：
  - [GUACAMOLE_REMOTEAPP_WINDOWS_ZH.md](GUACAMOLE_REMOTEAPP_WINDOWS_ZH.md)
  - [GUACAMOLE_REMOTEAPP_WINDOWS_ZH_TODO.md](GUACAMOLE_REMOTEAPP_WINDOWS_ZH_TODO.md)
  - [GUACAMOLE_REMOTEAPP_MULTIPLESHELL_ZH_TODO.md](GUACAMOLE_REMOTEAPP_MULTIPLESHELL_ZH_TODO.md)
  - [RD_WEB_CLIENT_WINDOWS_ZH.md](RD_WEB_CLIENT_WINDOWS_ZH.md)
  - [RD_WEB_CLIENT_WINDOWS_ZH_TODO.md](RD_WEB_CLIENT_WINDOWS_ZH_TODO.md)
  - [MOBILE_REMOTE_ACCESS_SOLUTION_ZH.md](MOBILE_REMOTE_ACCESS_SOLUTION_ZH.md)
  - [MOBILE_REMOTE_ACCESS_SOLUTION_WINDOWS_ZH.md](MOBILE_REMOTE_ACCESS_SOLUTION_WINDOWS_ZH.md)
  - [MOBILE_REMOTE_ACCESS_SOLUTION_LINUX_ZH.md](MOBILE_REMOTE_ACCESS_SOLUTION_LINUX_ZH.md)
- Guacamole 主题：
  - [../extensions/custom-theme/README.md](../extensions/custom-theme/README.md)

## 反馈与贡献

欢迎提交 Issue 或 Pull Request。建议在提交前说明复现步骤/预期结果，便于定位问题。
