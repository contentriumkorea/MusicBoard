@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "release\native-unpacked\SONO.exe" (
  start "" "release\native-unpacked\SONO.exe"
  exit /b
)
echo 네이티브 앱 빌드가 없습니다. 개발 환경에서 pnpm build:native를 먼저 실행해주세요.
echo 설치 버전은 GitHub MusicBoard의 최신 설치 파일을 이용해주세요.
pause
exit /b 1
