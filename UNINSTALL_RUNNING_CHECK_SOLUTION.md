# Windows(NSIS) 卸载时“正在运行校验 + 取消即退出”稳健方案（MultipleShell）

本文给出一套在 Windows + electron-builder(NSIS) 下可落地、可验证、并且不容易踩坑的卸载方案：

- 卸载开始就校验程序是否仍在运行
- 若在运行：弹窗提示用户关闭
- 用户点“取消”：立即退出卸载（不产生部分卸载）
- 用户关闭后：可“重试/确定”继续卸载

注意：NSIS 的卸载程序（`Uninstall xxx.exe`）是在“安装时”生成/写入安装目录的。所以你改了 `build/installer.nsh` 之后，必须重新打包并重新安装一次，再测试卸载；否则你运行的还是旧卸载程序，行为不会变。

## 目标（验收标准）

- 卸载程序启动后、删除任何文件之前，就能检测到 `${APP_EXECUTABLE_FILENAME}` 是否在运行（包含“以管理员/不同用户启动”的情况）
- 检测到运行时必须弹窗：
  - 明确提示“请先关闭正在运行的软件”
  - 提供“取消”按钮；用户点击“取消”后，卸载直接退出
  - 提供“重试/确定”按钮；用户关闭软件后点击继续
- 不能依赖“当前用户名过滤”的进程检测（否则会漏检：软件以管理员运行、或由其他用户启动）

## 适用工程接入点

本项目使用 `electron-builder` 打包 Windows NSIS：

- 配置入口：`electron-builder.json`
- NSIS 自定义脚本：`build/installer.nsh`（由 `nsis.include` 引入）
- 卸载最早钩子：`!macro customUnInit`（对应 uninstaller 的 `un.onInit`，必须在这里做校验，避免“删了一半才发现占用”导致部分卸载）

## 核心思路（可靠性优先）

1. 在 `customUnInit` 中循环检测进程是否存在（跨用户，不做用户名过滤）。
2. 只要检测到仍在运行，就弹窗提示用户关闭：
   - 交互卸载：用 `MB_RETRYCANCEL`（或 `MB_OKCANCEL`）做“重试/取消”。
   - 用户点取消：`Abort` 立即终止卸载（保证不会进入删除阶段）。
   - 用户点重试：回到检测逻辑，直到进程消失才继续。
3. 可选增强：在用户点击“确定/重试”后，先尝试温和关闭（`taskkill` 不带 `/f`），再等待并复检；仍无法关闭再让用户手动处理并重试/取消。

说明：相比“一检测到运行就直接 Abort”，循环“重试/取消”可以做到“一次卸载流程内完成关闭与继续”，用户体验更好，也更符合你的需求描述。

## 进程检测方式（跨用户/管理员也能检测）

推荐用 `tasklist + find`，并且只按 `IMAGENAME` 精确匹配：

- 找到：`find` 返回 0
- 找不到：`find` 返回非 0

NSIS 中常用写法（不要加 `/FI "USERNAME eq ..."`，否则会漏检）：

```nsh
nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | %SYSTEMROOT%\System32\find.exe /I "${APP_EXECUTABLE_FILENAME}" >nul`
Pop $R0
${if} $R0 == 0
  ; running
