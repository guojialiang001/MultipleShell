# 手机远程连接应用方案（Windows）— 应用级 RemoteApp + 可持续运行 + 可交互（Web/APP）

## 0. 你该选哪条路（快速决策）

| 你的需求 | 推荐方案 | 手机怎么连 |
|---|---|---|
| 只想远程“一个应用窗口”（应用级，非完整桌面） | **RemoteApp（RDS / AVD）**；或 **Guacamole 的 RDP RemoteApp**（轻量） | 手机 Microsoft Remote Desktop（Workspace）或 浏览器（Guacamole） |
| 需要完整桌面（运维/装软件/多窗口） | **完整 RDP（备用）**，可叠加 Guacamole 做 Web 入口 | 手机 Remote Desktop App 或 浏览器（Guacamole） |
| 纯命令行/终端交互（脚本、REPL、长任务） | **WSL2(Ubuntu) + SSH + tmux + systemd**（最稳） | 手机 SSH App 或 浏览器（Guacamole/ttyd） |
| 想“一个链接搞定”（统一入口/多用户/多机器） | **Nginx(HTTPS) + Guacamole（RemoteApp/RDP + SSH）** | 手机浏览器打开链接 |
| 安全要求很高，不想暴露公网入口 | **WireGuard VPN +（RemoteApp/RDP/SSH/Guacamole）** | 手机装 WireGuard + 浏览器/APP |

> Windows 上“持续存在 + 可交互”最稳的两条线：  
> - **GUI：RemoteApp（应用级 RDP）**（客户端只看到应用窗口；断线不等于注销；重连回到同一会话）  
> - **CLI：放到 WSL2 里用 tmux**（得到类 Linux 的持久终端体验）

## 1. 总体架构（推荐：公网只暴露 443）

### 1.1 推荐拓扑（两种常见落地）

#### A) RemoteApp（RDS/AVD）+ RD Gateway（官方、应用级、只走 443）

```text
手机 Microsoft Remote Desktop
  |
  | 443 (RD Gateway)
  v
RD Gateway（证书/TLS/策略/审计）
  |
  v
RD Session Host（RemoteApp：发布指定应用）
```

#### B) Web 统一入口（Guacamole）发布 RemoteApp（轻量、一个链接）

```text
手机浏览器
  |
  | https://remote.example.com (443)
  v
Nginx(证书/TLS/鉴权/限流)
  |
  v
Guacamole(HTML5 远程门户)
  | RDP(RemoteApp)            | SSH
  v                           v
Windows 主机（只启动指定应用）  Windows 主机（进入 WSL2 tmux）
```

### 1.2 端口策略

- 公网暴露：**443/tcp**
- 可选：`51820/udp`（WireGuard VPN）
- 尽量不直接暴露到公网：`3389`（RDP）、`22`（SSH）

## 2. 应用级 GUI 远程（首选）：RemoteApp（只暴露单个应用窗口）

### 2.1 关键认知（避免走错路）

- RemoteApp 本质上仍是 RDP 会话，只是客户端只渲染指定程序窗口（而不是整张桌面）。
- **要“官方”发布 RemoteApp（服务端侧列出应用、强隔离、易审计）**：通常需要 **Windows Server Remote Desktop Services（RDS）** 或 **Azure Virtual Desktop（AVD）**。
- 如果你只有 Windows 10/11（Pro/Enterprise/Education）并且只是想“用户只能打开某个应用”，可以走 **Guacamole 的 RDP RemoteApp 参数**（更轻量，但隔离能力弱于 RDS/AVD）。

### 2.2 方案 A（官方/企业）：RDS RemoteApp + RD Gateway（443）

适用：多用户/权限隔离/审计/希望“像应用商店一样点图标打开应用”。

落地组件（典型）：

- RD Session Host（承载 RemoteApp 会话）
- RD Web Access（提供 Workspace/Feed）
- RD Gateway（把 RDP 统一收敛到 443；也便于策略与审计）

手机怎么连（概念流程）：

- 手机上用 Microsoft Remote Desktop 添加 Workspace（从 RD Web Access 获取 Feed/Workspace URL，通常形如 `https://<域名>/RDWeb/Feed/webfeed.aspx`）
- 订阅后会看到 RemoteApp 图标；点图标直接进入应用窗口

#### 2.2.1 Windows Server（单机/小规模）最小落地步骤（只发布应用，不给完整桌面）

