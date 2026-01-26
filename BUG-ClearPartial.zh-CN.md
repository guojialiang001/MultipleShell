# BUG：PowerShell `clear/cls` 只能清空一部分（看起来“没有全清”）

## 现象

在应用内终端运行 PowerShell 的 `clear`/`cls` 后，屏幕没有像预期那样“全清空”，仍然会留下部分历史内容/空白区域，看起来像只清空了一部分。

## 复现步骤

1. 打开任意终端标签页。
2. 输出较多内容（例如执行几次 `dir` / `Get-ChildItem` / `ping` 等）。
3. 运行 `clear`（或 `cls`）。
4. 观察屏幕是否仍残留历史内容/空白占位，感觉不像“全清”。

## 根因

- PowerShell 的 `Clear-Host`（`clear/cls`）通常只输出 `CSI 2J`（清空 viewport），并不总是输出 `CSI 3J`（清空 scrollback）；在不同 host/环境下也可能用“打印大量空行”的方式把旧内容顶走。
- 本项目对 pty 输出做了缓存/分批写入（为了解决选区丢失等问题）。当 `clear` 发生时，如果之前的输出还在本地 pending buffer 里，可能会在清屏后继续被写入，从而让清屏看起来“只清了一部分”。
- 另外，不能简单用 `terminal.reset()` 去“硬清屏”，否则会破坏 `claude` 等全屏 TUI 的重绘逻辑。

## 修复

为避免误伤 `claude` 等 TUI（它们会频繁清屏重绘），不再基于“输出里出现清屏控制序列”来强行 `terminal.clear()`。

改为在用户输入侧做兜底：

- 在 normal buffer 下，监听用户按回车时的命令行内容；
- 若命令为 `clear`/`cls`/`clear-host`，则在本地直接执行一次 `terminal.clear()`，并丢弃 pending output；
- 若此时 xterm 仍有一个分块 write 在处理中，则把清屏动作延后到该 write 完成后执行，保证最终效果是“全清”。

## 代码位置

- `src/renderer/components/Terminal.vue`
