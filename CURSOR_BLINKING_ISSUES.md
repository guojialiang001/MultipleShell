# 光标闪烁频率过快处理方案（当前项目）

## 问题描述
- 光标闪烁频率过高，导致视觉疲劳和“闪烁感太强”。
- 当前仅开启 cursorBlink: true，xterm 使用固定频率：
  - Canvas 渲染器：BLINK_INTERVAL = 600ms（内置常量）
  - DOM 渲染器：CSS 动画 1s step-end infinite

## 结论
- xterm 没有公开的“闪烁频率”选项，只有开/关。
- 想要降低频率，需要改动 xterm 内部常量或 DOM 渲染器动画时长。

## 方案 1（推荐）：调整 Canvas 渲染器的 BLINK_INTERVAL
- 适用于默认 Canvas 渲染器，性能最好。
- 修改路径：
  - node_modules/xterm/src/browser/renderer/shared/CursorBlinkStateManager.ts
- 将 const BLINK_INTERVAL = 600; 改成更大的值（例如 900/1200）。
- 建议配合 patch-package 固化修改，避免 npm install 覆盖。

示例：
const BLINK_INTERVAL = 1000; // 1s, 闪烁更慢

## 方案 2（备选）：切换 DOM 渲染器并调整动画时长
- 在 Terminal.vue 的 xterm 初始化中加入：
  - rendererType: 'dom'
- 修改路径：
  - node_modules/xterm/src/browser/renderer/dom/DomRenderer.ts
- 将动画时长从 1s 改为 1.4s / 1.8s 等：
  - animation: ... 1s step-end infinite;

注意：DOM 渲染器性能通常低于 Canvas，建议仅在需要精细控制动画时使用。

## 方案 3（体验优化）：降低“视觉闪烁感”
- 即使频率降低，持续高频输出仍可能让光标看起来“抖动”。
- 可选：对输出写入节流/批处理（已有 enqueueTerminalWrite 逻辑，可进一步增加批量或帧间隔）。

## 新增问题：多个光标框 / 真实光标叠加
- 现象：同一窗口里出现多个光标框，或“方块光标 + 细线光标”同时存在。

## 可能原因
- 多个终端实例仍处于焦点状态（v-show 仅隐藏，但没有 blur）。
- xterm 默认 cursorInactiveStyle: 'outline'，非活动终端仍会显示轮廓框。
- 全局 CSS 覆盖了 xterm 样式，导致隐藏的输入 textarea 变得可见（系统光标出现）。

## 解决方案（按优先级）
1) 只允许活动终端持有焦点
   - 在 Terminal.vue 监听 props.isActive：激活时 terminal.focus()，非激活时 terminal.blur()。
2) 非活动终端不显示光标
   - 初始化时设置 cursorInactiveStyle: 'none'，避免轮廓框残留。
3) 彻底避免多个终端同时存在
   - 在 App.vue 将 v-show 改为 v-if，只挂载当前活动终端。
4) 排查“真实光标”
   - 确保 import 'xterm/css/xterm.css' 生效。
   - 避免全局样式影响 .xterm-helpers 或 .xterm-helper-textarea（例如全局 textarea 样式）。

## 验收标准
- 光标闪烁周期明显变慢（可感知 > 1s）。
- 切换窗口/标签时仍能正常显示光标。
- 在高频输出场景下，光标不再“刺眼”。
- 同一时刻只有一个光标可见，且不会出现额外的“真实光标”。

## 关联文件
- src/renderer/components/Terminal.vue
- src/renderer/App.vue
- node_modules/xterm/src/browser/renderer/shared/CursorBlinkStateManager.ts
- node_modules/xterm/src/browser/renderer/dom/DomRenderer.ts
