# MultipleShell（应用端）Guacamole RemoteApp/VNC 设置待办清单

面向目标：在 MultipleShell 客户端里配置 Guacamole 入口 URL + 连接ID，并提供“一键直达链接”入口（RemoteApp/VNC）。

参考文档：

- `GUACAMOLE_REMOTEAPP_WINDOWS_ZH.md`（第 9 节 MultipleShell 作为入口）
- `GUACAMOLE_REMOTEAPP_WINDOWS_ZH_TODO.md`（部署侧待办；本文件仅关注应用端）

---

## A. 设置项（应用端）

- [x] 在 MultipleShell 设置里增加 RemoteApp 快捷入口开关（可随时关闭 RemoteApp 入口）
- [x] 在 MultipleShell 设置里增加 Guacamole 入口 URL + RemoteApp/VNC 连接ID（用于生成直达链接）

## B. 链接生成与入口行为（应用端）

- [x] 生成直达链接：`<入口URL>/#/client/<连接ID>`（对 `<连接ID>` 做 URL 编码）
- [x] 入口 URL 允许带尾部 `/`，生成时自动去掉尾部多余 `/`（避免双斜杠）
- [x] 打开链接时使用系统默认浏览器（Electron `shell.openExternal` / 浏览器 `window.open` 兜底）

## C. 验收（应用端）

- [ ] 入口 URL 为空时：“打开入口”按钮禁用，并提示“请先在设置中配置入口 URL”
- [ ] 入口 URL 为空时：“打开 VNC”按钮禁用，并提示“请先在设置中配置入口 URL”
- [ ] 入口 URL 为空且 RemoteApp 开关开启时：“打开 RemoteApp”按钮禁用，并提示“请先在设置中配置入口 URL”
- [ ] RemoteApp 开关关闭时：“打开 RemoteApp”按钮禁用，并提示“RemoteApp 已在设置中关闭”（与入口 URL 是否配置无关）
- [ ] 入口 URL 已配置但连接ID为空时：对应按钮禁用，并提示“请先填写连接ID”
- [ ] 入口 URL + 连接ID 配置正确时：点击按钮能拉起系统浏览器并直达对应页面

## D. 可选增强（应用端）

- [x] URL 校验：提示非 `https://`、空格、非法字符等
- [x] 增加“复制直达链接”按钮（入口/RemoteApp/VNC 各一个）
- [x] 增加“一键清空远程配置”按钮（避免手动清 localStorage）
