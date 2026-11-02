!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  IfFileExists "$INSTDIR\portable-mode.json" 0 +2
    Abort "不能将安装版覆盖到便携目录"
  IfFileExists "$INSTDIR\server\*.*" 0 done_server_check
    IfFileExists "$INSTDIR\installed-mode.json" 0 missing_marker
      ClearErrors
      RMDir /r "$INSTDIR\server"
      IfErrors 0 done_server_check
        Abort "无法清理旧版服务器资源；请关闭应用后重试"
    missing_marker:
      Abort "安装目录含有非本安装版的 server 资源"
  done_server_check:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  FileOpen $0 "$INSTDIR\installer-channel.txt" w
  FileWrite $0 "nsis$\r$\n"
  FileClose $0
!macroend