> 前置：RDS 的“标准/快速启动部署”通常要求服务器加入 AD 域（建议直接走域环境）；如果你只有工作组环境，优先考虑 2.3（Guacamole RemoteApp）或 AVD。

1) 安装 RDS 角色（Server Manager）
   - Server Manager -> Manage -> Add Roles and Features
   - Remote Desktop Services installation -> Quick Start
   - Deployment type：Session-based desktop deployment
   - 选择同一台服务器承担：RD Connection Broker + RD Web Access + RD Session Host（小规模可同机）
2) 发布 RemoteApp
   - Server Manager -> Remote Desktop Services -> Collections
   - 进入你的 Collection -> `RemoteApp Programs` -> Publish RemoteApp Programs
   - 只发布你要的 exe；不要发布 Explorer（避免“绕出”成桌面）
3) 收敛到 443（对公网不暴露 3389）
   - 在 RDS Overview 里 Add RD Gateway（同机或单独一台都行）
   - 配好 RD Gateway 证书与 CAP/RAP 策略
   - 外网只开 443/tcp；3389 只留内网（或仅允许 Gateway/管理网段）
4) 配证书（否则手机端经常连不上/报不受信）
   - RDS -> Deployment Properties -> Certificates
   - 至少把 RD Web Access 与 RD Gateway 的证书配成你的域名证书（建议公网受信）
5) 手机端连接
   - Microsoft Remote Desktop -> Add Workspace -> 填 Feed URL：`https://<域名>/RDWeb/Feed/webfeed.aspx`
   - 登录后出现 RemoteApp 图标，点击即打开“应用窗口”
6) 授权（避免到期掉线）
   - 配 RD Licensing + RDS CAL（Per User/Per Device 按你的授权购买情况）

#### 2.2.2 纯浏览器入口（官方）：RD Web Client（HTML5）

如果你的硬性要求是“**不装 Remote Desktop 客户端，必须浏览器打开就能用**”，就需要在 RDS 上启用 **RD Web Client**（HTML5）。

- 入口形态：
  - 用户打开 `https://<域名>/RDWeb/webclient/`（或 `.../RDWeb/webclient/index.html`）
  - 浏览器登录后，看到 RemoteApp 列表并点击启动（浏览器里直接渲染应用窗口）
- 说明：
  - `https://<域名>/RDWeb/Feed/webfeed.aspx` 是给“Remote Desktop 客户端订阅 Workspace”用的 Feed，不是给浏览器直接启动会话的接口；Python 去“调用 feed”也无法在浏览器里产生可交互的 RDP 会话。
  - 真正能让浏览器交互，需要“浏览器端的 RDP 客户端实现”，RD Web Client/Guacamole 本质上都在做这件事。

### 2.3 方案 B（轻量/自建门户）：Guacamole 的 RDP RemoteApp（一个连接 = 一个应用）

适用：单机/少用户/你已经在用 Guacamole/Nginx，希望“一个链接登录后点应用”。

前置条件：

- Windows 10/11：需要 **Pro/Enterprise/Education** 才能作为 RDP 服务端（Home 版通常只能当客户端）
- Windows Server：可直接作为 RDP 服务端（注意授权/策略）

配置要点（Guacamole -> 连接 -> 协议 RDP）：

- 为每个应用单独建一个 Guacamole 连接（更容易做权限）
- 在 RDP 连接参数里启用 RemoteApp（字段名可能是 `Remote app` / `remote-app`）
  - 常见示例：`||notepad`、`||calc`
  - 自定义程序通常填 RemoteApp 别名或完整路径（不同服务端/客户端实现可能有差异）

> 提醒：这种方式的“只能打开某应用”更多是“入口只给你这个程序”；如果你需要更强的限制（禁止 explorer/控制面板/文件对话框绕出等），优先用 RDS/AVD 或配合 AppLocker/软件限制策略。

### 2.4 确保“断线后应用仍持续运行”（RemoteApp/RDP 通用）

关键点：**只“断开连接”，不要“注销/退出登录”**。

- 你在 RemoteApp 里启动应用后：
  - 直接关闭手机端 Remote Desktop / 切后台 / 断网：通常等价于“断开”，应用会继续运行
  - 下次重新连回来，会回到同一个 Windows 会话（进程与状态还在）

为避免系统策略自动结束会话，建议检查组策略（Windows Pro/Server）：

