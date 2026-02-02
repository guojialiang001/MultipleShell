# Shell Scrollbar: 处理说明

## 问题现象
SHELL 内部终端区域没有可见滚动条，导致无法直观拖动滚动位置。

## 主要原因
- xterm 的滚动条所在元素是 `.xterm-viewport`，全局样式或容器 `overflow: hidden` 可能遮挡或隐藏滚动条。
- 部分系统使用 overlay scrollbar，仅在滚动时显示，默认看起来像“没有滚动条”。

## 输出导致不出现滚动条的常见原因
- 输出使用回车 `\r` 覆盖同一行（进度条/刷新行），没有新增行，scrollback 不增长。
- 脚本触发清屏：`clear`/`cls`/`ESC[2J`/`ESC[3J` 或 `reset`，会清空或重置滚动区。
- 程序进入 alternate screen（全屏 TUI），输出不进入普通 scrollback。
- scrollback 设置过小或被硬清空逻辑触发，滚动范围被压缩。
- 输出被重绘控件消费（如 curses/tmux），导致视觉上不产生“滚动”。

## 滚动条不滚动/旧内容回溯不上去的原因
- 持续输出会自动把视图拉回底部，拖动滚动条后会被新输出拉回去，看起来像不滚动。
- scrollback 上限被快速占满，旧行被淘汰，无法回溯到更早内容（当前上限为 1000）。
- 应用内清屏逻辑触发（`clear`/`cls`、Ctrl+K、`terminal.clear()`/`terminal.reset()`）会重置缓冲区。
- 全屏 TUI 使用 alternate screen 时，普通 scrollback 暂停或不可用，滚动条不会变化。

## 为什么有的输出会增加滚动条
只要输出产生新行并累积到 viewport 之外，scrollback 就会增长，滚动条自然出现并可拖动。

## 调整建议
- 需要保留滚动记录时，确保输出包含换行 `\n`，避免只用 `\r` 更新同一行。
- 避免在脚本中频繁 `clear`/`cls` 或发送 `ESC[2J`/`ESC[3J`。
- 使用全屏程序时，退出后才会恢复普通 scrollback。
- 视情况提高 `scrollback` 配置（当前为 1000）。
- 确保 `.xterm-viewport` 具备 `overflow-y: auto` 且未被外层 `overflow: hidden` 覆盖。

## 处理方式
在 `Terminal.vue` 中对 xterm DOM 做定向样式覆盖，强制显示滚动条并设置可见样式：

- 让 `.xterm` 充满容器高度
- 对 `.xterm-viewport` 设置 `overflow-y: auto`
- 针对 WebKit 和 Firefox 设置滚动条样式

## 涉及文件
- `src/renderer/components/Terminal.vue`


