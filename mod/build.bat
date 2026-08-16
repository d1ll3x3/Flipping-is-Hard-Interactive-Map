@echo off
setlocal

rem Run from the project folder no matter where the script was invoked from.
pushd "%~dp0"

set GAME=I:\SteamLibrary\steamapps\common\Flipping is Hard Demo

if not exist "%GAME%\BepInEx\interop\Assembly-CSharp.dll" (
    echo No interop found in "%GAME%".
    echo Run the game once with BepInEx installed and try again.
    popd
    pause
    exit /b 1
)

dotnet build -c Release -p:GameDir="%GAME%" -p:Deploy=true
if errorlevel 1 (
    echo BUILD FAILED
    popd
    pause
    exit /b 1
)

popd

echo.
echo Done.
pause
