param([switch]$Once)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskState=Join-Path $taskRoot 'data\maintenance'
$taskExe=Join-Path $taskRoot 'DeepSeek Harness.exe'
$taskSingleton=$null
try { $taskSingleton=[IO.File]::Open((Join-Path $taskState 'watchdog.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch { exit }
$taskAbsentSince=$null
$taskStarts=@()
try {
 $taskPrevious=Get-Content -LiteralPath (Join-Path $taskState 'watchdog-state.json') -Raw | ConvertFrom-Json
 $taskStarts=@($taskPrevious.startTimes | ForEach-Object {[DateTime]::Parse($_)} | Where-Object {$_ -gt (Get-Date).AddHours(-1)})
} catch { $taskStarts=@() }
try {
 do {
  $taskStatus='checking'
  $taskRestart=$false
  try {
   $taskConfig=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'features.json') -Raw | ConvertFrom-Json
   $taskEnabled=$taskConfig.watchdog.enabled
   $taskGuard=$null
   try {
    $taskGuard=[IO.File]::Open((Join-Path $taskState 'maintenance.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $taskRunning=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $taskExe -and $_.CommandLine -notmatch '--type=|qqbot-validation|runtime[\\/]cli' })
    if (!$taskEnabled) { $taskStatus='disabled';$taskAbsentSince=$null }
    elseif ($taskRunning.Count) {
     $taskStatus='running';$taskAbsentSince=$null
     $taskHealthPath=Join-Path $taskState 'qq-health.json'
     if(Test-Path -LiteralPath $taskHealthPath) {
      $taskHealth=Get-Content -LiteralPath $taskHealthPath -Raw | ConvertFrom-Json
      $taskStarts=@($taskStarts | Where-Object { $_ -gt (Get-Date).AddHours(-1) })
      if($taskHealth.detail -eq 'permanent' -and $taskHealth.pid -in $taskRunning.ProcessId -and ([DateTimeOffset]::Now.ToUnixTimeMilliseconds()-$taskHealth.at) -gt 60000 -and $taskStarts.Count -lt $taskConfig.watchdog.maxStartsPerHour) {
       $taskNode=Join-Path $taskRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
       $taskLive=& $taskNode (Join-Path $PSScriptRoot 'ops.cjs') status 2>$null
       if($LASTEXITCODE -eq 0 -and ($taskLive | ConvertFrom-Json).idle) { $taskRestart=$true;$taskStatus='qq-restart-queued' }
      }
     }
    }
    else {
     if (!$taskAbsentSince) { $taskAbsentSince=Get-Date }
     $taskStatus='waiting-before-start'
     $taskStarts=@($taskStarts | Where-Object { $_ -gt (Get-Date).AddHours(-1) })
     if ($taskStarts.Count -ge $taskConfig.watchdog.maxStartsPerHour) { $taskStatus='start-budget-exhausted' }
     elseif (((Get-Date)-$taskAbsentSince).TotalSeconds -ge 90) {
      $env:DSH_HOME=Join-Path $taskRoot 'data';$env:TEMP=Join-Path $taskRoot 'tmp';$env:TMP=$env:TEMP
      $env:PNPM_CONFIG_STORE_DIR=Join-Path $taskRoot 'cache\pnpm-store'
      Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
      $taskStamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
      Start-Process -FilePath $taskExe -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot "tmp\desktop-$taskStamp.stdout.log") -RedirectStandardError (Join-Path $taskRoot "tmp\desktop-$taskStamp.stderr.log") | Out-Null
      $taskStarts+=Get-Date;$taskAbsentSince=$null;$taskStatus='started'
     }
    }
   } catch [IO.IOException] { $taskStatus='maintenance-in-progress';$taskAbsentSince=$null }
   finally { if($taskGuard){$taskGuard.Dispose()} }
   if($taskRestart){& (Join-Path $PSScriptRoot 'manage.ps1') -Action Restart -Queue | Out-Null;$taskStarts+=Get-Date}
   $taskStarts=@($taskStarts | Where-Object {$_ -gt (Get-Date).AddHours(-1)})
   $taskNow=[ordered]@{status=$taskStatus;enabled=$taskEnabled;checkedAt=(Get-Date).ToString('o');startsLastHour=$taskStarts.Count;startTimes=@($taskStarts | ForEach-Object {$_.ToString('o')});pid=$PID}
   $taskNow | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskState "watchdog-state.$PID.tmp") -Encoding UTF8
   Move-Item -LiteralPath (Join-Path $taskState "watchdog-state.$PID.tmp") -Destination (Join-Path $taskState 'watchdog-state.json') -Force
  } catch { Write-Output ('watchdog check failed: '+$_.Exception.GetType().Name) }
  if (!$Once) { Start-Sleep -Seconds ([Math]::Max(5,[Math]::Min(300,[int]$taskConfig.watchdog.intervalSeconds))) }
 } while (!$Once)
} finally { $taskSingleton.Dispose() }
