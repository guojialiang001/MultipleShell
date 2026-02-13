# 最近项目（Recent Projects）方案

## 目标（业务价值）

MultipleShell 的核心业务动作是「选模板 + 选工作目录（repo）→ 开一个新会话」。当用户每天反复在少量仓库之间切换时，**每次都选目录**会成为明显的摩擦点。

“最近项目”要解决的就是：

- 降低重复选择目录的成本：一键填充/一键启动常用仓库
- 让“新建会话”更快：把“目录选择”从文件系统浏览变成 MRU（最近使用）列表
- 为后续“项目级能力”（收藏/标签/快捷命令/项目模板绑定）打基础

非目标（本期不做）：

- 不做复杂的项目索引/全文搜索（仅 MRU + 轻量搜索）
- 不做跨机器同步（仅同机多实例 Host/Client 同步）

## 用户故事

1. 我经常在 3~10 个 repo 来回切，想在新建 tab 时直接点一下 repo 名就开了。
2. 我希望常用 repo 能置顶（pin），不被“最近列表”冲走。
3. 我希望能快速复制路径/在资源管理器打开该项目。
4. 我希望多实例（Host/Client）时最近项目一致（和 sessions 列表同步体验一致）。

## 交互与 UI 设计

### 入口 1：新建 Tab（ConfigSelector / create 模式）

放置位置：在 `ConfigSelector.vue` 的工作目录输入框（`customWorkingDir`）附近，新增一个「最近项目」区域。

建议 UI 结构：

- 「最近项目」标题 + 右侧动作：
  - `清空`（二次确认）
  - `管理…`（可后置到第二期；第一期可不做）
- 搜索框（可选，第一期可用输入框过滤）
- 列表分组：
  - 置顶（Pinned）
  - 最近（MRU）
- 每项展示：
  - 项目名：默认取最后一级目录名（`basename(path)`）
  - 次信息：`repoRoot`（若检测到 git root）/ 完整路径（可折叠显示）
  - 最近使用时间：如“3 分钟前 / 昨天 / 2026-02-06”
  - 可选：徽标（Git / Non-git）
- 每项操作（右键菜单或悬浮按钮）：
  - `使用此目录`（填充到 workingDir 输入框）
  - `固定/取消固定`
  - `在资源管理器打开`
  - `复制路径`
  - `从列表移除`

“一键启动”快捷（建议第二期）：

- 在列表项右侧加一个 `▶`：用当前已选模板直接创建会话（等价于点“创建”但不需要手动再点一次）。

### 入口 2：菜单/快捷（可后置）

- MenuBar 加一个「最近项目」下拉（或 Command Palette：`Ctrl+P`）。
- 主要面向“我不想先打开新建 tab 弹窗再找目录”的用户路径。

## 数据模型与排序策略

### RecentProject（建议字段）

```jsonc
{
  "id": "sha1(canonicalPath)",        // 稳定 ID（用于 pin、删除）
  "path": "D:\\repo\\foo",            // 原始路径（尽量保留原大小写）
  "canonicalPath": "d:\\repo\\foo",   // 规范化路径（用于去重/比较）
  "displayName": "foo",               // UI 展示名（默认 basename）
  "repoRootPath": "D:\\repo\\foo",    // 可选：git root（用于合并子目录）
  "repoName": "foo",                  // 可选：repo 根目录名
  "pinned": false,
  "useCount": 12,
  "createdAt": "2026-02-06T03:00:00.000Z",
  "lastUsedAt": "2026-02-06T03:40:00.000Z",
  "lastTemplateId": "uuid-of-template" // 可选：后续“默认模板”联动
}
```

### Store 文件格式

```jsonc
{
  "version": 1,
  "updatedAt": "ISO",
  "projects": [RecentProject, ...]
}
```

### 排序策略（简单且可解释）

1. `pinned=true` 永远排在前面
2. 其余按 `lastUsedAt` 倒序
3. 同一项目去重规则：
   - 优先使用 `repoRootPath` 去重（若检测到 git root，则将 repo 内任意子目录都归并到 repo root）
   - 否则用 `canonicalPath` 去重

