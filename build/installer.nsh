!macro customPageAfterChangeDir
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
!macroend

; Uninstall/installer debugging
; Writes verbose diagnostics to a temp log so we can troubleshoot "app running" detection.
; Log file: %TEMP%\\${PRODUCT_FILENAME}-uninstall-debug.log
; Production default: disabled (set MS_ENABLE_DEBUG_LOG=1 to enable).
!ifndef MS_ENABLE_DEBUG_LOG
  !define MS_ENABLE_DEBUG_LOG 0
!endif
!define MS_UNINSTALL_DEBUG_LOG_PATH "$TEMP\\${PRODUCT_FILENAME}-uninstall-debug.log"

!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif

!macro MS_UninstallLog _text
  !if ${MS_ENABLE_DEBUG_LOG}
    DetailPrint "${_text}"
    Push $0
    FileOpen $0 "${MS_UNINSTALL_DEBUG_LOG_PATH}" a
    ; Some environments seem to not honor FileOpen append positioning reliably.
    ; Ensure we always write at end to avoid log corruption.
    FileSeek $0 0 END
    FileWrite $0 "${_text}$\r$\n"
    FileClose $0
    Pop $0
  !endif
!macroend

; Install-time check (same level as uninstall's customUnInit / un.onInit).
; If the app is running, block the installer early to avoid partial installs/updates.
!macro customInit
  !insertmacro MS_UninstallLog ""
  !insertmacro MS_UninstallLog "============================================================"
  !insertmacro MS_UninstallLog "=== customInit (.onInit) ==="
  !insertmacro MS_UninstallLog "log: ${MS_UNINSTALL_DEBUG_LOG_PATH}"
  !insertmacro MS_UninstallLog "PRODUCT_NAME: ${PRODUCT_NAME}"
  !insertmacro MS_UninstallLog "PRODUCT_FILENAME: ${PRODUCT_FILENAME}"
  !insertmacro MS_UninstallLog "APP_EXECUTABLE_FILENAME: ${APP_EXECUTABLE_FILENAME}"
  !insertmacro MS_UninstallLog "INSTDIR: $INSTDIR"
  !insertmacro MS_UninstallLog "EXEDIR: $EXEDIR"
  !insertmacro MS_UninstallLog "CMDLINE: $CMDLINE"
  !insertmacro MS_UninstallLog "SYSDIR: $SYSDIR"

  ReadEnvStr $0 "USERNAME"
  !insertmacro MS_UninstallLog "env.USERNAME: $0"
  ReadEnvStr $0 "USERDOMAIN"
  !insertmacro MS_UninstallLog "env.USERDOMAIN: $0"
  ReadEnvStr $0 "SystemRoot"
  !insertmacro MS_UninstallLog "env.SystemRoot: $0"

  ${If} ${Silent}
    !insertmacro MS_UninstallLog "mode: silent"
  ${Else}
    !insertmacro MS_UninstallLog "mode: interactive"
  ${EndIf}

  ; Use tasklist (no username filter) so it also catches elevated/different-user processes.
  StrCpy $R9 0

  check_running:
    IntOp $R9 $R9 + 1
    !insertmacro MS_UninstallLog ""
    !insertmacro MS_UninstallLog "--- install check_running attempt: $R9/3 ---"

    ${If} $R9 > 3
      !insertmacro MS_UninstallLog "too many retries -> Abort"
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP \
          "${PRODUCT_NAME} still appears to be running.$\r$\n$\r$\nPlease close it completely and run the installer again."
      ${EndIf}
      SetErrorLevel 1
      Abort
    ${EndIf}

    !if ${MS_ENABLE_DEBUG_LOG}
      ; Diagnostics: capture what tasklist sees (writes into ${MS_UNINSTALL_DEBUG_LOG_PATH}).
      nsExec::Exec `"$SYSDIR\cmd.exe" /c echo [install check_running] tasklist filter: >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
      Pop $0
      nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
      Pop $0
    !endif

    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R6
    !insertmacro MS_UninstallLog "nsProcess::FindProcess rc: $R6 (0=found)"

    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" >nul`
    Pop $R0
    !insertmacro MS_UninstallLog "tasklist|find rc: $R0 (0=found, 1=not found, 2=error)"

    ${if} $R0 == 2
      nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" >nul`
      Pop $R0
      !insertmacro MS_UninstallLog "fallback tasklist|find rc: $R0"
    ${endif}

    ; If nsProcess reports "found", treat as running regardless of tasklist result.
    ${if} $R6 == 0
      StrCpy $R0 0
      !insertmacro MS_UninstallLog "final decision: running (nsProcess)"
    ${else}
      ${if} $R0 == 0
        !insertmacro MS_UninstallLog "final decision: running (tasklist)"
      ${else}
        !insertmacro MS_UninstallLog "final decision: NOT running"
      ${endif}
    ${endif}

    ${if} $R0 == 0
      ${If} ${Silent}
        !insertmacro MS_UninstallLog "silent install + running -> Abort"
        SetErrorLevel 1
        Abort
      ${EndIf}

      !insertmacro MS_UninstallLog "interactive install + running -> prompt Retry/Cancel"
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
        "${PRODUCT_NAME} is currently running.$\r$\n$\r$\nPlease exit it completely (including tray) before installing.$\r$\n$\r$\nClick Retry to check again ($R9/3), or Cancel to exit the installer." \
        /SD IDCANCEL IDRETRY check_running
      !insertmacro MS_UninstallLog "user chose Cancel (or dialog closed) -> Abort"
      SetErrorLevel 1
      Abort
    ${endif}
!macroend

; electron-builder's default process detection in per-user installs only checks
; processes owned by the current user. If the app was launched elevated (or under
; a different user), uninstall/upgrade won't detect it and therefore won't show
; the "app is running" prompt or attempt to close it.
;
; Override the default check to look for the executable without filtering by
; username, then attempt to close it (graceful -> force).
!macro customCheckAppRunning
  !insertmacro MS_UninstallLog ""
  !insertmacro MS_UninstallLog "============================================================"
  !insertmacro MS_UninstallLog "=== customCheckAppRunning ==="
  !insertmacro MS_UninstallLog "log: ${MS_UNINSTALL_DEBUG_LOG_PATH}"
  !insertmacro MS_UninstallLog "PRODUCT_NAME: ${PRODUCT_NAME}"
  !insertmacro MS_UninstallLog "APP_EXECUTABLE_FILENAME: ${APP_EXECUTABLE_FILENAME}"
  !insertmacro MS_UninstallLog "INSTDIR: $INSTDIR"
  !insertmacro MS_UninstallLog "EXEDIR: $EXEDIR"
  !insertmacro MS_UninstallLog "CMDLINE: $CMDLINE"
  !insertmacro MS_UninstallLog "SYSDIR: $SYSDIR"

  ReadEnvStr $0 "USERNAME"
  !insertmacro MS_UninstallLog "env.USERNAME: $0"
  ReadEnvStr $0 "USERDOMAIN"
  !insertmacro MS_UninstallLog "env.USERDOMAIN: $0"
  ReadEnvStr $0 "SystemRoot"
  !insertmacro MS_UninstallLog "env.SystemRoot: $0"

  ${If} ${Silent}
    !insertmacro MS_UninstallLog "mode: silent"
  ${Else}
    !insertmacro MS_UninstallLog "mode: interactive"
  ${EndIf}

  !if ${MS_ENABLE_DEBUG_LOG}
    ; Extra diagnostics (captured to file).
    nsExec::Exec `"$SYSDIR\cmd.exe" /c echo [customCheckAppRunning] whoami: >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
    Pop $0
    nsExec::Exec `"$SYSDIR\cmd.exe" /c whoami >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
    Pop $0
    nsExec::Exec `"$SYSDIR\cmd.exe" /c echo [customCheckAppRunning] tasklist filter: >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
    Pop $0
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
    Pop $0
    nsExec::Exec `"$SYSDIR\cmd.exe" /c echo [customCheckAppRunning] tasklist ^| find: >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
    Pop $0
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
    Pop $0
  !endif

  ; Primary detection: nsProcess + tasklist/find (no username filter).
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R6
  !insertmacro MS_UninstallLog "nsProcess::FindProcess rc: $R6 (0=found)"

  nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" >nul`
  Pop $R0
  !insertmacro MS_UninstallLog "tasklist|find rc: $R0 (0=found, 1=not found, 2=error)"

  ; Fallback: if the filtered tasklist fails for any reason, do an unfiltered scan.
  ${if} $R0 == 2
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" >nul`
    Pop $R0
    !insertmacro MS_UninstallLog "fallback tasklist|find rc: $R0"
  ${endif}

  ; If nsProcess reports "found", treat as running regardless of tasklist result.
  ${if} $R6 == 0
    StrCpy $R0 0
    !insertmacro MS_UninstallLog "final decision: running (nsProcess)"
  ${else}
    ${if} $R0 == 0
      !insertmacro MS_UninstallLog "final decision: running (tasklist)"
    ${else}
      !insertmacro MS_UninstallLog "final decision: NOT running"
    ${endif}
  ${endif}

  ${if} $R0 == 0
    ${If} ${Silent}
      ; In silent mode, avoid killing user sessions unless this is an update.
      ${if} ${isUpdated}
        Goto doStopProcess
      ${else}
        !insertmacro MS_UninstallLog "silent + app running + not update -> Quit (SetErrorLevel 1)"
        SetErrorLevel 1
        Quit
      ${endif}
    ${EndIf}

    !insertmacro MS_UninstallLog "interactive + app running -> prompt OK/Cancel"
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
    !insertmacro MS_UninstallLog "user chose Cancel (or dialog closed) -> Quit"
    Quit

    doStopProcess:
    !insertmacro MS_UninstallLog "doStopProcess: start closing ${APP_EXECUTABLE_FILENAME}"
    !insertmacro MS_UninstallLog "Closing running ${PRODUCT_NAME}..."

    ; Try to close a few times, then force.
    StrCpy $R1 0

    loop:
      !insertmacro MS_UninstallLog "doStopProcess loop: attempt=$R1"
      nsExec::Exec `taskkill /im "${APP_EXECUTABLE_FILENAME}" /T >nul`
      Pop $R2
      !insertmacro MS_UninstallLog "taskkill (graceful) rc: $R2"
      Sleep 1000

      nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" >nul`
      Pop $R0
      !insertmacro MS_UninstallLog "recheck tasklist|find rc: $R0"

      ${if} $R0 == 2
        nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" >nul`
        Pop $R0
        !insertmacro MS_UninstallLog "recheck fallback tasklist|find rc: $R0"
      ${endif}

      ${if} $R0 == 0
        IntOp $R1 $R1 + 1

        ${if} $R1 < 3
          Goto loop
        ${endif}

        nsExec::Exec `taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /T >nul`
        Pop $R2
        !insertmacro MS_UninstallLog "taskkill (force) rc: $R2"
        Sleep 500

        nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" >nul`
        Pop $R0
        !insertmacro MS_UninstallLog "post-force recheck tasklist|find rc: $R0"

        ${if} $R0 == 2
          nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" >nul`
          Pop $R0
          !insertmacro MS_UninstallLog "post-force recheck fallback tasklist|find rc: $R0"
        ${endif}

        ${if} $R0 == 0
          ${IfNot} ${Silent}
            !insertmacro MS_UninstallLog "still running after force -> prompt Retry/Cancel"
            MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY loop
          ${EndIf}
          !insertmacro MS_UninstallLog "still running after force -> Quit"
          Quit
        ${endif}
      ${endif}
  ${endif}
!macroend

!macro customUnInit
  ; Always log uninstall init diagnostics to help troubleshoot "app running" detection.
  !insertmacro MS_UninstallLog ""
  !insertmacro MS_UninstallLog "============================================================"
  !insertmacro MS_UninstallLog "=== customUnInit (un.onInit) ==="
  !insertmacro MS_UninstallLog "log: ${MS_UNINSTALL_DEBUG_LOG_PATH}"
  !insertmacro MS_UninstallLog "PRODUCT_NAME: ${PRODUCT_NAME}"
  !insertmacro MS_UninstallLog "PRODUCT_FILENAME: ${PRODUCT_FILENAME}"
  !insertmacro MS_UninstallLog "APP_EXECUTABLE_FILENAME: ${APP_EXECUTABLE_FILENAME}"
  !insertmacro MS_UninstallLog "UNINSTALL_FILENAME: ${UNINSTALL_FILENAME}"
  !insertmacro MS_UninstallLog "INSTDIR: $INSTDIR"
  !insertmacro MS_UninstallLog "EXEDIR: $EXEDIR"
  !insertmacro MS_UninstallLog "CMDLINE: $CMDLINE"
  !insertmacro MS_UninstallLog "SYSDIR: $SYSDIR"

  ReadEnvStr $0 "USERNAME"
  !insertmacro MS_UninstallLog "env.USERNAME: $0"
  ReadEnvStr $0 "USERDOMAIN"
  !insertmacro MS_UninstallLog "env.USERDOMAIN: $0"
  ReadEnvStr $0 "SystemRoot"
  !insertmacro MS_UninstallLog "env.SystemRoot: $0"
  ReadEnvStr $0 "PROCESSOR_ARCHITECTURE"
  !insertmacro MS_UninstallLog "env.PROCESSOR_ARCHITECTURE: $0"
  ReadEnvStr $0 "PROCESSOR_ARCHITEW6432"
  !insertmacro MS_UninstallLog "env.PROCESSOR_ARCHITEW6432: $0"

  ${If} ${Silent}
    !insertmacro MS_UninstallLog "mode: silent"
  ${Else}
    !insertmacro MS_UninstallLog "mode: interactive"
  ${EndIf}

  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 +2
    !insertmacro MS_UninstallLog "exe exists: $INSTDIR\\${APP_EXECUTABLE_FILENAME}"

  !if ${MS_ENABLE_DEBUG_LOG}
    nsExec::Exec `"$SYSDIR\cmd.exe" /c echo [customUnInit] whoami: >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
    Pop $0
    nsExec::Exec `"$SYSDIR\cmd.exe" /c whoami >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
    Pop $0
  !endif

  ; Prevent partial uninstalls: if the app is running, prompt the user to close it.
  ; - Retry: re-check after the user closes the app
  ; - Cancel: exit uninstaller immediately
  ;
  ; Use tasklist (no username filter) so it also catches elevated/different-user processes.
  StrCpy $R9 0

  check_running:
    IntOp $R9 $R9 + 1
    !insertmacro MS_UninstallLog ""
    !insertmacro MS_UninstallLog "--- check_running attempt: $R9/3 ---"
    ${If} $R9 > 3
      !insertmacro MS_UninstallLog "too many retries -> Abort"
      MessageBox MB_OK|MB_ICONSTOP \
        "${PRODUCT_NAME} still appears to be running.$\r$\n$\r$\nPlease close it completely and run the uninstaller again."
      Abort
    ${EndIf}

    !if ${MS_ENABLE_DEBUG_LOG}
      ; Diagnostics: capture what tasklist sees (writes into ${MS_UNINSTALL_DEBUG_LOG_PATH}).
      nsExec::Exec `"$SYSDIR\cmd.exe" /c echo [check_running] tasklist filter: >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
      Pop $0
      nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
      Pop $0
      nsExec::Exec `"$SYSDIR\cmd.exe" /c echo [check_running] tasklist ^| find: >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
      Pop $0
      nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" >> "${MS_UNINSTALL_DEBUG_LOG_PATH}" 2>&1`
      Pop $0
    !endif

    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R6
    !insertmacro MS_UninstallLog "nsProcess::FindProcess rc: $R6 (0=found)"

    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" >nul`
    Pop $R0
    !insertmacro MS_UninstallLog "tasklist|find rc: $R0 (0=found, 1=not found, 2=error)"

    ${if} $R0 == 2
      nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}" >nul`
      Pop $R0
      !insertmacro MS_UninstallLog "fallback tasklist|find rc: $R0"
    ${endif}

    ; If nsProcess reports "found", treat as running regardless of tasklist result.
    ${if} $R6 == 0
      StrCpy $R0 0
      !insertmacro MS_UninstallLog "final decision: running (nsProcess)"
    ${else}
      ${if} $R0 == 0
        !insertmacro MS_UninstallLog "final decision: running (tasklist)"
      ${else}
        !insertmacro MS_UninstallLog "final decision: NOT running"
      ${endif}
    ${endif}

    ${if} $R0 == 0
      ${If} ${Silent}
        !insertmacro MS_UninstallLog "silent uninstall + running -> Abort"
        Abort
      ${EndIf}

      !insertmacro MS_UninstallLog "interactive uninstall + running -> prompt Retry/Cancel"
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
        "${PRODUCT_NAME} is currently running.$\r$\n$\r$\nPlease exit it completely (including tray) before uninstalling.$\r$\n$\r$\nClick Retry to check again ($R9/3), or Cancel to exit the uninstaller." \
        /SD IDCANCEL IDRETRY check_running
      !insertmacro MS_UninstallLog "user chose Cancel (or dialog closed) -> Abort"
      Abort
    ${endif}

  ${IfNot} ${Silent}
    !insertmacro MS_UninstallLog "not silent -> confirm uninstall prompt"
    MessageBox MB_YESNO|MB_ICONQUESTION "Are you sure you want to uninstall ${PRODUCT_NAME}?" IDYES proceed
    !insertmacro MS_UninstallLog "user chose No (or dialog closed) -> Abort"
    Abort
    proceed:
    !insertmacro MS_UninstallLog "user chose Yes -> continue"
  ${EndIf}
!macroend