- `gpedit.msc`
  - 计算机配置 -> 管理模板 -> Windows 组件 -> 远程桌面服务 -> 远程桌面会话主机 -> 会话时间限制  
    - “设置断开会话的时间限制”：**禁用**（或设为较长）  
    - “达到时间限制时结束会话”：**禁用**

### 2.5 手机访问方式（应用级）

- **RDS/AVD RemoteApp**：手机 Microsoft Remote Desktop -> 订阅 Workspace -> 点 RemoteApp 图标打开
- **Guacamole RemoteApp**：手机浏览器打开 Guacamole -> 点对应“应用连接”打开

### 2.6 安全建议（RemoteApp/RDP）

- 尽量不要公网直开 `3389`
- 推荐：RD Gateway(443) 或 Guacamole(HTTPS) 做入口；安全要求更高就叠加 WireGuard VPN
- 必做：强密码/账号锁定策略、开启 NLA、限制来源 IP（Windows 防火墙）

## 2B. 桌面级（备用/运维入口）：完整 RDP

如果你主要目标是“应用级”，建议仍保留一个仅管理员可用的完整桌面入口，用于：装软件/打补丁/排障/处理弹窗。

## 3. CLI 持久交互（推荐）：WSL2 + SSH + tmux

如果你的“应用”是命令行交互式程序，想要 tmux 这种“断线不断”的体验，最稳的做法是：**应用跑在 WSL2 的 Linux 里**。

### 3.1 安装 WSL2（管理员 PowerShell）

```powershell
wsl --install -d Ubuntu
```

安装完成后重启；首次打开 Ubuntu 终端完成用户初始化。

### 3.2 在 WSL2 中启用 systemd（推荐）

编辑 `/etc/wsl.conf`：

```ini
[boot]
systemd=true
```

然后在 Windows 里执行：

```powershell
wsl --shutdown
```

重新打开 Ubuntu，让 systemd 生效。

### 3.3 在 WSL2 安装 tmux + openssh-server

在 Ubuntu（WSL）里：

```bash
sudo apt-get update
sudo apt-get install -y tmux openssh-server
sudo systemctl enable --now ssh
```

### 3.4 用 systemd 固定启动一个 tmux 会话跑你的应用

WSL 内创建：`/etc/systemd/system/myapp-tmux.service`

```ini
[Unit]
Description=MyApp in tmux (WSL)
After=network.target

[Service]
Type=forking
User=%i
Restart=always
RestartSec=3

ExecStart=/usr/bin/tmux new-session -d -s myapp '/opt/myapp/run.sh'
ExecStop=/usr/bin/tmux kill-session -t myapp

[Install]
WantedBy=multi-user.target
```

> 说明：`User=%i` 这类写法需要你用模板服务；如果你不熟，直接写死一个 WSL 用户也可以。核心是：**应用永远在 tmux 会话里**。

### 3.5 手机怎么连到 WSL 的 tmux

你有两种稳定做法（二选一）：

#### 做法 A（更简单、更稳）：先连 Windows（RemoteApp/SSH），再进入 WSL

- 发布一个“终端类应用”作为 RemoteApp（例如 Windows Terminal/PowerShell/Ubuntu），进入后 `tmux attach -t myapp`
- 或者开 Windows OpenSSH Server（端口固定）：
  - 手机 SSH 到 Windows
  - 执行 `wsl -d Ubuntu` 进入 WSL
  - 执行 `tmux attach -t myapp`

优点：端口与网络结构简单；不需要处理 WSL IP 变化。

#### 做法 B（更“像服务器”）：端口转发，让外部可直连 WSL 的 sshd

WSL2 的 IP 可能变化，需要用 `netsh portproxy` 做转发（示意）：

1) 获取 WSL IP（示意命令）  
2) 把 Windows 的某个端口（例如 2222）转到 WSL 的 22  
3) 做一个“开机/登录时刷新转发”的计划任务

> 该做法能让手机 SSH 直连 WSL，但运维复杂度更高；除非你明确需要，否则推荐用做法 A。

## 4. 手机 Web 入口（推荐）：Guacamole（RDP + SSH 一个门户）

### 4.1 为什么推荐

- 手机浏览器可直接 RDP/SSH（一个链接）
- 多用户、多连接管理（适合团队）
- 和 Nginx/HTTPS/VPN 组合后，可做到公网只开 443
  - 也可以把 RDP 连接设置为 RemoteApp，从而实现“应用级入口”

### 4.2 Guacamole 部署位置建议

更稳的做法：

