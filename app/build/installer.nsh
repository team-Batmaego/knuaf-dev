!include UAC.nsh

!ifndef BUILD_UNINSTALLER
Function CleanupLegacyMachineInstall
  ReadRegStr $6 HKLM "Software\${APP_GUID}" InstallLocation
  ${If} $6 != ""
    StrCpy $1 "$6\Uninstall ${PRODUCT_FILENAME}.exe"
    ${If} ${FileExists} "$1"
      InitPluginsDir
      StrCpy $2 "$PLUGINSDIR\old-uninstaller.exe"
      ClearErrors
      CopyFiles /SILENT "$1" "$2"
      ${If} ${Errors}
        MessageBox MB_OK|MB_ICONSTOP "옛 전체 설치 제거 파일을 복사하지 못해 새 설치를 중단했어요. 컴퓨터를 다시 시작한 뒤 설치 파일을 다시 실행해 주세요."
        SetErrorLevel 1
        Quit
      ${EndIf}

      # _?= keeps the copied uninstaller in charge of deleting the legacy
      # install folder. --updated and /KEEP_APP_DATA preserve per-user data.
      ${If} ${UAC_IsAdmin}
        # An updater-launched installer is already elevated. Run directly so
        # cleanup completes without a second UAC prompt.
        ExecWait '"$2" /allusers /S /KEEP_APP_DATA --updated _?=$6' $5
        ${If} $5 != 0
          MessageBox MB_OK|MB_ICONSTOP "옛 전체 설치 제거가 실패해 새 설치를 중단했어요. 컴퓨터를 다시 시작한 뒤 설치 파일을 다시 실행해 주세요. 오류 코드: $5"
          SetErrorLevel 1
          Quit
        ${EndIf}
      ${Else}
        ${StdUtils.ExecShellWaitEx} $3 $4 "$2" "runas" "/allusers /S /KEEP_APP_DATA --updated _?=$6"
        ${If} $3 == "error"
          ${If} $4 == 1223
            MessageBox MB_OK|MB_ICONINFORMATION "옛 전체 설치와 바로가기는 남아 있어요. 새 버전은 계속 설치됩니다. 예전 바로가기는 설정 → 앱에서 옛 knuaf-dev를 제거하면 사라져요."
            Return
          ${Else}
            MessageBox MB_OK|MB_ICONSTOP "옛 전체 설치 제거를 시작하지 못해 새 설치를 중단했어요. 컴퓨터를 다시 시작한 뒤 설치 파일을 다시 실행해 주세요. 오류 코드: $4"
            SetErrorLevel 1
            Quit
          ${EndIf}
        ${ElseIf} $3 == "no_wait"
          MessageBox MB_OK|MB_ICONSTOP "옛 전체 설치 제거 완료를 기다릴 수 없어 새 설치를 중단했어요. 컴퓨터를 다시 시작한 뒤 설치 파일을 다시 실행해 주세요."
          SetErrorLevel 1
          Quit
        ${ElseIf} $3 == "ok"
          ${StdUtils.WaitForProcEx} $5 $4
          ${If} $5 != 0
            MessageBox MB_OK|MB_ICONSTOP "옛 전체 설치 제거가 실패해 새 설치를 중단했어요. 컴퓨터를 다시 시작한 뒤 설치 파일을 다시 실행해 주세요. 오류 코드: $5"
            SetErrorLevel 1
            Quit
          ${EndIf}
        ${Else}
          MessageBox MB_OK|MB_ICONSTOP "옛 전체 설치 제거 상태를 확인할 수 없어 새 설치를 중단했어요. 컴퓨터를 다시 시작한 뒤 설치 파일을 다시 실행해 주세요."
          SetErrorLevel 1
          Quit
        ${EndIf}
      ${EndIf}
    ${Else}
      ${If} ${Silent}
        MessageBox MB_OK|MB_ICONSTOP "옛 전체 설치 제거 파일을 찾지 못해 새 설치를 중단했어요. 컴퓨터를 다시 시작한 뒤 설치 파일을 다시 실행해 주세요."
        SetErrorLevel 1
        Quit
      ${Else}
        MessageBox MB_OK|MB_ICONINFORMATION "옛 전체 설치를 제거할 파일을 찾지 못했어요. 새 버전은 설치되지만 예전 앱이나 바로가기가 남아 있을 수 있어요."
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd
!endif

!macro customInit
  ${IfNot} ${Silent}
    Call CleanupLegacyMachineInstall
  ${Else}
    # Silent elevated updates can be the first transition from a legacy
    # machine install; silent per-user updates must not request elevation.
    ${If} ${UAC_IsAdmin}
      Call CleanupLegacyMachineInstall
    ${EndIf}
  ${EndIf}
!macroend