${endif}
```

## 可直接使用的卸载宏（推荐落地版本）

把下面这段放到 `build/installer.nsh`，并用它替换/实现 `!macro customUnInit`。

特点：

- 运行中就弹窗
- 支持“重试/取消”
- 取消直接退出卸载（`Abort`）
- 默认不强杀，先让用户自行关闭（更稳、更不容易丢数据）
- 可选：你也可以在注释处开启“自动尝试关闭”

```nsh
!macro customUnInit
  ; 必须在卸载最早阶段做检查，避免部分卸载。

  ; 可选：避免用户无休止点“重试”（你也可以把 3 改大，或去掉这段限制）。
  StrCpy $R9 0

  check_running:
    IntOp $R9 $R9 + 1
    ${If} $R9 > 3
      MessageBox MB_OK|MB_ICONSTOP \
        "多次检测到 ${PRODUCT_NAME} 仍在运行。$\r$\n请先手动关闭后重新运行卸载程序。"
      Abort
    ${EndIf}

    ; 跨用户检测：只按进程名检测，不做 USERNAME 过滤。
    nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | %SYSTEMROOT%\System32\find.exe /I "${APP_EXECUTABLE_FILENAME}" >nul`
    Pop $R0

    ${if} $R0 == 0
      ${If} ${Silent}
        ; 静默卸载无法弹窗：这里建议直接退出卸载，避免删除失败/残留。
        Abort
      ${EndIf}

      ; 方案A（推荐，最稳）：让用户手动关闭，然后点“重试”继续；点“取消”退出卸载。
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
        "${PRODUCT_NAME} 正在运行。\r\n\r\n请先保存工作并完全退出 ${PRODUCT_NAME}（含托盘）。\r\n关闭后点击“重试”继续卸载（$R9/3）；点击“取消”退出卸载。" \
        /SD IDCANCEL IDRETRY check_running
      Abort

      ; 方案B（可选增强）：如果你希望“点确定就尝试自动关闭”，可以改成 MB_OKCANCEL，
      ; 并在 IDOK 分支里执行 taskkill(不带 /f) + 等待复检。
    ${endif}

  ; 通过“未运行”校验后，再做卸载确认（可保留，也可交给 electron-builder 默认逻辑）。
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION "确定要卸载 ${PRODUCT_NAME} 吗？" IDYES proceed
    Abort
    proceed:
  ${EndIf}
!macroend
```

## 可选增强：自动温和关闭（更“自动”，但要注意数据丢失风险）

如果你希望在弹窗里给用户一个“确定=自动关闭并继续”的路径，推荐策略：

1. 先 `taskkill /im xxx.exe /T`（不带 `/f`），让系统发送关闭请求（尽量温和）。
2. `Sleep` 等待 0.5~2s，并循环复检 2~3 次。
3. 仍未关闭：提示用户手动处理（`MB_RETRYCANCEL`），取消则退出卸载。
4. **不建议默认强杀**。如果一定要做强杀，建议再弹一次确认：“仍未关闭，是否强制结束进程继续卸载？”。

项目里现有的 `build/installer.nsh` 已经有一份“温和->强制->失败重试/取消”的实现（`!macro customCheckAppRunning`）；如果你要在卸载里也走同样策略，可以把那段逻辑挪到 `customUnInit` 的 OK 分支中复用。

## 测试清单（必须全过）

1. 正常情况：程序未运行 -> 卸载不弹“运行中”提示，直接进入确认/卸载。
2. 程序运行中（普通权限）：
   - 打开程序 -> 运行卸载 -> 弹窗提示 -> 点击“取消” -> 卸载退出，程序仍在，文件未被删除。
   - 弹窗点击“重试”前先关闭程序 -> 再点“重试” -> 能继续卸载完成。
3. 程序以管理员运行（或其他用户运行）：
   - 仍然能检测到运行并弹窗（这是“跨用户检测”的关键验收点）。
4. 多实例/多进程：程序开多个窗口（多个 `${APP_EXECUTABLE_FILENAME}`） -> 仍能检测到并阻止卸载，直到全部退出。
5. 静默卸载（如 `/S`）：程序运行中 -> 卸载应直接退出/失败，不应进入删除阶段导致“删一半”。

## 常见坑（这类问题以前经常写错的点）

- 一定要在 `customUnInit` 做校验：不要放到删除动作之后，否则容易部分卸载。
- 不要用“按当前用户名过滤”的进程检测：会漏掉管理员/其他用户启动的进程。
- 点击“取消”时要用 `Abort`（发生在 `un.onInit` 阶段）确保卸载流程终止。
- 进程名匹配要用 `IMAGENAME eq xxx.exe` 做精确匹配，避免误命中。
