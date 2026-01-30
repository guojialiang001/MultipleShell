# RD Web Client（Windows Server / RDS / HTML5）落地待办清单

面向目标：用户通过浏览器访问 `https://remote.toproject.cloud/RDWeb/webclient/`，登录后直接运行 RemoteApp（不安装客户端）。

参考文档：`RD_WEB_CLIENT_WINDOWS_ZH.md`

---

> 重要：RD Web Client（官方 HTML5）通常要求先完成 RDS 部署，而 RDS “快速启动/标准部署”要求服务器加入 AD 域。  
> 如果你决定不入域，请改走：`GUACAMOLE_REMOTEAPP_WINDOWS_ZH.md` + `GUACAMOLE_REMOTEAPP_WINDOWS_ZH_TODO.md`。

## A. 规划与前置

- [x] 确认 Windows Server 版本/补丁级别（已确认：Windows Server 2022 Datacenter 21H2）
- [ ] 确认网络形态：公网访问 / 内网访问 / VPN 访问（决定暴露面与鉴权策略）
- [x] 域名 `remote.toproject.cloud` 已完成 DNS 解析到入口 IP（当前 `http://remote.toproject.cloud/` 可访问）
- [x] 申请并安装公网受信任证书到证书存储（Let’s Encrypt / win-acme，证书已进入 `Cert:\LocalMachine\My`）
- [ ] 将 `remote.toproject.cloud` 证书绑定到 RDS 角色（RD Web Access + RD Gateway）
- [ ] 验证 `https://remote.toproject.cloud/` / `https://remote.toproject.cloud/RDWeb/` 使用新证书且链正确
- [ ] 配置 HTTP(80) -> HTTPS(443) 跳转（可选但强烈建议）
- [ ] 规划账号体系：AD 域账号（推荐）/ 本地账号（不推荐长期使用）
- [ ] 规划授权：RDS CAL（Per User / Per Device）与授权服务器

## B. RDS 基础部署（Session-based）

- [ ] 部署/确认 AD 域（必须；工作组环境无法完成 RDS 快速启动/标准部署 -> 无法启用 RD Web Client）
- [ ] 安装并配置 RDS 角色（按规模选同机或分离）
- [ ] 角色最小集合（常见）：
  - [ ] RD Session Host
  - [ ] RD Web Access
  - [ ] RD Gateway
  - [ ] RD Connection Broker（通常需要）
  - [ ] RD Licensing
- [ ] 配置 RDS 部署属性与证书（Deployment Properties -> Certificates）
- [ ] 配置 RD Gateway（CAP/RAP），确保只走 443（不直开 3389 到公网）
- [ ] 防火墙规则：
  - [ ] 公网入口只开放 `443/tcp`
  - [ ] `3389/tcp` 仅内网/管理网段可达（或仅允许 Gateway/内部组件访问）

## C. RemoteApp 发布与会话策略

- [ ] 创建/检查 Session Collection
- [ ] 发布 RemoteApp（只发布需要的应用，不发布 Explorer）
- [ ] 配置 RemoteApp 用户授权（哪些用户/组可以看到/启动）
- [ ] 配置会话时间限制策略（避免断开后自动结束会话）
  - [ ] “设置断开会话的时间限制”：禁用或设置很长
  - [ ] “达到时间限制时结束会话”：禁用
- [ ] 规划应用“自启动/后台守护”需求（若需要持续运行，明确是“会话内保持”还是“服务化运行”）

## D. RD Web Client（HTML5）安装与发布

- [ ] 确认 RD Web Access 服务器可访问 PowerShell Gallery（若不行，准备离线安装方案）
- [ ] 在 RD Web Access 上安装管理模块：`RDWebClientManagement`
- [ ] 安装 RD Web Client 包：`Install-RDWebClientPackage`
- [ ] 发布到生产：`Publish-RDWebClientPackage -Type Production -Latest`
- [ ] 验证入口可访问：`https://remote.toproject.cloud/RDWeb/webclient/`

## E. 安全加固（建议至少做这些）

- [ ] 强密码 + 账号锁定策略 + 最小权限账号（避免管理员账号日常使用）
- [ ] 仅允许 NLA（RDP 侧）
- [ ] RD Web / RD Gateway 证书链完整（避免移动端/浏览器证书错误）
- [ ] 入口防护（二选一或组合）：
  - [ ] VPN（推荐用于高安全场景）
  - [ ] WAF/反代限流（如 IIS/Nginx/云 WAF）
  - [ ] 源 IP 白名单（管理入口/后台组件）
- [ ] 审计与告警：登录失败、异常来源、账户锁定事件

## F. 验收测试（手机优先）

- [ ] 手机浏览器访问 `https://remote.toproject.cloud/RDWeb/webclient/` 可以正常登录
- [ ] RemoteApp 列表显示正确（权限隔离正确）
- [ ] 远程启动 RemoteApp 成功（窗口可交互、输入法/剪贴板按预期）
- [ ] 断网/切后台后重新打开仍可恢复（或按你的策略重新连入同会话）
- [ ] 并发测试（按预期用户数）
- [ ] 弱网测试（4G/5G 网络下延迟与可用性）

## G. 运维与备份

- [ ] 记录关键配置与拓扑（证书、网关策略、集合、发布的应用列表）
- [ ] 证书续期流程与到期告警
- [ ] RDS 授权到期/宽限期风险检查
- [ ] 系统补丁窗口与回滚策略
- [ ] 日志收集：IIS/RD Gateway/RDS 事件日志（必要时集中到日志平台）
