# 手机远程连接应用方案（Linux）— 可持续运行 + 可交互（Web/APP）

## 0. 你该选哪条路（快速决策）

| 你的需求 | 推荐方案 | 手机怎么连 |
|---|---|---|
| 纯命令行/终端交互（脚本、REPL、长任务） | `SSH + tmux + systemd`（最稳） | 手机 SSH App 或 Web 门户（Guacamole） |
| 需要 GUI（桌面/浏览器/IDE/可视化） | `VNC( TigerVNC ) + Xfce + systemd` 或 `RDP(如果有)` | VNC/RDP App 或 Web 门户（Guacamole） |
| 想“一个链接搞定一切”（多用户/多机器/统一入口） | `Nginx(HTTPS) + Guacamole`（统一门户） | 手机浏览器打开链接 |
| 想“一个链接直达终端/桌面”（单机/少用户） | `ttyd + tmux`（Web 终端）/ `noVNC + VNC`（Web 桌面） | 手机浏览器打开链接 |
| 安全要求很高，不想暴露公网入口 | `WireGuard VPN + (SSH/tmux 或 Guacamole)` | 手机装 WireGuard + 浏览器/APP |

> 原则：**应用运行方式（tmux/VNC）负责“持续存在”**；**入口（VPN/Guacamole/Nginx）负责“手机好连 + 安全”**。

## 1. 总体架构（推荐：只对外暴露 443）

### 1.1 推荐拓扑（统一 Web 入口 + 内网协议）

```text
手机浏览器/手机App
  |
  |  https://remote.example.com (443)
  v
Nginx(证书/TLS/鉴权/限流)
  |
  v
Guacamole(HTML5 远程门户)
  | SSH              | VNC
  v                  v
Linux 主机 (tmux)     Linux 主机 (VNC 桌面会话)
```

### 1.2 端口策略（稳健且易运维）

- 公网暴露：**443/tcp**
- 可选：`51820/udp`（WireGuard VPN）
- 尽量不直接暴露到公网：`22`（SSH）、`590x`（VNC）

## 2. CLI 交互：tmux + systemd（断线不掉 + 重启自启）

下面以 Ubuntu/Debian 为例（CentOS/RHEL 思路一样）。

### 2.1 创建运行用户与安装依赖

```bash
sudo useradd -m -s /bin/bash appuser
sudo apt-get update
sudo apt-get install -y tmux
sudo mkdir -p /opt/myapp
sudo chown -R appuser:appuser /opt/myapp
```

把你的应用启动命令封装成脚本：`/opt/myapp/run.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

# 示例：替换成你的实际启动命令
cd /opt/myapp
./myapp
```

```bash
sudo chmod +x /opt/myapp/run.sh
sudo chown appuser:appuser /opt/myapp/run.sh
```

### 2.2 用 systemd 让 tmux 会话“永远在”

创建：`/etc/systemd/system/myapp-tmux.service`

```ini
[Unit]
Description=MyApp in tmux (interactive + persistent)
After=network.target

[Service]
Type=forking
User=appuser
WorkingDirectory=/opt/myapp
Restart=always
RestartSec=3

# 关键：在 tmux 会话里启动应用；断线不会杀进程
ExecStart=/usr/bin/tmux new-session -d -s myapp '/opt/myapp/run.sh'
ExecStop=/usr/bin/tmux kill-session -t myapp

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now myapp-tmux.service
```

### 2.3 手机/电脑连上后的交互方式

- SSH 登录后执行：

```bash
tmux attach -t myapp
```

- 常用操作（默认前缀 `Ctrl+b`）：
  - `Ctrl+b` + `d`：断开（应用继续跑）
  - `Ctrl+b` + `[`：滚屏看历史输出（手机很实用）
  - `Ctrl+b` + `c`：新窗口

### 2.4（可选）为手机体验优化 tmux

写入 `~/.tmux.conf`（appuser）：

```conf
set -g mouse on
set -g history-limit 200000
setw -g mode-keys vi
```

## 3. 手机 Web 入口（推荐）：Guacamole（SSH/VNC 一个门户）

### 3.1 为什么推荐 Guacamole

- 手机浏览器直接用：不装客户端也能 SSH/VNC
- 多用户、多连接管理：适合团队或多环境
- 和 Nginx/HTTPS/VPN 组合很自然：可以做到公网只开 443

### 3.2 Docker Compose（示例，PostgreSQL）

> 说明：这是“可落地的模板”。你可以把门户放在一台网关机上（推荐），再连内网的 SSH/VNC 主机。

`docker-compose.yml` 示例（按需改密码/卷路径）：

```yaml
services:
  guacd:
    image: guacamole/guacd:latest
    restart: unless-stopped

  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_DB: guacamole_db
      POSTGRES_USER: guacamole
      POSTGRES_PASSWORD: change_me
    volumes:
      - ./data/postgres:/var/lib/postgresql/data

  guacamole:
    image: guacamole/guacamole:latest
    restart: unless-stopped
    depends_on:
      - guacd
      - postgres
    environment:
      GUACD_HOSTNAME: guacd
      POSTGRES_HOSTNAME: postgres
      POSTGRES_DATABASE: guacamole_db
      POSTGRES_USER: guacamole
      POSTGRES_PASSWORD: change_me
    ports:
      - "127.0.0.1:8080:8080"
```

Guacamole 第一次需要初始化数据库 schema（示意步骤）：

