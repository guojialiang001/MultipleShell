#!/bin/bash

# Guacamole 自定义主题部署脚本

set -e

echo "🎨 部署 Guacamole 自定义主题..."

# 创建目标目录
CUSTOM_DIR="/var/www/guacamole-custom"
sudo mkdir -p "$CUSTOM_DIR"

# 复制自定义文件
echo "📁 复制自定义文件..."
sudo cp extensions/custom-theme/guacamole.css "$CUSTOM_DIR/custom.css"
sudo cp extensions/custom-theme/custom.js "$CUSTOM_DIR/custom.js"

# 设置权限
echo "🔐 设置文件权限..."
sudo chown -R www-data:www-data "$CUSTOM_DIR"
sudo chmod -R 755 "$CUSTOM_DIR"

# 重新加载 Nginx
echo "🔄 重新加载 Nginx..."
sudo nginx -t && sudo systemctl reload nginx

echo ""
echo "✅ 自定义主题部署完成！"
echo ""
echo "访问: https://remote.toproject.cloud/guacamole/"
echo ""
echo "自定义功能："
echo "  - 🎨 全新的渐变主题"
echo "  - 📝 连接图标自动识别"
echo "  - ⌨️  键盘快捷键支持"
echo "  - 🔔 连接状态通知"
echo "  - ✨ 流畅的动画效果"
echo ""
echo "键盘快捷键："
echo "  Ctrl + H - 返回首页"
echo "  Ctrl + D - 断开连接"
echo "  Esc - 显示/隐藏菜单"
echo ""