- **把 Guacamole + Nginx 放在一台 Linux 网关机/云服务器上**（运维更简单）
- Windows 机器只作为“被控机”（RDP/SSH/WSL）

也可以选：

- Windows 上用 Docker Desktop 跑 Guacamole（可行，但对 Windows 环境/更新依赖更强）

### 4.3 Guacamole 里怎么配 Windows

- 配一个 RDP 连接到 Windows（建议走内网/VPN）
  - 如果只想一个应用窗口：在连接参数里启用 RemoteApp（见 2.3）
- 如果要 CLI：
  - 配一个 SSH 连接（连 Windows OpenSSH 或连 WSL）
  - 登录后 `tmux attach -t myapp`

### 4.4 纯浏览器“一键直达某个应用”（Nginx + Guacamole + RDP RemoteApp）

目标：手机浏览器打开一个链接，**直接看到某个应用窗口**（而不是完整桌面、也不需要先点列表）。

关键点：

- “直达链接”只是让 Guacamole **直接打开某个连接**；是否“只看到应用”取决于该连接是否配置为 **RDP RemoteApp**（见 2.3）。
- 如果没做单点/免登，用户仍会先看到 Guacamole 登录页；要做到真正“一键”，需要额外处理鉴权（见下）。

#### 4.4.1 在 Guacamole 创建“应用级”RDP 连接（RemoteApp）

Guacamole 管理界面 -> Connections -> New Connection：

- Protocol：RDP
- Network：
  - Hostname：你的 Windows Server / RD Session Host（建议内网地址）
  - Port：3389（仅内网开放）
- Authentication：
  - Username / Password（或走域账号）
  - Security mode：建议 NLA
- RemoteApp（字段名可能是 `Remote app` / `remote-app`）：
  - 示例：`||notepad`、`||calc`

验证方式：先在 Guacamole 里点这个连接测试；如果配置生效，你会看到“应用窗口”，而不是完整桌面。若出现完整桌面，通常是 RemoteApp 参数未生效/服务端不支持该程序的 RemoteApp 启动方式，需要调整 RemoteApp 配置或改用 RDS 正式发布 RemoteApp。

#### 4.4.2 获取 `<连接ID>` 并生成“直达链接”

1) 在 Guacamole 里点击该连接进入一次会话  
2) 观察浏览器地址栏，通常会变成：`#/client/c/<连接ID>`  
3) 你的直达链接就是：

`https://remote.example.com/#/client/c/<连接ID>`

这类链接可直接发给手机，或做成二维码/书签。

#### 4.4.3 让它真正“一键”（免二次登录）

推荐二选一：

- **VPN/IP 白名单 + Guacamole no-auth**：内网/受控网络里最省事；不适合公网裸奔。
- **Nginx(SSO/OIDC/BasicAuth) + Guacamole header-auth**：登录交给网关；Guacamole 通过请求头识别用户并直接进连接（更适合公网）。

## 5. 如果必须用 VNC（不推荐但可落地）

一般不建议在 Windows 上优先 VNC（性能/安全/体验通常弱于 RDP），但如果你确实需要：

- 装 VNC Server（如 TightVNC/UltraVNC/RealVNC 等）
- 强烈建议：只在 VPN/内网用；不要裸奔公网
- 手机 Web：用 Guacamole 的 VNC 连接（统一入口）

## 6. 安全与稳健性清单（建议照做）

- 公网只开 `443`（可选 `51820` VPN）
- RemoteApp/RDP：开启 NLA；限制来源 IP；不要公网直开 3389（优先走 RD Gateway/Guacamole 收敛到 443）
- 账号：不用 Administrator 直连；最小权限；强密码；启用账号锁定策略
- 系统：关闭自动休眠/睡眠（否则远程断线后可能进入不可用状态）
- 审计：事件查看器（登录/失败/远程桌面事件）；必要时集中日志
- 备份：关键配置（Nginx/证书/Guacamole 数据库/WSL 重要数据）

## 7. 最小落地步骤（按顺序）

1) GUI 应用：先选定 RemoteApp 落地方式（RDS/AVD 或 Guacamole RemoteApp），并验证“断开后不断进程”
2) CLI 应用：优先放到 WSL2，用 tmux + systemd 固定跑起来
3) 想一个链接：上 Nginx(HTTPS) + Guacamole，公网只开 443
4) 最后加固：WireGuard/VPN、限制 3389/22、强鉴权与限流
