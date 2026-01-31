# MultipleShell：RemoteApp 与桌面端同步（不剥离为系统 Service）的实现方案

目标：在**同一台 Windows 机器**上，桌面会话里运行的 MultipleShell 与通过 RDP RemoteApp（Guacamole/RD Web Client 等）启动的 MultipleShell **同时可用**，并且两端看到/操作的是**同一批终端会话**（输入输出实时同步）。

> 重要前提：RemoteApp 启动的 MultipleShell 本质是“另一个 Windows 会话里的另一个进程”，如果不引入共享后端（agent），两端状态天然不可能同步。

---

## 1. 范围与非目标

范围（本方案要做到）：

- 同机、同用户（推荐）、跨 Windows 会话（Console + RDP RemoteApp）：
  - 会话列表同步（谁创建都能在另一端出现）
  - 终端输出/输入同步（谁输入都能影响同一 PTY）
  - 关闭/重启同步（关闭会话在另一端消失）
- 不需要把 PTY 完全剥离成 Windows Service；仍然可以在 MultipleShell 进程内运行 PTY（“主控实例=Host”持有 PTY）。

非目标（本方案不保证）：

- 跨机器同步（A 机器的 MultipleShell 与 B 机器同步）
- 不同 Windows 用户之间共享同一批终端（高风险；可作为后续增强）
- Host 退出后终端仍然存活（除非进一步做成真正常驻 agent/service）

---

## 2. 核心结论：不能只做“单实例”

Electron 的单实例（`requestSingleInstanceLock()`）会让第二个进程直接退出并把事件转发给第一个实例：

- RemoteApp 会话里会**拿不到可操作窗口**
- 也不会让两个进程“共享内存里的 tabs/pty”

因此必须做成：

- 1 个进程当 **Host（主控/agent）**：唯一持有 PTY，维护 session 列表
- N 个进程当 **Client（客户端 UI）**：只显示 UI，通过本机 IPC 访问 Host

---

## 3. 总体架构（Host + Client + 本机 IPC）

### 3.1 Host 职责

- 唯一持有终端会话（`node-pty` / ConPTY）
- 维护“会话注册表”（session metadata：id、title、cwd、config 摘要等）
- 统一对外提供 RPC（创建/写入/resize/kill、获取会话列表、获取 monitor 状态等）
- 将终端数据/状态变化广播给所有 Client

建议同时让 Host 独占以下能力（避免并发写用户目录导致损坏）：

- configs/drafts 的读写（加密存储）
- voice api key 与转写请求
- monitor tick / monitor:update 广播
- update 检查（避免多个实例同时下载/安装）

### 3.2 Client 职责

- 只负责 UI：tab 切换、输入框、布局等
- 任何“会产生副作用”的操作都转发给 Host（create/write/kill/saveConfig…）
- 接收 Host 广播的事件并更新 UI

### 3.3 IPC 传输层（推荐 Named Pipe）

- Windows Named Pipe：`\\\\.\\pipe\\mps-agent-<UserSID>`（按用户隔离）
- RPC 协议：JSON 消息（request/response/notification）

备用（可选）：

- `127.0.0.1:<port>` WebSocket（仍然仅本机访问）

### 3.4 鉴权（必须）

Named Pipe 默认可能被其他本机用户尝试连接，必须做握手鉴权：

- Host 启动时生成随机 token（32 bytes）
- token 写入：`%APPDATA%\\MultipleShell\\agent-token`（仅当前用户默认可读）
- Client 连接后先发送 `{type:"hello", token:"..."}`，Host 校验失败立即断开

---

## 4. Host 选举（不靠 Electron 单实例）

启动流程（每个 MultipleShell 进程都执行）：

1) 尝试连接 pipe
   - 如果连接成功 -> 自己是 Client
2) 如果连接失败（pipe 不存在/拒绝） -> 尝试创建 pipe server 监听
   - 监听成功 -> 自己是 Host
   - 监听失败（EADDRINUSE）-> 再次尝试连接 -> Client

这样可以允许多个 UI 实例同时存在，但永远只有一个 Host。

---

## 5. 多实例下的“配置目录/文件锁”问题（必须处理）

Chromium 的 localStorage/IndexedDB/Cache（LevelDB）对同一 profile 多进程并发很容易出问题。

建议策略：

- Host 使用默认 `userData`（保持现有加密存储路径不变）
- Client 使用**独立**的 `userData`：
  - 例如：`%LOCALAPPDATA%\\MultipleShell\\clients\\<pid>` 或 `...\\clients\\<random>`
  - Client 不再直接读写 configs/drafts（都走 Host RPC）

这样可以避免：

- 两个实例同时写 `configs.v1.enc` / drafts 造成竞争
- Chromium profile lock/LevelDB 损坏

---

## 6. RPC API 设计（建议 JSON-RPC 风格）

消息格式：

- Request：`{ id, method, params }`
- Response：`{ id, result }` 或 `{ id, error: { message, code } }`
- Notification：`{ method, params }`（无 id）

### 6.1 必需方法（最小闭环）

- `terminal.create` -> `{ sessionId, meta }`
- `terminal.write` -> `true`
- `terminal.resize` -> `true`
- `terminal.kill` -> `true`
- `sessions.list` -> `[{ sessionId, title, workingDir, configSummary, createdAt, ... }]`
- `sessions.subscribe` -> `true`

