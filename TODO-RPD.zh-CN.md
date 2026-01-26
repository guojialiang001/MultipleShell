# RPD 对照代办：多套 Profiles + 本地加密存储

对照文档：`RPD.zh-CN.md`

结论：RPD 中的核心功能（Profiles 的增删改、`userData/configs.v1.enc` 加密落盘、旧版 `configs/*.json` 迁移、损坏自动恢复+备份、IPC 接口）在当前代码中已基本具备；以下为仍需确认/补齐的代办与风险项。

## P0（需确认/补齐，直接影响 RPD 口径）

- [x] 明确并统一 `startupScript` 的语义：已改为“PowerShell 命令/脚本文本，逐行执行”；如需运行文件可填写 `& '.\\setup.ps1'`（`src/main/pty-manager.js`、`src/renderer/components/ConfigEditor.vue`）。
- [x] `safeStorage.isEncryptionAvailable()` 为 false 时的用户体验：增加弹窗提示并降级为“仅内存模式”（`src/main/config-manager.js`）。
- [ ] 迁移边界条件验收：首次运行导入 `configs/*.json` 的路径覆盖在打包形态下是否符合预期（`src/main/config-manager.js` 的 `loadLegacyConfigs()`）；建议在打包产物中做一次实际验证。

## P1（建议增强，用于更稳的验收/可维护性）

- [x] 增加最小化的“验收自检清单/脚本”：覆盖新增/编辑/删除 Profiles、重复名称不互相影响（按 `id` 删除）、落盘文件为 base64 密文、损坏文件自动备份并重建默认 store。
- [x] 为“损坏恢复/迁移/加密不可用”等关键路径增加日志（或在 UI 给出提示），便于排查真实用户环境问题。

## 发现的潜在缺陷（非 RPD 条目，但可能影响配置管理）

- [x] `src/renderer/App.vue` 中 `currentTabConfig` 绑定使用了 `tabs.value...` 的模板表达式；在 Vue 模板中通常应直接使用 `tabs...`（ref 自动解包），否则可能导致运行时异常，进而影响打开配置管理弹窗的稳定性。