```bash
# 生成 initdb.sql
docker run --rm guacamole/guacamole:latest /opt/guacamole/bin/initdb.sh --postgres > initdb.sql

# 导入到 postgres 容器
docker exec -i <postgres_container_name> psql -U guacamole -d guacamole_db < initdb.sql
```

然后用 Nginx 反代 `127.0.0.1:8080` 并加 HTTPS（见第 6 节）。

### 3.3 Guacamole 里怎么配连接

- SSH：指向你的应用主机，登录后手动 `tmux attach -t myapp`
- VNC：指向 VNC 桌面主机（见第 5 节）

> 建议：把“应用跑在哪里”和“门户放在哪里”分离。门户可单独加固、做审计、做账号权限。

## 4. 轻量 Web 终端（不用门户）：ttyd + tmux（一个链接直达终端）

适合：单机/少用户/只要 Web 终端，不需要复杂权限体系。

### 4.1 核心思路

- 应用一直跑在 `tmux` 会话里（第 2 节已经保证保活）
- `ttyd` 把 `tmux attach` 变成网页终端
- Nginx 提供 HTTPS + 鉴权 + 只对外暴露 443

### 4.2 ttyd systemd 服务示例

创建：`/etc/systemd/system/ttyd-myapp.service`

```ini
[Unit]
Description=ttyd for tmux session (myapp)
After=network.target myapp-tmux.service

[Service]
User=appuser
Restart=always
RestartSec=3

# -p: ttyd 监听端口
# 这里先用 ttyd 自带 basic auth；也可以只让它监听 127.0.0.1，然后把鉴权交给 Nginx
ExecStart=/usr/bin/ttyd -p 7681 -c appuser:change_me tmux attach -t myapp

[Install]
WantedBy=multi-user.target
```

> 注意：不同发行版 ttyd 安装方式不同；你也可以直接用容器跑 ttyd。

## 5. GUI 交互：TigerVNC + Xfce（桌面会话持续存在）

当你的应用必须 GUI（例如需要真实桌面环境）时，用 VNC/RDP 这类“会话型远程桌面”最稳。

### 5.1 安装桌面与 VNC（Ubuntu/Debian）

```bash
sudo apt-get update
sudo apt-get install -y tigervnc-standalone-server xfce4 xfce4-goodies
```

给运行用户（例如 `appuser`）设置 VNC 密码：

```bash
sudo -u appuser vncpasswd
```

创建 `~/.vnc/xstartup`：

```bash
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
startxfce4 &
```

```bash
sudo -u appuser chmod +x /home/appuser/.vnc/xstartup
```

启动一个固定 display（示例 `:1` -> `5901`）：

```bash
sudo -u appuser vncserver :1 -geometry 1280x720 -depth 24
```

### 5.2 把 VNC 做成 systemd 自启（建议）

创建：`/etc/systemd/system/vncserver@.service`

```ini
[Unit]
Description=TigerVNC Server (%i)
After=network.target

[Service]
Type=forking
User=appuser
PAMName=login
PIDFile=/home/appuser/.vnc/%H:%i.pid

ExecStartPre=-/usr/bin/vncserver -kill :%i
ExecStart=/usr/bin/vncserver :%i -geometry 1280x720 -depth 24
ExecStop=/usr/bin/vncserver -kill :%i

Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用 `:1`：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vncserver@1.service
```

### 5.3 手机怎么连 GUI

- 手机 App：VNC 客户端直连（更灵活，但建议只在 VPN/内网用）
- 手机 Web：用 Guacamole 配 VNC 连接（推荐，统一入口）

> 安全提醒：**不要把 5901 直接暴露公网**。VNC 协议本身不适合裸奔公网。

## 6. Nginx（HTTPS + WebSocket）反代示例

### 6.1 反代 Guacamole（/guac）

```nginx
server {
    listen 443 ssl;
    server_name remote.example.com;

    ssl_certificate     /etc/letsencrypt/live/remote.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/remote.example.com/privkey.pem;

    # 基础鉴权（可替换 OAuth2/SSO）
    auth_basic "Restricted";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location /guac/ {
        proxy_pass http://127.0.0.1:8080/guacamole/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 1d;
    }
}
```

### 6.2 反代 ttyd（/term）与 noVNC（/vnc）（可选）

```nginx
location /term/ {
    proxy_pass http://127.0.0.1:7681/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1d;
}
```

## 7. 安全与稳健性清单（建议照做）

- 公网只开 `443`（可选 `51820` VPN），其余端口走内网/VPN
- SSH：只允许密钥登录；禁用密码；限制来源 IP；必要时加 fail2ban
- Nginx：HTTPS + 强鉴权（至少 Basic Auth；更推荐 SSO/OAuth2）
- 系统：关闭休眠；保证时钟正确；定期更新安全补丁
- 备份：Guacamole 数据库/卷、Nginx 配置、systemd 单元文件
- 可观测：`journalctl -u myapp-tmux.service -f`，必要时把关键日志落盘并轮转

## 8. 最小落地步骤（按顺序）

1) 先把“应用持续存在”做稳：按第 2 节上 `tmux + systemd`
2) 再决定入口：
   - 单人：SSH App 直连，或第 4 节 ttyd 一个链接
   - 多人/多机：第 3 节 Guacamole + 第 6 节 Nginx(HTTPS)
3) 最后做加固：只暴露 443 +（可选）WireGuard + 限制 SSH/VNC/RDP 端口

