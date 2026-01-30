# Guacamole 自定义主题

这个自定义主题为 Guacamole 远程访问界面提供了现代化的外观和增强的用户体验。

## 功能特性

### 🎨 视觉改进
- **渐变背景** - 紫蓝色渐变主题
- **毛玻璃效果** - 半透明背景和模糊效果
- **圆角设计** - 现代化的圆角按钮和卡片
- **流畅动画** - 悬停和点击动画效果
- **自定义滚动条** - 美化的滚动条样式

### 🖼️ 连接图标
自动为不同类型的连接添加图标：
- 📝 Notepad (记事本)
- 🔢 Calculator (计算器)
- 🎨 Paint (画图)
- 💻 SSH
- 🖱️ VNC
- 🖥️ 其他 RDP 连接

### ⌨️ 键盘快捷键
- `Ctrl + H` - 返回首页
- `Ctrl + D` - 断开当前连接
- `Esc` - 显示/隐藏菜单
- `Ctrl + Alt + Shift` - Guacamole 原生菜单

### 🔔 用户体验增强
- 连接状态通知
- 加载动画
- 悬停效果
- 响应式设计

## 部署方法

### 方法 1: 使用部署脚本（推荐）

在服务器上运行：

```bash
cd /path/to/MultipleShell
chmod +x scripts/deploy-guacamole-theme.sh
./scripts/deploy-guacamole-theme.sh
```

### 方法 2: 手动部署

1. **创建目录**
```bash
sudo mkdir -p /var/www/guacamole-custom
```

2. **复制文件**
```bash
sudo cp extensions/custom-theme/guacamole.css /var/www/guacamole-custom/custom.css
sudo cp extensions/custom-theme/custom.js /var/www/guacamole-custom/custom.js
```

3. **设置权限**
```bash
sudo chown -R www-data:www-data /var/www/guacamole-custom
sudo chmod -R 755 /var/www/guacamole-custom
```

4. **更新 Nginx 配置**

确保 `nginx.conf` 中包含以下配置：

```nginx
# 自定义静态资源
location /guacamole-custom/ {
    alias /var/www/guacamole-custom/;
    expires 1d;
    add_header Cache-Control "public, must-revalidate";
}

# 在 /guacamole/ location 中添加
location /guacamole/ {
    # ... 其他配置 ...

    # 注入自定义 CSS/JS
    sub_filter '</head>' '<link rel="stylesheet" href="/guacamole-custom/custom.css"><script src="/guacamole-custom/custom.js"></script></head>';
    sub_filter_once on;
    sub_filter_types text/html;
}
```

5. **重新加载 Nginx**
```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 自定义配置

### 修改颜色主题

编辑 `extensions/custom-theme/guacamole.css`：

```css
/* 修改主色调 */
body {
    background: linear-gradient(135deg, #YOUR_COLOR_1 0%, #YOUR_COLOR_2 100%) !important;
}

/* 修改按钮颜色 */
.button, button {
    background: linear-gradient(135deg, #YOUR_COLOR_1 0%, #YOUR_COLOR_2 100%) !important;
}
```

### 添加自定义 Logo

在 CSS 中修改：

```css
.menu {
    background-image: url('YOUR_LOGO_URL') !important;
    background-size: 32px 32px !important;
}
```

### 自定义欢迎消息

编辑 `extensions/custom-theme/custom.js` 中的 `addWelcomeMessage()` 函数。

## 文件结构

```
extensions/custom-theme/
├── guacamole.css      # 自定义 CSS 样式
├── custom.js          # 自定义 JavaScript 功能
└── README.md          # 本文档

scripts/
└── deploy-guacamole-theme.sh  # 部署脚本
```

## 浏览器兼容性

- ✅ Chrome/Edge (推荐)
- ✅ Firefox
- ✅ Safari
- ⚠️ IE11 (部分功能不支持)

## 故障排除

### 样式未生效

1. **清除浏览器缓存**
   - Chrome: `Ctrl + Shift + Delete`
   - Firefox: `Ctrl + Shift + Delete`

2. **检查文件权限**
```bash
ls -la /var/www/guacamole-custom/
```

3. **检查 Nginx 配置**
```bash
sudo nginx -t
```

4. **查看 Nginx 日志**
```bash
sudo tail -f /var/log/nginx/remote.error.log
```

### JavaScript 功能不工作

1. **打开浏览器开发者工具** (`F12`)
2. **查看 Console 标签页**
3. **检查是否有错误信息**

### sub_filter 不工作

确保 Nginx 编译时包含了 `http_sub_module`：

```bash
nginx -V 2>&1 | grep -o with-http_sub_module
```

如果没有，需要重新编译 Nginx 或使用其他方法注入 CSS/JS。

## 高级定制

### 使用 Guacamole 扩展 JAR

如果需要更深度的定制，可以创建 Guacamole 扩展 JAR：

1. 创建 Maven 项目
2. 实现 `GuacamoleExtension` 接口
3. 编译为 JAR 文件
4. 放置到 `extensions/` 目录
5. 重启 Guacamole 容器

参考：[Guacamole Extension Development](https://guacamole.apache.org/doc/gug/custom-extensions.html)

## 更新主题

修改 CSS/JS 文件后，重新运行部署脚本：

```bash
./scripts/deploy-guacamole-theme.sh
```

或手动复制文件并重新加载 Nginx。

## 卸载主题

```bash
# 删除自定义文件
sudo rm -rf /var/www/guacamole-custom

# 从 nginx.conf 中移除 sub_filter 配置
# 重新加载 Nginx
sudo systemctl reload nginx
```

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License
