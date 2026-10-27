param([switch]$Web, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskNode = Join-Path $taskRoot 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe'
$taskRuntime = & $taskNode (Join-Path $taskRoot 'maintenance/runtime.cjs')
if($LASTEXITCODE -ne 0){throw 'Invalid Host runtime selection'}
$taskExe = Join-Path $taskRuntime 'DeepSeek Harness.exe'
$taskTemp = Join-Path $taskRoot 'tmp'
$env:DSH_HOME = Join-Path $taskRoot 'data'
$env:TEMP = $taskTemp
$env:TMP = $taskTemp
$env:npm_config_cache = Join-Path $taskRoot 'cache\npm'
$env:PNPM_CONFIG_STORE_DIR = Join-Path $taskRoot 'cache\pnpm-store'
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$taskRunning = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $taskExe })
if (!$taskRunning.Count) {
    if ($CheckOnly) { throw 'Desktop is not running.' }
    $taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    Start-Process -FilePath $taskExe -WorkingDirectory $taskRoot -WindowStyle Normal -RedirectStandardOutput (Join-Path $taskTemp "desktop-$taskStamp.stdout.log") -RedirectStandardError (Join-Path $taskTemp "desktop-$taskStamp.stderr.log")
} elseif (!$Web -and !$CheckOnly) {
    Start-Process -FilePath $taskExe -WorkingDirectory $taskRoot -WindowStyle Normal
}
if (!$Web -and !$CheckOnly) { exit }
$taskDeadline = (Get-Date).AddSeconds(60)
do {
    $taskLogs = Get-ChildItem -LiteralPath $taskTemp -Filter 'desktop-*.stdout.log' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 8
    foreach ($taskLog in $taskLogs) {
        try { $taskText = Get-Content -LiteralPath $taskLog.FullName -Raw -ErrorAction Stop } catch { continue }
        if (!$taskText) { continue }
        $taskMatches = [regex]::Matches($taskText, 'dsh web: (http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_-]+)')
        foreach ($taskMatch in $taskMatches) {
            $taskUrl = $taskMatch.Groups[1].Value
            try { $taskResponse = Invoke-WebRequest -Uri $taskUrl -UseBasicParsing -TimeoutSec 3 } catch { continue }
            if ($taskResponse.StatusCode -eq 200 -and $taskResponse.Content -match '<html') {
                if ($CheckOnly) { Write-Output 'Shared Desktop/Web entry verified (HTTP 200).'; exit }
                Start-Process -FilePath $taskUrl -WindowStyle Normal
                exit
            }
        }
    }
    if ($CheckOnly) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $taskDeadline)
throw 'Web entry is not ready. Fully quit Desktop and reopen it through start-desktop.vbs, then try again. Check tmp\desktop-*.stderr.log for startup errors.'
