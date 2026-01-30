# Guacamole（纯浏览器直达应用）落地待办清单（工作组/无 AD 域也可用）

面向目标：用户打开一个浏览器链接，直接进入某个应用窗口（尽量“应用级”，不是完整桌面）。

参考文档：`GUACAMOLE_REMOTEAPP_WINDOWS_ZH.md`

---

## A. 选部署位置（先定这个）

- [ ] 决定 Guacamole/Nginx 跑在哪：
  - [ ] 方案 1：单独 Linux 网关机/云服务器（推荐，最省心）
  - [ ] 方案 2：同一台 Windows Server 上（需要 Docker/WSL2 或原生 Tomcat+guacd，维护更复杂）
- [ ] 明确公网入口是否仍用 `remote.toproject.cloud`（DNS 是否需要改指向网关机）

## B. HTTPS（公网受信任证书）

- [x] `remote.toproject.cloud` 证书已通过 win-acme 签发并安装到 Windows 证书库（当前证书在 `Cert:\LocalMachine\My`）
- [ ] 决定证书在哪里终止 TLS：
  - [ ] 若 Nginx/网关机提供 443：在网关机上用 ACME（certbot/lego/…）重新签发（最简单）
  - [ ] 若仍由 Windows 提供 443：导出证书并供反代/网关使用（例如导出 PFX/转换 PEM）
- [ ] 配置 HTTP(80) -> HTTPS(443) 跳转（强烈建议）

## C. Guacamole 部署

- [ ] 部署 guacd + guacamole-client（建议 Docker + PostgreSQL/MySQL）
- [ ] 确认 Guacamole Web 可访问（内网即可），并完成管理员账号加固（改默认密码/禁用默认账号等）
- [ ] 备份策略：数据库卷/配置目录

## D. Windows Server（被控端）准备

- [ ] 启用 RDP + NLA
- [ ] 确保 Linux(Guacamole) 能访问到本机 `3389/tcp`（同内网/VPN/或公网但强限制来源 IP）
- [ ] 防火墙：`3389` 不对公网开放给所有人；只允许来自 Guacamole 网关机（固定公网 IP 或 VPN 网段）
- [ ] 创建专用账号（最小权限）用于远程运行应用（建议不要用 Administrator）
- [ ] 会话保活策略（避免断线后会话被结束）
  - [ ] “设置断开会话的时间限制”：禁用或设置很长
  - [ ] “达到时间限制时结束会话”：禁用

## E. 做到“应用级”（二选一，推荐先做 2）

1) 远程协议层 RemoteApp（尝试）
   - [ ] 先用 `mstsc` 验证 RemoteApp 可用（成功标准：只弹应用窗口，不进入完整桌面）
     - [ ] `remoteapplicationprogram:s:||notepad`（已验证 OK 的基准用例）
     - [ ] 你的目标应用（若失败，转方案 2 或先做“应用壳”）
   - [ ] 若 RemoteApp 启动失败/断开：在被控 Windows（RDP 服务端）执行 `.\scripts\win-remoteapp-ensure.ps1` 先把 `user-mapping.xml` 里的 `remote-app` 别名注册到服务端
   - [ ] 在 Guacamole 的 RDP 连接里配置 `remote-app`（例如 `||notepad`）
   - [ ] 验证是否只显示应用窗口（若退化为完整桌面，改用方案 2）

2) 账号/系统层“应用壳”（更稳）
   - [ ] 为专用账号配置“登录后只启动指定应用”（例如启动脚本/替换 shell/开机自启）
   - [ ] 禁止用户轻易“绕出应用”（可选：AppLocker/禁用任务管理器/限制控制面板等）
   - [ ] 验证：通过 RDP 进入后只看到应用窗口/应用界面（即使底层是桌面会话）

## F. “直达链接”与鉴权

- [ ] 在 Guacamole 创建一个“应用连接”（每个应用一个连接更好做授权）
- [ ] （可选）生成直达链接/获取 `<连接ID>`（浏览器地址栏 `#/client/<连接ID>`）：见 `GUACAMOLE_REMOTEAPP_MULTIPLESHELL_ZH_TODO.md`
- [ ] 决定鉴权方式（越“免登”越要靠网络隔离/SSO）：
  - [ ] Guacamole 自带登录（最简单）
  - [ ] Nginx BasicAuth/OIDC + Guacamole header-auth（更像“一键”）
  - [ ] no-auth（只用于 VPN/白名单内网）

## G. 验收（手机优先）

- [ ] 手机浏览器打开直达链接可用（输入/剪贴板/分辨率体验可接受）
- [ ] 断网/切后台后可重新打开链接继续（会话未被结束）
- [ ] 并发/弱网基本可用

## H. MultipleShell 客户端入口（可选）

- 应用端相关待办已拆分到：`GUACAMOLE_REMOTEAPP_MULTIPLESHELL_ZH_TODO.md`
