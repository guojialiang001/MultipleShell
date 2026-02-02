# Windows 纯浏览器一键直达 RemoteApp（应用级，不是桌面）：Nginx + Guacamole + RDP RemoteApp

## 0. 你将获得什么体验

- 手机浏览器打开一个链接（例如 `https://remote.example.com/#/client/c/<连接ID>`）
- 直接进入某个应用窗口（RemoteApp），而不是完整 Windows 桌面
- 断线后进程不退出（只要会话没被策略/管理员结束），重新打开链接可继续

> 说明：  
> - `RDWeb/Feed/webfeed.aspx` 是给 **Remote Desktop 客户端**订阅 Workspace 的，不是浏览器远程入口。  
> - “浏览器远程”必须依赖 Guacamole（或 RD Web Client 之类）在浏览器里实现 RDP 客户端能力。

## 1. 推荐拓扑（公网只暴露 443）

```text
手机浏览器
  |
  | https://remote.example.com (443)
  v
Nginx(HTTPS/鉴权/限流)
  |
  v
Guacamole(HTML5 远程门户)
  |
  | RDP(RemoteApp)
  v
Windows Server / RD Session Host（只启动指定应用）
```

端口策略：

- 对公网：仅 `443/tcp`
- 内网：Guacamole -> Windows Server：`3389/tcp`（只允许来自 Guacamole 网关）

## 2. Windows Server 侧准备（被控端）

### 2.1 开启 RDP + NLA

- 启用远程桌面（RDP）
- 建议开启 NLA（网络级别身份验证）
- 建议用专用账号（最小权限），避免用 Administrator

### 2.2 确保“断线不断进程”

关键点：**只断开，不注销**。并检查/调整会话时间限制：

- `gpedit.msc`
  - 计算机配置 -> 管理模板 -> Windows 组件 -> 远程桌面服务 -> 远程桌面会话主机 -> 会话时间限制
    - “设置断开会话的时间限制”：禁用（或设很长）
    - “达到时间限制时结束会话”：禁用

### 2.3 RemoteApp 能否真正“只显示应用窗口”

Guacamole 的 RDP RemoteApp 依赖服务端对 RemoteApp 的支持。

- 推荐：Windows Server 上用 RDS 正式发布 RemoteApp（RD Session Host 的 RemoteApp Programs/集合发布）
- 现象判断：
  - 配置生效：连接后只看到应用窗口（周围可能是空白画布），无任务栏/开始菜单
  - 配置未生效：连接后变成完整桌面或直接报错断开

### 2.4 按 user-mapping.xml 注册 RemoteApp（确保 `||notepad` 可启动）

如果你使用本仓库的 `user-mapping.xml`（例如 `<param name="remote-app">||notepad</param>`），但连接后 RemoteApp 启动失败/直接断开，通常是**服务端没有注册该 RemoteApp 别名**。

在被控 Windows（RDP 服务端）用“管理员 PowerShell”执行：

```powershell
cd C:\project\MultipleShell

# AllowRdpFrom 建议填 Guacamole 网关机的内网 IP / VPN 网段；不确定先填 Any 做通，再收紧
.\scripts\win-remoteapp-ensure.ps1 -UserMappingPath .\user-mapping.xml -AllowRdpFrom Any -RestartTermService
```

自定义 RemoteApp（你在 `user-mapping.xml` 里写 `||yourapp`）时，需要提供别名到 exe 的映射：

```json
{
  "yourapp": "C:\\Program Files\\YourApp\\YourApp.exe"
}
```

然后执行：

```powershell
.\scripts\win-remoteapp-ensure.ps1 -UserMappingPath .\user-mapping.xml -AppMapJsonPath .\app-map.json -RestartTermService
```

验证（先用 mstsc，成功标准：只弹应用窗口，不进完整桌面）：

- `remoteapplicationprogram:s:||notepad`

## 3. 部署 Guacamole（建议放 Linux 网关机/云服务器）

> Guacamole 最常见部署方式是 Docker；下例用 PostgreSQL。你也可以用 MySQL。

### 3.1 docker-compose（示例）

创建 `docker-compose.yml`（示例）：

```yaml
services:
  guacd:
    image: guacamole/guacd
    restart: unless-stopped

  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_DB: guacamole
      POSTGRES_USER: guacamole
      POSTGRES_PASSWORD: change_me
    volumes:
      - ./data/postgres:/var/lib/postgresql/data

  guacamole:
    image: guacamole/guacamole
    restart: unless-stopped
    depends_on:
      - guacd
      - postgres
    environment:
      GUACD_HOSTNAME: guacd
      POSTGRES_HOSTNAME: postgres
      POSTGRES_DATABASE: guacamole
      POSTGRES_USER: guacamole
      POSTGRES_PASSWORD: change_me
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ./guacamole/extensions:/etc/guacamole/extensions
      - ./guacamole/guacamole-home:/etc/guacamole
```

数据库初始化（示意）：

- 生成初始化 SQL（按 guacamole 镜像提供的 initdb 脚本/说明执行）
- 将 SQL 导入 postgres 容器

