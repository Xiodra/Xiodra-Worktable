# 重启外壳（Electron）并等 CDP 就绪
#
# 来源：2026-11-23 调试面板特效时写的临时脚本（原址 99-工作区\_l1\_restart.ps1），
#       2026-11-25 按 Xiodra 要求保留，后面用来实现「一键重启」功能。
#       逻辑原样保留，没改行为。
#
# 它做什么：
#   ① 从正在跑的 electron.exe 命令行里反推 shellDir（向上一共四层）
#   ② 去掉 ELECTRON_RUN_AS_NODE（否则 electron.exe 会退化成纯 node 直接退出）
#   ③ 杀掉所有 electron.exe
#   ④ 用 `electron.exe . --remote-debugging-port=9222` 重新拉起
#   ⑤ 轮询 http://127.0.0.1:9222/json/version，最多 45 次 × 2 秒 = 90 秒
#
# ⛔ 已知的坑（**实测踩到，务必先看**）：
#   原脚本第一次跑（2026-11-23 18:58:04）时，日志只写到这两行就断了：
#       [18:58:04] shellDir=D:\Xiodra Worktable\11-源码照搬\外壳
#       [18:58:04] kill electron
#   后面那句 "start with debug port" 再没出现 ⇒ **脚本自己在杀 electron 时被一起杀掉了**。
#   推断原因（未严格证实）：从 DSH 内部调这个脚本时，pwsh 子进程跑在 Electron 的
#   Job Object（受管任务）里，`Stop-Process electron -Force` 会连带把 job 树整个带走。
#   同一现象在本次会话里出现过：杀进程时报
#   "Windows Job runner exited with exit code 4294967295 before proving its managed range empty"。
#   ⇒ **这个脚本不能从 DSH 的工具调用里直接跑**，必须由外部 shell、
#      或一个 detached 的独立进程来执行。
#
#   实现「一键重启」功能时，正确做法应是：
#     由外壳自己（main.js）执行重启，或先 Start-Process 一个 detached 的 helper 再让它动手，
#     ⛔ 不要让被杀的进程去杀自己。
#
# 用法：右键「使用 PowerShell 运行」，或在独立 PowerShell 窗口里：
#   powershell -ExecutionPolicy Bypass -File "工具\重启外壳.ps1"

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot '重启外壳.log'
function W($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 }
Set-Content -Path $log -Value "start" -Encoding UTF8

$shellDir = $null
foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue)) {
  $cl = [string]$p.CommandLine
  if ($cl -match '--type=') { continue }
  if ($cl -match '"([^"]+electron\.exe)"') {
    $exePath = $matches[1]
    $shellDir = Split-Path (Split-Path (Split-Path (Split-Path $exePath -Parent) -Parent) -Parent) -Parent
    break
  }
}
W "shellDir=$shellDir"
if (-not $shellDir) { W "NO SHELL DIR"; exit 1 }
$exe = Join-Path $shellDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) { W "MISSING EXE"; exit 1 }

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
W "kill electron"
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 900
W "start with debug port"
Start-Process -FilePath $exe -ArgumentList '.', '--remote-debugging-port=9222' -WorkingDirectory $shellDir

for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 2
    if ($r.webSocketDebuggerUrl) { W "CDP ready: $($r.Browser)"; exit 0 }
  } catch { }
}
W "CDP not up"
