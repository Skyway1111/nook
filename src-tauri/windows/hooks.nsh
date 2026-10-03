; "Open with nook" on a folder, and on the empty space inside one. Removed on uninstall.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\nook" "" "Open with nook"
  WriteRegStr HKCU "Software\Classes\Directory\shell\nook" "Icon" "$INSTDIR\nook.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\nook\command" "" '"$INSTDIR\nook.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\nook" "" "Open with nook"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\nook" "Icon" "$INSTDIR\nook.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\nook\command" "" '"$INSTDIR\nook.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\nook"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\nook"
!macroend