> 你也可以先用默认的 `guacadmin/guacadmin` 登录，然后立刻改密码、关掉默认账号或换成更强鉴权。

### 3.2 不用 Docker 可以吗（可以，原生部署思路）

可以。Guacamole 本质是两部分：

- `guacd`（guacamole-server，C 语言守护进程）
- `guacamole.war`（guacamole-client，Java Web 应用，跑在 Tomcat/Jetty 上）

推荐做法：在一台 Linux 机器上原生安装（Windows Server 上“原生装 guacd + Tomcat”可行但维护成本高，一般不建议）。

原生部署的最小步骤（概念流程）：

1) 安装并启动 `guacd`
   - 用发行版包安装（版本可能偏旧）或从源码编译安装（更常见）
   - 配 `systemd` 服务，确保开机自启
2) 安装 Java + Tomcat，并部署 `guacamole.war`
   - 把 `guacamole.war` 放到 Tomcat 的 `webapps/`，重启 Tomcat
3) 配置 `GUACAMOLE_HOME`（通常 `/etc/guacamole`）
   - `guacamole.properties`：指定 `guacd` 地址、认证方式（数据库/LDAP/…）
4) 继续用第 4 节 Nginx 反代对外提供 `https://remote.example.com/`

> 你如果“不想用 Docker”的原因是想少一层组件，并且你本来就跑在 Windows Server + RDS 上：也可以直接走官方 `RD Web Client`（纯浏览器），完全不需要 Guacamole。

## 4. Nginx 反向代理（把 Guacamole 映射到域名根路径）

目标：让最终链接形态保持简单：`https://remote.example.com/#/client/c/<连接ID>`

关键点：

- 反代要支持 WebSocket（Guacamole 用于隧道通信）
- 建议配置较长的 `proxy_read_timeout`
- 建议在 Nginx 层完成 HTTPS 与鉴权（公网入口）

示例（仅展示关键项，证书路径按你的环境填写）：

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl;
  server_name remote.example.com;

  ssl_certificate     /etc/letsencrypt/live/remote.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/remote.example.com/privkey.pem;

  # 可选：最简鉴权（生产更推荐上 SSO/OIDC）
  # auth_basic "Restricted";
  # auth_basic_user_file /etc/nginx/.htpasswd;

  location / {
    # guacamole/guacamole 默认路径是 /guacamole/，这里用反代把它“挂到根路径”
    proxy_pass http://127.0.0.1:8080/guacamole/;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 1d;
  }
}
```

## 5. 在 Guacamole 里创建“应用级（RemoteApp）”连接

Guacamole 管理界面 -> Connections -> New Connection：

- Protocol：RDP
- Network：
  - Hostname：Windows Server（建议内网 IP/域名）
  - Port：3389
- Authentication：
  - Username / Password（域账号或本地账号）
  - Security mode：NLA（建议）
- RemoteApp：
  - 开启 RemoteApp 并填写程序标识
  - 常见示例：`||notepad`、`||calc`

验证：

- 先在 Guacamole 里点连接测试一次
- 预期：只看到应用窗口，不是完整桌面

## 6. 生成“直达链接”（浏览器打开即连接）

1) 在 Guacamole 里进入一次该连接
2) 看地址栏，通常会是：`#/client/c/<连接ID>`
3) 直达链接就是：

`https://remote.example.com/#/client/c/<连接ID>`

> `<连接ID>` 在你不删除/重建连接的情况下通常稳定；删除重建会变。

## 7. “真正一键”（尽量不让用户再登录）

如果只用 Guacamole 默认登录，你的“直达链接”仍会先到登录页；要做到更接近“一键”，常见两条路：

1) 内网/受控网络：VPN/IP 白名单 + Guacamole no-auth  
2) 公网：Nginx 负责登录（SSO/OIDC/BasicAuth） + Guacamole header-auth（由网关透传用户身份）

> 安全提醒：免登方案务必配合 VPN/白名单/SSO，不要让“免登直达链接”裸奔公网。

## 8. 常见问题排查

- 打开后出现完整桌面：RemoteApp 参数未生效；优先用 RDS 正式发布 RemoteApp，再让 Guacamole 连接到 RD Session Host。
- 连接立即断开：账号权限、NLA/加密模式不匹配、服务端策略限制、或 RemoteApp 目标不可启动。
- 手机浏览器卡后台后断开：属于正常现象；关键是服务端会话别被策略结束，重新打开链接即可继续。

## 9. MultipleShell 作为入口（可选）

如果你希望把 “Guacamole 入口 / RemoteApp / VNC” 收敛到一个桌面客户端入口，可以用 MultipleShell 的 **远程** 模式：

- 设置 -> 远程访问：填写 `入口 URL（Guacamole）` + `RemoteApp/VNC 连接名`
- 需要时可打开/关闭：`启用 RemoteApp 快捷入口`（RemoteApp 访问开关）
- 远程模式里提供：打开入口 / 打开 RemoteApp / 打开 VNC 三个按钮（使用系统默认浏览器打开）