### 6.2 广播事件（Host -> Clients）

- `sessions.changed` -> 发送全量列表或增量 diff
- `terminal.data` -> `{ sessionId, data }`
- `terminal.exit` -> `{ sessionId, code }`
- `monitor.update` -> 与当前 `monitor:update` payload 一致
- （可选）`toast` / `error` -> 用于提示断连/权限问题

### 6.3 现有 Electron IPC 的兼容策略

目标：尽量不改 renderer 调用方式（`window.electronAPI.*`）。

做法：

- 在 main 里增加一个“后端分发层”：
  - Host：原有 `ipcMain.handle()` 实现保持，内部调用本地 manager
  - Client：同名 `ipcMain.handle()` 但内部改为 `agentRpc.call(method, params)`
- 同理，Host 原本 `webContents.send('terminal:data')`：
  - 仍发送给 Host 自己的窗口
  - 同时通过 agent 广播给 Clients，由 Client main 再转发到各自 renderer

---

## 7. UI 同步：需要让 tabs/session 列表“来源于 Host”

当前 `src/renderer/App.vue` 的 tabs 只在本进程内维护，远端创建不会出现在本地。

必须改造为：

- 启动时：`sessions.list` 拉取会话列表
- 订阅：监听 `sessions.changed` 事件实时更新 tabs
- 本地“新建终端”：
  - 仍由 UI 发起
  - 实际创建由 Host 完成并广播，UI 只根据广播更新 tabs（避免自己先写 tabs 导致双写/不一致）

每个 Client 仍可保留自己的 UI 状态：

- 当前激活 tab（activeTabId）可以每端独立
- 关闭窗口/布局/语言等也可以独立

---

## 8. RemoteApp 相关注意事项

- 不要启用 Electron 单实例锁来实现“共享”，否则 RemoteApp 端会没有窗口。
- 设置里的“加载 RDP 配置”按钮：建议先检测是否已经存在多个 MultipleShell 实例；若检测到“多应用”，提示用户关闭多余实例再继续（否则 RemoteApp 端可能无法正常启动）。
- RemoteApp 端应作为 Client 连接 Host：
  - 若桌面端已启动并成为 Host，则 RemoteApp 启动后自动连上
  - 若 RemoteApp 先启动，它可能成为 Host；桌面端后启动会作为 Client（也能同步）

若你希望“总是桌面端当 Host”，需要额外策略（可选）：

- 识别是否 Console session（WTS APIs），优先让 Console 成为 Host
- 或者显式开关“固定 Host 模式”（复杂，后续再做）

---

## 9. 安全与隐患控制（必须写进默认策略）

因为 agent 本质提供“可交互 shell”，必须强约束：

- 只监听本机（Named Pipe / 127.0.0.1），默认绝不对外网开放
- token 握手，token 存用户目录，防止其他用户直接连上
- Host 不要常驻管理员权限：
  - “加载 RDP 配置/写防火墙”单独提权执行
  - agent/pty 日常以普通用户运行
- 限流与边界：
  - 单条消息大小限制
  - 最大会话数/最大订阅数
  - 客户端断开自动清理订阅

---

## 10. 分阶段实施计划（建议）

### Phase 1：Agent 通道 + 终端数据跨进程（最小闭环）

- 新增：`src/main/agent/`（server + client）
- Host：创建 pipe server；Client：连接 pipe
- 将 `terminal:data`、`terminal:exit` 从 Host 广播到 Client
- Client main 收到后转发给 renderer，保证 Terminal 组件能看到输出

验收：

- 两个实例同时运行
- 任一端输入，另一端看到输出

### Phase 2：会话列表同步（tabs 同步）

- Host 维护 sessions registry
- 实现 `sessions.list` + `sessions.changed`
- 改 `src/renderer/App.vue`：tabs 从 Host 获取并订阅更新

验收：

- RemoteApp 创建终端，桌面端出现新 tab（反之亦然）

### Phase 3：把“有状态写入”的能力集中到 Host

- configs/drafts/voice/update/monitor 统一由 Host 执行
- Client 的 `ipcMain.handle()` 全部变为 RPC 转发

验收：

- 多实例并行不再互相写用户目录导致损坏

### Phase 4：Client 独立 userData（解决 Chromium profile 并发）

- Client 启动时 `app.setPath('userData', <client-userData>)`
- Host 仍用默认 userData
- token 文件放在 `%APPDATA%\\MultipleShell\\agent-token`，保证 Host/Client 都能读

验收：

- 两个实例并行长期运行不出现 profile 错误/锁冲突

---

## 11. 测试用例（手工）

- 桌面端先启动（Host）：
  - 新建 2 个终端
  - RemoteApp 再启动：能看到 2 个终端 + 输出同步
- RemoteApp 先启动（Host）：
  - 新建终端
  - 桌面端再启动：能看到终端 + 输出同步
- Host 退出：
  - Client 提示断开（不会静默挂死）
- 断线重连：
  - Client 重新连接后能恢复 session 列表与输出

---

## 12. 后续可选增强

- 多用户共享（高风险）：需要权限模型（只读/可写）、审计、ACL、强鉴权
- 跨机器同步：TLS、账号体系、反向代理、零信任网络（Tailscale/WireGuard）等
- Host 变为真正常驻：同一 exe 的 `--agent` 模式（无 UI），由 UI 自动拉起
