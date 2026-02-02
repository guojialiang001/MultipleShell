# Windows Server 纯浏览器访问 RemoteApp（官方）：RDS + RD Web Client（HTML5）

## 0. 你将获得什么体验

- 手机/电脑浏览器打开 `https://<域名>/RDWeb/webclient/`
- 登录后看到 RemoteApp 列表，点击即可在浏览器里直接运行应用窗口（不需要安装 Remote Desktop 客户端）
- 断线后应用是否继续运行，取决于 RDS 会话是否被“注销/超时策略”结束（断开 ≠ 注销）

> 区分：  
> - `https://<域名>/RDWeb/Feed/webfeed.aspx` 是给 Remote Desktop 客户端“订阅 Workspace/Feed”的，不是浏览器远程入口。  
> - RD Web Client 才是浏览器里直接跑 RemoteApp 的入口（HTML5）。

## 1. 推荐拓扑（公网只暴露 443）

```text
手机浏览器
  |
  | https://remote.example.com (443)
  v
RD Web Access + RD Web Client（同站点）
  |
  v
RD Gateway（同域名证书/TLS）
  |
  v
RD Session Host（RemoteApp：发布指定应用）
```

端口策略：

- 对公网：仅 `443/tcp`
- 内网：RDS 组件之间按需开放；不要把 `3389` 直接暴露公网

## 2. 前置条件（重要）

- Windows Server 已部署 RDS（Session-based deployment）
  - 至少包含：RD Session Host、RD Web Access、RD Gateway（以及 Connection Broker / Licensing，按规模选择）
- 必须加入 AD 域（RDS 在 Server Manager 里的“快速启动/标准部署”要求服务器加入域；工作组环境无法完成 RDS 部署，也就无法启用 RD Web Client）
- 已有对外域名与证书（RD Web / RD Gateway 需要受信任证书，否则浏览器/移动端体验很差）
- 已规划授权：RDS CAL（Per User/Per Device）

> 如果你当前是工作组（未入域）：优先改用 `GUACAMOLE_REMOTEAPP_WINDOWS_ZH.md`（纯浏览器、对工作组更友好），或先搭建/加入 AD 域后再继续本方案。

## 3. RDS 侧：只发布应用（RemoteApp），不发布桌面

1) Server Manager -> Remote Desktop Services -> Collections  
2) 进入 Collection -> `RemoteApp Programs` -> Publish RemoteApp Programs  
3) 只发布你需要的 exe；避免发布 Explorer（防止“绕出”成桌面）

会话保活建议（避免断线后会话被系统结束）：

- `gpedit.msc`
  - 计算机配置 -> 管理模板 -> Windows 组件 -> 远程桌面服务 -> 远程桌面会话主机 -> 会话时间限制
    - “设置断开会话的时间限制”：禁用（或设很长）
    - “达到时间限制时结束会话”：禁用

## 4. 启用 RD Web Client（HTML5）

RD Web Client 通常安装在 **RD Web Access 服务器** 上，通过 PowerShell 模块管理。

> 说明：下面命令在不同 Windows Server 版本/补丁状态下可能略有差异；按你机器上的实际提示调整即可。若服务器不能直连外网，可离线下载模块与包再拷贝上去。

在 RD Web Access 服务器上用“管理员 PowerShell”执行（示例）：

```powershell
# 1) 安装管理模块（需要访问 PowerShell Gallery 时才会成功）
Install-Module -Name RDWebClientManagement -Force
Import-Module RDWebClientManagement

# 2) 安装并发布 Web Client（生产环境发布）
Install-RDWebClientPackage
Publish-RDWebClientPackage -Type Production -Latest

# 3) 查看状态
Get-RDWebClientPackage
```

安装完成后，入口通常是：

```text
https://<域名>/RDWeb/webclient/
```

## 5. 浏览器端访问与“接近一键”

### 5.1 访问方式

- 打开 `https://<域名>/RDWeb/webclient/`
- 登录后点 RemoteApp 图标启动

### 5.2 “一键直达某个应用”说明

- RD Web Client 的常见形态是：**先登录 -> 再点应用**（官方入口默认是“应用列表页”）
- 如果你的硬性要求是“一个链接直接进某个应用、尽量少交互”，更容易做到的是 `Nginx + Guacamole + RDP RemoteApp` 的 `#/client/<连接ID>` 直达方式（见 `GUACAMOLE_REMOTEAPP_WINDOWS_ZH.md`）

## 6. 安全建议（强烈推荐）

- 公网只开 `443`；不要把 `3389` 直接暴露到公网
- RD Gateway 必配受信任证书（与 `remote.example.com` 匹配）
- 强密码/账号锁定策略；尽量不用管理员账号日常登录
- 如需更强入口控制：在 RD Web 前面加一层反代（WAF/限流/SSO），或直接走 VPN

## 7. 常见问题排查

- 浏览器打不开 / 证书报错：检查 RD Web / RD Gateway 证书是否正确、链是否完整、域名是否匹配
- 登录后启动失败：检查 RD Gateway 策略（CAP/RAP）、用户是否有 RemoteApp 权限、RDS 授权是否到期
- 断线后应用没了：检查会话时间限制策略，确认是“断开”而不是“注销”
