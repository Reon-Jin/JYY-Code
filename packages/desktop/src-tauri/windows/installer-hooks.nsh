!macro NSIS_HOOK_PREINSTALL
  ; The sidecar is an external binary, so NSIS cannot replace it while a
  ; previous desktop process (or a stale process from a failed update) still
  ; has the executable image open.
  nsExec::Exec 'taskkill /F /T /IM jyycode-sidecar.exe'
  Sleep 1000
  Delete "$INSTDIR\jyycode-sidecar.exe"
!macroend
