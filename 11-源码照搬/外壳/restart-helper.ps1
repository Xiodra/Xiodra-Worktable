# restart-helper.ps1 -- restart the XIODRA shell from OUTSIDE the dying process
#
# WHY THIS FILE EXISTS
#   The restart button cannot kill and respawn Electron from inside Electron:
#   if the process that runs "kill electron" is itself a child of Electron (or of
#   the DSH job object), it gets taken down with it.  Observed 2026-11-23: a
#   restart script logged "kill electron" and then never wrote another line.
#
#   So main.js spawns THIS script detached, then exits.  This script outlives
#   Electron, waits for the old pid to disappear, and relaunches through the
#   shell's own start.vbs (which reads config.json, sets DSH_* env vars and cwd).
#
# ENCODING: ASCII ONLY.  Do not add Chinese literals here.
#   powershell.exe (5.1) reads a BOM-less .ps1 as ANSI; Chinese string literals
#   would be mangled.  Chinese belongs in main.js / index.html, which are UTF-8.
#
# USAGE (called by main.js, not by hand):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File restart-helper.ps1 `
#     -OldPid <pid> -Launcher "<shell>\start.vbs"

param(
  [Parameter(Mandatory = $true)][int]$OldPid,
  [Parameter(Mandatory = $true)][string]$Launcher
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'restart-helper.log'

function W($m) {
  try { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 } catch { }
}

Set-Content -Path $log -Value ("=== restart triggered at " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " ===") -Encoding UTF8
W "pid       = $PID"
W "psscript  = $PSScriptRoot"
W "old pid   = $OldPid"
W "launcher  = $Launcher"
W "electron  = " + (@(Get-Process electron -ErrorAction SilentlyContinue).Count) + " processes"

if (-not (Test-Path -LiteralPath $Launcher)) {
  W "ABORT: launcher not found"
  exit 1
}

# (1) Wait for the old instance to exit.
#     The single-instance lock is held by the old process; if the new one starts
#     too early it cannot get the lock, calls app.quit() and dies silently.
$waited = 0
while ($waited -lt 30000) {
  if (-not (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
  $waited += 200
}

if (Get-Process -Id $OldPid -ErrorAction SilentlyContinue) {
  W "old pid still alive after 30s, forcing"
  Stop-Process -Id $OldPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 600
} else {
  W "old pid gone after $waited ms"
}

# (2) Extra settle time so the instance lock and the engine port are released.
Start-Sleep -Milliseconds 1500

# (3) Relaunch through the shell's own launcher (config.json / env / cwd handled there).
W "spawning wscript.exe $Launcher"
try {
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $Launcher + '"')
  W "spawn ok"
} catch {
  W ("ABORT: spawn failed: " + $_.Exception.Message)
  exit 1
}

# (4) Confirm it actually came up: look for an electron process, up to 120s.
for ($i = 1; $i -le 60; $i++) {
  Start-Sleep -Seconds 2
  $p = @(Get-Process electron -ErrorAction SilentlyContinue)
  if ($p.Count -gt 0) {
    W "OK: electron is up ($($p.Count) processes) after $(($i) * 2)s"
    exit 0
  }
}

W "FAIL: no electron process after 120s -- start manually with the root launcher"
exit 1
