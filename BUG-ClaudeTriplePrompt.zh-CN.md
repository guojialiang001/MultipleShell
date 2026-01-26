# BUG：运行 claude 时出现“多个输入框/多行重复提示”

## 现象

在终端里运行 `claude`（交互式 TUI）后，界面出现多个 `>` 输入框/多行重复的 `? for shortcuts`，看起来像 UI 被重复绘制/叠加。

## 复现步骤

1. 打开任意终端标签页。
2. 运行 `claude`。
3. 观察界面是否出现多行 `>  ? for shortcuts`（类似“多个输入框”）。

## 根因

终端组件曾尝试“识别清屏序列”：

- 检测到 `ESC[2J` / `ESC[3J` / `ESC c` 等控制序列时，会调用 `terminal.reset()`（hard clear）。

但 `claude` 这类 TUI 会频繁用 `ESC[2J` 清屏来重绘界面；我们把正常的“清屏”误当成“需要 hard reset 的重置”，导致 xterm 状态被反复 `reset()`，从而引发 UI 绘制异常，表现为多个输入框/重复提示。

## 修复

- 移除对 `ESC[2J` / `ESC[3J` / `ESC c` 的“硬重置”拦截逻辑。
- 让这些控制序列作为普通输出进入 xterm，由 xterm 自身按协议处理（清屏/重绘）。

## 代码位置

- `src/renderer/components/Terminal.vue`

