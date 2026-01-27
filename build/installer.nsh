!macro customPageAfterChangeDir
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
!macroend

; electron-builder's default process detection in per-user installs only checks
; processes owned by the current user. If the app was launched elevated (or under
; a different user), uninstall/upgrade won't detect it and therefore won't show
; the "app is running" prompt or attempt to close it.
;
; Override the default check to look for the executable without filtering by
; username, then attempt to close it (graceful -> force).
!macro customCheckAppRunning
  ; Use tasklist to detect running app (no username filter, so it works for elevated/different user).
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c tasklist /FI "IMAGENAME eq ${PRODUCT_FILENAME}.exe" /FO csv | %SYSTEMROOT%\System32\find.exe /I "${PRODUCT_FILENAME}.exe" >nul`
  Pop $R0

  ${if} $R0 == 0
    ${If} ${Silent}
      Goto doStopProcess
    ${EndIf}

    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
    Quit

    doStopProcess:
    DetailPrint `Closing running "${PRODUCT_NAME}"...`

    ; Try graceful close first.
    nsExec::Exec `taskkill /im "${PRODUCT_FILENAME}.exe" /T >nul`
    Sleep 500

    ; Retry a couple times, then force.
    StrCpy $R1 0

    loop:
      IntOp $R1 $R1 + 1

      nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c tasklist /FI "IMAGENAME eq ${PRODUCT_FILENAME}.exe" /FO csv | %SYSTEMROOT%\System32\find.exe /I "${PRODUCT_FILENAME}.exe" >nul`
      Pop $R0

      ${if} $R0 == 0
        ${if} $R1 < 3
          Sleep 1000
          Goto loop
        ${endif}

        nsExec::Exec `taskkill /f /im "${PRODUCT_FILENAME}.exe" /T >nul`
        Sleep 500

        nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c tasklist /FI "IMAGENAME eq ${PRODUCT_FILENAME}.exe" /FO csv | %SYSTEMROOT%\System32\find.exe /I "${PRODUCT_FILENAME}.exe" >nul`
        Pop $R0

        ${if} $R0 == 0
          ${IfNot} ${Silent}
            MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY loop
          ${EndIf}
          Quit
        ${endif}
      ${endif}
  ${endif}
!macroend

!macro customUnInit
  ; Prevent partial uninstalls: if the app is running, tell the user to close it first.
  nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c tasklist /FI "IMAGENAME eq ${PRODUCT_FILENAME}.exe" /FO csv | %SYSTEMROOT%\System32\find.exe /I "${PRODUCT_FILENAME}.exe" >nul`
  Pop $R0

  ${if} $R0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "${PRODUCT_NAME} is currently running. Please exit it before uninstalling."
    Abort
  ${endif}

  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION "Are you sure you want to uninstall ${PRODUCT_NAME}?" IDYES proceed
    Abort
    proceed:
  ${EndIf}
!macroend
