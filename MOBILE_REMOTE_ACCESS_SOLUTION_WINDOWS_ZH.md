# 手机远程连接应用方案（Windows）— 可持续运行 + 可交互（Web/APP）

## 0. 你该选哪条路（快速决策）

| 你的需求 | 推荐方案 | 手机怎么连 |
|---|---|---|
| 需要 GUI（桌面程序/浏览器/IDE/可视化） | **RDP（首选）**，可叠加 Guacamole 做 Web 入口 | 手机 Remote Desktop App 或 浏览器（Guacamole） |
| 纯命令行/终端交互（脚本、REPL、长任务） | **WSL2(Ubuntu) + SSH + tmux + systemd**（最稳） | 手机 SSH App 或 浏览器（Guacamole/ttyd） |
| 想“一个链接搞定”（统一入口/多用户/多机器） | **Nginx(HTTPS) + Guacamole（RDP + SSH）** | 手机浏览器打开链接 |
| 安全要求很高，不想暴露公网入口 | **WireGuard VPN +（RDP/SSH/Guacamole）** | 手机装 WireGuard + 浏览器/APP |

> Windows 上“持续存在 + 可交互”最稳的两条线：  
> - **GUI：RDP 会话**（断线不等于注销；重新连接可继续操作同一桌面）  
> - **CLI：放到 WSL2 里用 tmux**（得到类 Linux 的持久终端体验）

## 1. 总体架构（推荐：公网只暴露 443）

### 1.1 推荐拓扑（Web 统一入口）

```text
手机浏览器
  |
  | https://remote.example.com (443)
  v
Nginx(证书/TLS/鉴权/限流)
  |
  v
Guacamole(HTML5 远程门户)
  | RDP                       | SSH
  v                           v
Windows 主机（桌面会话）        Windows 主机（进入 WSL2 tmux）
```

### 1.2 端口策略

- 公网暴露：**443/tcp**
- 可选：`51820/udp`（WireGuard VPN）
- 尽量不直接暴露到公网：`3389`（RDP）、`22`（SSH）

## 2. GUI 远程（首选）：RDP（会话持久 + 体验最好）

### 2.1 前置条件

- Windows 10/11：需要 **Pro/Enterprise/Education** 才能作为 RDP 服务端（Home 版通常只能当客户端）
- Windows Server：默认可用（注意授权/策略）

### 2.2 开启远程桌面（RDP）

图形界面路径（通用）：

- 设置 -> 系统 -> 远程桌面 -> 启用远程桌面

建议同时开启：

- **仅允许运行带网络级别身份验证(NLA)的远程桌面连接**（更安全）

### 2.3 确保“断线后应用仍持续运行”

关键点：**只“断开连接”，不要“注销/退出登录”**。

- 你在 RDP 里启动应用后：
  - 直接关闭手机端远程桌面 App / 切后台 / 断网：通常等价于“断开”，应用会继续运行
  - 下次重新连回来，会回到同一个 Windows 会话（桌面、窗口、进程都在）

为避免系统策略自动结束会话，建议检查组策略（Windows Pro/Server）：

- `gpedit.msc`
  - 计算机配置 -> 管理模板 -> Windows 组件 -> 远程桌面服务 -> 远程桌面会话主机 -> 会话时间限制  
    - “设置断开会话的时间限制”：**禁用**（或设为较长）  
    - “达到时间限制时结束会话”：**禁用**

### 2.4 手机访问方式

- **手机 App（推荐）**：Microsoft Remote Desktop（或系统自带/第三方 RDP 客户端）
- **手机 Web（推荐）**：用 Guacamole 做 RDP Web 门户（见第 4 节）

### 2.5 安全建议（RDP）

- 尽量不要公网直开 `3389`
- 推荐：`WireGuard VPN` 或 `Guacamole(HTTPS)` 做入口
- 必做：强密码/账号锁定策略、开启 NLA、限制来源 IP（Windows 防火墙）

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

#### 做法 A（更简单、更稳）：先连 Windows（RDP/SSH），再进入 WSL

- RDP 进 Windows 桌面 -> 打开 Ubuntu（WSL） -> `tmux attach -t myapp`
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

### 4.2 Guacamole 部署位置建议

更稳的做法：

- **把 Guacamole + Nginx 放在一台 Linux 网关机/云服务器上**（运维更简单）
- Windows 机器只作为“被控机”（RDP/SSH/WSL）

也可以选：

- Windows 上用 Docker Desktop 跑 Guacamole（可行，但对 Windows 环境/更新依赖更强）

### 4.3 Guacamole 里怎么配 Windows

- 配一个 RDP 连接到 Windows（建议走内网/VPN）
- 如果要 CLI：
  - 配一个 SSH 连接（连 Windows OpenSSH 或连 WSL）
  - 登录后 `tmux attach -t myapp`

## 5. 如果必须用 VNC（不推荐但可落地）

一般不建议在 Windows 上优先 VNC（性能/安全/体验通常弱于 RDP），但如果你确实需要：

- 装 VNC Server（如 TightVNC/UltraVNC/RealVNC 等）
- 强烈建议：只在 VPN/内网用；不要裸奔公网
- 手机 Web：用 Guacamole 的 VNC 连接（统一入口）

## 6. 安全与稳健性清单（建议照做）

- 公网只开 `443`（可选 `51820` VPN）
- RDP：开启 NLA；限制来源 IP；不要公网直开 3389
- 账号：不用 Administrator 直连；最小权限；强密码；启用账号锁定策略
- 系统：关闭自动休眠/睡眠（否则远程断线后可能进入不可用状态）
- 审计：事件查看器（登录/失败/远程桌面事件）；必要时集中日志
- 备份：关键配置（Nginx/证书/Guacamole 数据库/WSL 重要数据）

## 7. 最小落地步骤（按顺序）

1) GUI 应用：先把 RDP 开好，并验证“断开后不断进程”
2) CLI 应用：优先放到 WSL2，用 tmux + systemd 固定跑起来
3) 想一个链接：上 Nginx(HTTPS) + Guacamole，公网只开 443
4) 最后加固：WireGuard/VPN、限制 3389/22、强鉴权与限流

