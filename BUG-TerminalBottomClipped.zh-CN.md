# BUG：终端滚动到底部后仍有内容被“压住/看不到”

## 现象

终端输出到最底部时，滚动条已经到底，但最底部仍有一部分文字被遮挡/看不到，像是被容器底部“压住”。

## 复现步骤

1. 打开任意终端标签页。
2. 输出多行内容（例如 `dir`/`Get-ChildItem` 多次、或 `ping -t` 等）。
3. 滚动到最底部。
4. 观察最后一行/几行是否被裁切，无法完整看到。

## 根因

`FitAddon.fit()` 依据容器尺寸计算 rows/cols。之前终端挂载容器（`terminalRef`）本身带 `padding`，而 fit 计算用的高度包含 padding，导致计算出的 rows 偏大，最终 xterm 视口的最后一行被裁切，表现为“滚动到底也看不到底部”。

## 修复

- 把 padding 从 xterm 的挂载容器上移到外层 wrapper。
- xterm 挂载容器保持无 padding，使 `FitAddon.fit()` 的可用高度与实际渲染区域一致。

## 代码位置

- `src/renderer/components/Terminal.vue`

