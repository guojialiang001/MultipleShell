# MultipleShell

一个面向本地开发/调试场景的多终端管理器。你可以通过“配置”快速启动不同类型的终端会话，并在一个窗口内集中管理。

## 功能亮点

- 多标签终端：一个窗口内管理多个会话。
- 三类内置配置：Claude Code / Codex / OpenCode。
- 配置管理：新建、编辑、删除配置；删除会弹窗确认。
- 可选工作目录：创建终端时选择当前目录。
- 语音输入：一键录音并把识别结果发送到终端。
- 安全存储：配置存入系统安全存储（依赖 Electron safeStorage/系统密钥服务）。

## 快速开始

### 环境要求

- Node.js 22.12+（建议使用与依赖一致的版本）
- npm
- Windows：若安装 `node-pty` 失败，需要安装 Visual Studio Build Tools + Python（node-gyp 依赖）

### 安装依赖

```bash
npm install
```

### 启动开发环境

```bash
npm run dev
```

### 打包（Windows）

```bash
npm run build:win
```

其他打包命令见 `package.json` 的 scripts（如 `build` / `build:win:x64` / `build:win:ia32`）。

## 使用指南

### 新建终端

1. 点击“新建标签”或按 `Ctrl+T`。
2. 选择一个“配置”。
3. 如需指定工作目录，点击“浏览”选择。
4. 点击“创建终端”。

### 管理配置

在“选择配置”页点击“管理配置”：

- 新建配置：创建 Claude Code / Codex / OpenCode 配置之一。
- 编辑配置：修改名称或配置内容。
- 删除配置：会弹出确认窗口。

### 语音输入

底部语音栏可开始/停止录音，识别结果会写入当前终端。

> 注意：首次使用会请求麦克风权限。

### 常用快捷键

- `Ctrl+T`：新建标签
- `Ctrl+W`：关闭当前标签

## 配置类型说明

应用内仅支持三种配置类型：

### Claude Code

编辑 `settings.json` 内容（JSON）。常见字段示例：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your_token",
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic"
  }
}
```

### Codex

需要填写两份内容：

- `config.toml`
- `auth.json`

这两份文件会按配置隔离存放在用户目录中，并在启动时同步。

### OpenCode

编辑 `opencode.json` 内容（JSON），应用会提供默认模板。

## 数据与安全

配置会写入用户目录，并使用 Electron safeStorage 加密存储；加密依赖系统密钥服务（Windows DPAPI / macOS Keychain / Linux libsecret）。如果系统不支持安全存储，应用会提示并退出。

## 常见问题

### 依赖安装失败（node-gyp/node-pty）

这是本地 C++ 编译依赖缺失导致的，建议安装：

- Visual Studio Build Tools
- Python 3.x

安装完成后重新执行 `npm install`。

## 目录结构（简要）

```
src/
  main/        # Electron 主进程
  preload/     # 预加载脚本
  renderer/    # 前端界面（Vue）
```

## 反馈与贡献

欢迎提交 Issue 或 Pull Request。建议在提交前说明复现步骤/预期结果，便于定位问题。