容量策略：

- `maxProjects` 默认 50（可配置），超过后从末尾淘汰（但不淘汰 pinned）

## 路径规范化与项目识别

### 规范化（Windows 优先）

- `normalize + resolve`，去掉末尾分隔符，统一分隔符为 `\`
- `canonicalPath` 用于比较/去重：建议 `toLowerCase()`（Windows 文件系统一般大小写不敏感）
- UNC 路径（`\\\\server\\share\\repo`）允许但需要额外校验存在性与长度

### 安全与过滤（业务规则）

“最近项目”是业务层能力，但必须遵守现有“工作目录安全”约束：

- 复用主进程的 `FORBIDDEN_PATHS`（例如 `C:\\Windows\\System32` 等）
- `touch` 时必须检查：
  - 目录存在且是目录
  - 不在禁止目录前缀下

### Git Root 检测（增强体验）

目的：把“项目”定义为 repo，而不是某个子目录。

实现建议（主进程）：

- 从 `path` 向上最多查 N 层（如 12），遇到：
  - `/.git` 目录或文件（submodule 情况可能是 file）
  - 则认为该层为 `repoRootPath`
- 若未找到则 `repoRootPath = null`
- 建议做缓存（LRU 100 项）避免频繁磁盘 IO

## 持久化与多实例同步（Host/Client）

### 存储位置

- 存储在主进程 `app.getPath('userData')` 下，例如：`recent-projects.v1.enc`
- 加密：使用 Electron `safeStorage`（与 configs/drafts 同一安全基线）

### Host/Client 同步

原则：**所有状态写入由 Host 负责**，Client 只读/发请求（与现有 sessions/configs 行为一致）。

- Host：
  - 维护 RecentProjectsManager（内存 + 加密落盘）
  - 每次变更广播：`agent.broadcast('recentProjects.changed', { projects })`
- Client：
  - `ipcRenderer.invoke('recentProjects:list')` 实际走 `agent.call('recentProjects.list', {})`
  - 监听 `recentProjects.changed` 通知更新 UI

## IPC / API 设计（建议）

### Preload 暴露

在 `src/preload/index.js` 中新增：

- `recentProjectsList()`
- `recentProjectsTouch(path, { templateId? })`
- `recentProjectsPin(id, pinned)`
- `recentProjectsRemove(id)`
- `recentProjectsClear()`
- `recentProjectsOpenInExplorer(id)`（或传 path）
- `onRecentProjectsChanged(callback)`（订阅广播）

### 主进程 IPC（Host 执行）

在 `src/main/index.js` 注册 handler（并在 agent request handler 里接入同名方法）：

- `recentProjects:list`
- `recentProjects:touch`
- `recentProjects:pin`
- `recentProjects:remove`
- `recentProjects:clear`
- `recentProjects:openInExplorer`

触发时机（业务钩子）：

- 成功创建 session 后：以最终 `workingDir` 为准 `touch`
- 用户通过“选择文件夹”对话框选择目录后：`touch`
- 若用户手动输入路径：建议仅在创建成功后 `touch`（避免把无效路径写入列表）

## 验收标准（可测试）

1. 新建 tab 时能看到最近项目列表；点击某项会填充工作目录输入框。
2. 创建会话成功后，该目录出现在列表顶部（或 pinned 区不变）。
3. pinned 项不会被容量淘汰；清空会清除非 pinned（或提供“清空全部”二选一）。
4. 同机多实例（Host/Client）最近项目列表保持一致更新。
5. 被禁止的系统目录不会进入最近项目列表。

## 开发拆分（推荐里程碑）

### M1（1~2 天）：最小可用

- 主进程 RecentProjectsManager：`list/touch` + 加密落盘
- renderer：ConfigSelector 展示列表 + 点击填充

### M2（1~2 天）：可用性增强

- `pin/remove/clear/openInExplorer/copyPath`
- UI 过滤（输入框搜索）
- Host/Client 广播订阅

### M3（可选）：体验升级

- Git root 检测与合并
- “一键启动”（列表项直接创建会话）
- 绑定 `lastTemplateId`（项目默认模板）

