# RPD: 多套配置(Profiles) + 本地加密存储

## 1. 背景与问题

当前应用将配置模板存放在项目目录 `configs/*.json`：

- 打包后该目录可能处于只读(asar/resources)，写入不可靠
- 配置为明文 JSON，不满足“应用级别文件加密存储”的要求
- 以文件名派生身份，难以支持同一工具(如 Codex)的多套“增强/变体”配置，并且删除/重命名容易冲突

## 2. 目标

- 支持“无限添加”的配置模板(Profiles)，可为同一工具创建多套配置
  - 例如：`Codex - Default` / `Codex - Enhanced` / `Codex - Project A`
- 配置文件存储在应用级别目录(每用户)，本地落盘但加密存储
- 保持现有工作流不变：选择某个 Profile -> 启动一个独立 PowerShell 会话(Tab)

## 3. 非目标(本期不做)

- 多设备同步/云同步
- 团队共享配置、权限系统
- 配置继承/层级合并(可后续扩展)

## 4. 用户故事

- 作为用户，我可以新增/编辑/删除任意数量的 Profiles
- 作为用户，我可以为 Codex 维护多套配置并快速切换使用
- 作为用户，我希望配置只存在本机，并且磁盘上是加密文件
- 作为用户，如果配置文件损坏，应用可以自动恢复到默认配置(并保留损坏备份便于排查)

## 5. 数据模型

### 5.1 Profile(配置模板)

字段：

- `id: string` 全局唯一(主键；用于更新/删除/作为 UI key)
- `name: string` 展示名(允许重复，但建议用更明确的命名)
- `workingDirectory: string`
- `envVars: Record<string, string>`
- `startupScript: string`
- `createdAt: string (ISO)`
- `updatedAt: string (ISO)`

### 5.2 Store(存储文件)

单文件结构：

```json
{
  "version": 1,
  "updatedAt": "2026-01-24T00:00:00.000Z",
  "configs": [ /* Profile[] */ ]
}
```

## 6. 本地加密存储设计

### 6.1 存储位置

- 使用 Electron `app.getPath('userData')`
- 文件名固定：`configs.v1.enc`

### 6.2 加密方案

- 使用 Electron `safeStorage.encryptString/decryptString`
- 落盘内容为加密 Buffer 的 base64 字符串(不是可读 JSON)
- 写入采用临时文件 + rename，避免半写入造成的损坏

### 6.3 兼容与迁移

- 若加密存储不存在：尝试导入旧版 `configs/*.json` 作为初始 Profiles
- 若导入失败或为空：创建默认 3 套：`Claude Code` / `Codex` / `OpenCode`

### 6.4 损坏处理

- 解密/JSON 解析失败：将原文件重命名为 `configs.v1.enc.corrupt.<timestamp>.bak`
- 自动重建默认 store，保证应用可继续使用

## 7. 接口(IPC)

- `get-configs` -> `Profile[]`
- `save-config(Profile)` -> Upsert(按 `id` 更新；无 `id` 则创建)
- `delete-config(configId: string)` -> 按 id 删除

## 8. UI/交互

- “管理配置模板”：列表展示 Profiles，可新增/编辑/删除
- “新建终端”：选择任一 Profile 启动会话
- 编辑器字段：
  - 工作目录选择
  - 启动脚本
  - 环境变量：按行 `KEY=VALUE`

## 9. 验收标准

- 可新增/编辑/删除任意数量 Profiles，列表刷新正确
- 删除按 `id` 生效(同名配置不会互相误删)
- 配置落盘于 `userData/configs.v1.enc` 且为加密内容(非明文 JSON)
- 旧版 `configs/*.json` 可在首次运行时自动导入
- 配置文件损坏时应用可自动恢复并生成备份文件
