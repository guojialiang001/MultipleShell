# BUG：终端内鼠标选中文本松开后选区消失

## 现象

在应用内的终端（xterm.js）里用鼠标拖拽选中文本，松开鼠标后，选区会立刻消失（看起来像“没有选中”）。

## 复现步骤

1. 打开任意一个终端标签页。
2. 运行会持续输出的命令（例如 PowerShell：`ping -t 127.0.0.1`）。
3. 用鼠标拖拽选中一段文本。
4. 松开鼠标，观察选区是否还能保持。

## 期望行为

松开鼠标后选区保持不变，直到用户主动取消（例如点击空白处/按 Esc/复制后清除等）。

## 根因

终端持续收到来自 pty 的输出并调用 `terminal.write()` 更新缓冲区；xterm.js 在缓冲区变化时可能会清除/刷新选区。

项目里原本只在 `terminal.hasSelection()` 为 `true` 时暂停写入，但在“拖拽选择”的过程中（以及鼠标松开前后极短的时间窗口内）选区状态可能尚未稳定为 `true`，导致输出仍被写入，从而把刚完成的选区清掉。

## 修复

在终端组件中引入“选区守卫”：

- 鼠标左键按下到松开期间，视为正在选择，暂停向 xterm 写入（只缓存输出）。
- `mousedown` 需要用 capture phase 监听（`addEventListener('mousedown', ..., true)`），避免被 xterm 内部 `stopPropagation()` 吃掉导致守卫不生效。
- 鼠标松开后增加更长的 settle window，等待 xterm 完成选区落地，避免立刻写入导致选区被清。
- 选区清除后立即 flush 缓存的输出。
- 使用 `window` 级 `mouseup` 监听，避免鼠标在组件外松开时状态卡住。

## 更新（第二次修复尝试）

第一次实现里在 `mouseup` 后会在很短时间内（例如 20ms 检测不到选区时）提前解除守卫并 flush 缓存输出；在持续输出场景下，这个窗口仍可能抢在 xterm “落地选区”之前写入，从而把选区清掉。

调整为：

- `mouseup` 后无论是否立刻检测到选区，都保持守卫一段时间（settle window）。
- flush 改为“等守卫到期后再尝试”（而不是在 `mouseup` 的短延时里决定立即 flush）。
- 收到清屏/重置序列（例如 `ESC[2J` / `ESC[3J` / `ESC c`）时，如果正在选区守卫期内则延后执行 hard clear，避免直接清掉选区。

## 更新（第三次修复尝试）

实测仍会出现“拖拽时有选区高亮，但松开后瞬间消失”。进一步怀疑点不只是“是否还在继续调用 `terminal.write()`”，而是 xterm 的 `write` 本身是异步、内部有 write queue：即使我们在 `mousedown` 后停止继续写入，之前已经提交给 xterm 的大块 payload 仍可能在后续若干帧继续被消费并改动缓冲区，从而在 `mouseup` 附近打断/清掉刚落地的选区。

调整为：

- 不再把 `pendingChunks.join('')` 一次性写入；改为按固定小块（chunk）分批 `terminal.write(chunk, callback)` 逐步 drain。
- 任何时刻只允许一个 write 在飞行中（`writeInProgress`）；每块写完再调度下一块。
- 一旦进入选区守卫（拖拽/鼠标松开 settle window/已有选区），立即停止继续 drain，尽可能快速让 xterm write queue “空闲”下来，避免影响选区落地。
- 如果仍然出现 `mouseup` 后选区被瞬间清空，则在 `mouseup` 后短延迟内尝试用 `terminal.getSelectionPosition()` 记录的 range 进行一次 `terminal.select(...)` 还原（仅限本次拖拽刚产生的选区、且时间窗口很短，避免误还原）。

注意：

- 之前曾尝试“识别清屏/重置序列（例如 `ESC[2J` / `ESC[3J` / `ESC c`）并执行 `terminal.reset()`”来避免清掉选区，但这会破坏 `claude` 等 TUI（它们会频繁清屏重绘），因此该拦截已移除，改为让 xterm 按协议正常处理这些控制序列。

## 代码位置

- `src/renderer/components/Terminal.vue`
