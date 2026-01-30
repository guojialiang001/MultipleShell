// Guacamole 自定义 JavaScript

(function() {
    'use strict';

    // 等待页面加载完成
    window.addEventListener('DOMContentLoaded', function() {
        console.log('🚀 Guacamole Custom Theme Loaded');

        // 添加自定义欢迎消息
        setTimeout(function() {
            addWelcomeMessage();
            customizeConnectionList();
            addKeyboardShortcuts();
            improveUserExperience();
        }, 1000);
    });

    // 添加欢迎消息
    function addWelcomeMessage() {
        const menu = document.querySelector('.menu');
        if (menu && !document.querySelector('.custom-welcome')) {
            const welcome = document.createElement('div');
            welcome.className = 'custom-welcome';
            welcome.innerHTML = '<span style="color: #667eea; font-weight: 600;">🖥️ Remote Access Portal</span>';
            welcome.style.cssText = 'padding: 8px 16px; font-size: 14px;';
            menu.appendChild(welcome);
        }
    }

    // 自定义连接列表
    function customizeConnectionList() {
        const connections = document.querySelectorAll('.connection');
        connections.forEach(function(conn) {
            // 添加图标
            const name = conn.textContent;
            let icon = '🖥️';

            if (name.includes('Notepad') || name.includes('记事本')) {
                icon = '📝';
            } else if (name.includes('Calculator') || name.includes('计算器')) {
                icon = '🔢';
            } else if (name.includes('Paint') || name.includes('画图')) {
                icon = '🎨';
            } else if (name.includes('SSH')) {
                icon = '💻';
            } else if (name.includes('VNC')) {
                icon = '🖱️';
            }

            if (!conn.querySelector('.custom-icon')) {
                const iconSpan = document.createElement('span');
                iconSpan.className = 'custom-icon';
                iconSpan.textContent = icon + ' ';
                iconSpan.style.cssText = 'font-size: 20px; margin-right: 8px;';
                conn.insertBefore(iconSpan, conn.firstChild);
            }
        });
    }

    // 添加键盘快捷键
    function addKeyboardShortcuts() {
        document.addEventListener('keydown', function(e) {
            // Ctrl + H: 返回首页
            if (e.ctrlKey && e.key === 'h') {
                e.preventDefault();
                window.location.hash = '#/';
            }

            // Ctrl + D: 断开连接
            if (e.ctrlKey && e.key === 'd') {
                e.preventDefault();
                const disconnectBtn = document.querySelector('[title*="Disconnect"]');
                if (disconnectBtn) disconnectBtn.click();
            }

            // Esc: 显示/隐藏菜单
            if (e.key === 'Escape') {
                const menuToggle = document.querySelector('.menu-toggle');
                if (menuToggle) menuToggle.click();
            }
        });
    }

    // 改善用户体验
    function improveUserExperience() {
        // 添加加载动画
        const style = document.createElement('style');
        style.textContent = `
            .loading-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 9999;
                backdrop-filter: blur(5px);
            }

            .loading-spinner {
                width: 50px;
                height: 50px;
                border: 4px solid rgba(255, 255, 255, 0.3);
                border-top-color: #667eea;
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }

            @keyframes spin {
                to { transform: rotate(360deg); }
            }

            .custom-notification {
                position: fixed;
                top: 20px;
                right: 20px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 16px 24px;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
                z-index: 10000;
                animation: slideIn 0.3s ease;
            }

            @keyframes slideIn {
                from {
                    transform: translateX(400px);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }

            .connection {
                transition: all 0.3s ease !important;
            }

            .connection:hover {
                transform: translateX(8px) scale(1.02) !important;
                box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3) !important;
            }
        `;
        document.head.appendChild(style);

        // 监听连接状态
        observeConnectionStatus();
    }

    // 监听连接状态
    function observeConnectionStatus() {
        const observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(mutation) {
                if (mutation.addedNodes.length) {
                    mutation.addedNodes.forEach(function(node) {
                        if (node.classList && node.classList.contains('client')) {
                            showNotification('🚀 正在连接...', 2000);
                        }
                    });
                }
            });
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // 显示通知
    function showNotification(message, duration) {
        const notification = document.createElement('div');
        notification.className = 'custom-notification';
        notification.textContent = message;
        document.body.appendChild(notification);

        setTimeout(function() {
            notification.style.animation = 'slideIn 0.3s ease reverse';
            setTimeout(function() {
                notification.remove();
            }, 300);
        }, duration || 3000);
    }

    // 添加全局快捷键提示
    function showShortcutHelp() {
        const help = `
            <div style="background: rgba(0,0,0,0.9); color: white; padding: 20px; border-radius: 8px; max-width: 400px;">
                <h3 style="margin-top: 0;">⌨️ 键盘快捷键</h3>
                <ul style="list-style: none; padding: 0;">
                    <li>Ctrl + H - 返回首页</li>
                    <li>Ctrl + D - 断开连接</li>
                    <li>Esc - 显示/隐藏菜单</li>
                    <li>Ctrl + Alt + Shift - 显示 Guacamole 菜单</li>
                </ul>
            </div>
        `;
        return help;
    }

    // 导出到全局
    window.GuacamoleCustom = {
        showNotification: showNotification,
        showShortcutHelp: showShortcutHelp
    };

})();
