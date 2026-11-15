!include LogicLib.nsh
!include FileFunc.nsh

!ifndef BUILD_UNINSTALLER
Function FoxFerryDirectoryName
  ${GetFileName} "$INSTDIR" $0
  ${If} $0 == "Clash Routing Assistant"
    ${GetParent} "$INSTDIR" $0
    StrCpy $INSTDIR "$0\FoxFerry"
  ${EndIf}
FunctionEnd
!endif

!macro customInit
  Call FoxFerryDirectoryName
!macroend

!macro customWelcomePage
  ; The install-mode page rereads the previous path after .onInit.
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE FoxFerryDirectoryName
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FoxFerryFollow"
  StrCpy $1 '"$INSTDIR\FoxFerry.exe"'
  StrLen $2 $1
  StrCpy $3 $0 $2
  ${If} $3 == $1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FoxFerryFollow"
  ${EndIf}
!macroend
