# BUG：终端内粘贴后出现“双光标/残影光标”

## 现象

在终端里运行交互式程序（例如 `claude`），在其输入区粘贴一段文本后，界面上会出现两个光标（看起来像一个主光标 + 一个残影光标），影响输入体验。

## 复现步骤

1. 打开任意终端标签页。
2. 运行一个交互式 TUI/Prompt 程序（例如 `claude`）。
3. 在其输入区触发粘贴（常见为右键粘贴/自定义右键菜单粘贴）。
4. 观察是否出现双光标/光标残影。

## 根因（推测）

之前的“右键粘贴”实现是直接把剪贴板内容通过 `writeToTerminal` 写入 pty，绕过了 xterm 的 `paste(...)` 输入管线。

部分交互式程序依赖终端的“粘贴语义”（例如 bracketed paste 序列、输入节流/回显逻辑等）。当绕过 xterm 的 paste 逻辑，程序可能进入异常状态，从而出现光标绘制异常（双光标/残影）。

## 修复

右键“粘贴”改为：

- 仍然通过 Electron 主进程 `clipboard` 读取剪贴板（避免 `navigator.clipboard` 的延迟/权限问题）。
- 读取到文本后，调用 `terminal.paste(text)`，让 xterm 走标准粘贴流程（包括 bracketed paste），再由 `terminal.onData` 把输入发送到 pty。

## 代码位置

- `src/renderer/components/Terminal.vue`
- `src/preload/index.js`
- `src/main/index.js`

