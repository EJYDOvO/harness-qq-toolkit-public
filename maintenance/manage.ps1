param(
    [ValidateSet('Status','Doctor','Result','CheckUpdates','Backup','Stage','DeployValidated','Restart','Restore','ApplyFeatures')]
    [string]$Action = 'Status',
    [switch]$Queue,
    [string]$BackupId,
    [string]$JobId
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = Join-Path $taskRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
if (!(Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node.exe -ErrorAction Stop).Source }
$taskOps = Join-Path $PSScriptRoot 'ops.cjs'
$taskProfile = Join-Path $taskRoot 'data\profiles\desktop'
$taskStage = Join-Path $taskRoot 'data\profiles\qqbot-validation'
$taskStore = Join-Path $taskRoot 'cache\pnpm-store'
$taskPnpm = Join-Path $taskRoot 'resources\runtime\pnpm\bin\pnpm.mjs'
$taskRuntime = & $taskNode (Join-Path $PSScriptRoot 'runtime.cjs')
if($LASTEXITCODE -ne 0){throw 'Invalid Host runtime selection'}
$taskExe = Join-Path $taskRuntime 'DeepSeek Harness.exe'
$taskState = Join-Path $taskRoot 'data\maintenance'
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
if ($JobId) {
    if ($JobId -notmatch '^\d{8}-\d{6}-\d{3}$') { throw 'Invalid job id.' }
    $taskStamp = $JobId
}
New-Item -ItemType Directory -Force -Path (Join-Path $taskState 'jobs'),(Join-Path $taskState 'backups') | Out-Null
$env:DSH_HOME = Join-Path $taskRoot 'data'
$env:TEMP = Join-Path $taskRoot 'tmp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $taskRoot 'cache\npm'
$env:PNPM_CONFIG_STORE_DIR = $taskStore

if ($Queue) {
    if ($Action -notin @('Backup','Stage','DeployValidated','Restart','Restore','ApplyFeatures')) { throw 'Unsupported queued action.' }
    if ($BackupId -and $BackupId -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid backup id.' }
    $taskArgs = @('-NoProfile','-File',('"{0}"' -f $PSCommandPath),'-Action',$Action,'-JobId',$taskStamp)
    if ($BackupId) { $taskArgs += @('-BackupId',$BackupId) }
    $taskJob = Join-Path $taskState "jobs\$taskStamp-$Action"
    $taskProcess = Start-Process -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source -ArgumentList $taskArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput "$taskJob.out.log" -RedirectStandardError "$taskJob.err.log"
    Write-Output "Maintenance queued: $Action; PID=$($taskProcess.Id); result=$taskJob.result.json; logs=$taskJob.*.log"
    exit
}
function Invoke-TaskNode([string[]]$NodeArgs) {
    & $taskNode @NodeArgs
    if ($LASTEXITCODE -ne 0) { throw "Node command failed (exit $LASTEXITCODE)." }
}
function Get-TaskStatus([switch]$Health) {
    $taskCommand = 'status'
    if ($Health) { $taskCommand = 'health' }
    $taskOutput = & $taskNode $taskOps $taskCommand 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify running Harness status.' }
    return ($taskOutput | ConvertFrom-Json)
}
function Wait-TaskIdle {
    $taskDeadline = (Get-Date).AddMinutes(3)
    do {
        $taskStatus = Get-TaskStatus
        if ($taskStatus.idle) { return }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $taskDeadline)
    throw 'Agents are still running. No files or processes were changed.'
}
function Backup-TaskProfile {
    $taskDestination = Join-Path $taskState "backups\$taskStamp"
    New-Item -ItemType Directory -Path $taskDestination | Out-Null
    Copy-Item -LiteralPath $taskProfile -Destination (Join-Path $taskDestination 'profile') -Recurse
    Copy-Item -LiteralPath (Join-Path $taskRoot 'data\AGENTS.md') -Destination $taskDestination
    $taskMemory = Join-Path $taskRoot 'data\storages\task-memory'
    if (Test-Path -LiteralPath $taskMemory) {
        New-Item -ItemType Directory -Path (Join-Path $taskDestination 'feature-data') | Out-Null
        Copy-Item -LiteralPath $taskMemory -Destination (Join-Path $taskDestination 'feature-data\task-memory') -Recurse
    }
    [ordered]@{ createdAt=(Get-Date).ToString('o'); action=$Action; profile='desktop' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskDestination 'manifest.json') -Encoding UTF8
    Invoke-TaskNode @((Join-Path $PSScriptRoot 'backup-integrity.cjs'),'seal',$taskDestination) | Out-Host
    return $taskDestination
}
function Stop-TaskHost {
    # Stop only this installation, after checking that both agent and plugin operations are idle.
    Wait-TaskIdle
    $taskProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $taskExe })
    if (!$taskProcesses.Count) { throw 'Harness process could not be identified.' }
    $script:taskStopped = $true
    foreach ($taskProcess in $taskProcesses) { Stop-Process -Id $taskProcess.ProcessId -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    if (@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $taskExe }).Count) { throw 'Harness did not stop.' }
}
function Start-TaskHost {
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $taskLogStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $script:taskStartLog = Join-Path $taskRoot "tmp\desktop-$taskLogStamp.stdout.log"
    Start-Process -FilePath $taskExe -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $script:taskStartLog -RedirectStandardError (Join-Path $taskRoot "tmp\desktop-$taskLogStamp.stderr.log") | Out-Null
    $taskDeadline = (Get-Date).AddSeconds(100)
    do {
        Start-Sleep -Seconds 2
        try {
            $taskStatus = Get-TaskStatus
            $taskLog = Get-Content -LiteralPath $script:taskStartLog -Raw -ErrorAction SilentlyContinue
            if ($taskStatus.reachable -and $taskLog -match '\[im-qqbot\] Bot ready!') { return (Get-TaskStatus -Health) }
        } catch { }
    } while ((Get-Date) -lt $taskDeadline)
    throw 'Harness/QQ did not become ready within 100 seconds.'
}
function Restore-TaskFiles([string]$From) {
    Invoke-TaskNode @((Join-Path $PSScriptRoot 'backup-integrity.cjs'),'verify',$From) | Out-Host
    $taskResolved = [IO.Path]::GetFullPath($taskProfile)
    $taskFailed = [IO.Path]::GetFullPath((Join-Path $taskState "failed-profile-$taskStamp-$([guid]::NewGuid().ToString('N').Substring(0,8))"))
    if ($taskResolved -ne [IO.Path]::GetFullPath((Join-Path $taskRoot 'data\profiles\desktop')) -or !$taskFailed.StartsWith([IO.Path]::GetFullPath($taskState) + '\')) { throw 'Unsafe recovery path.' }
    Move-Item -LiteralPath $taskResolved -Destination $taskFailed
    Copy-Item -LiteralPath (Join-Path $From 'profile') -Destination $taskProfile -Recurse
}
if ($Action -eq 'Status') { Invoke-TaskNode @($taskOps,'status'); exit }
if ($Action -eq 'Doctor') { Invoke-TaskNode @($taskOps,'verify'); Invoke-TaskNode @($taskOps,'health'); exit }
if ($Action -eq 'Result') {
    $taskLatest = Join-Path $taskState 'latest-result.json'
    if (!(Test-Path -LiteralPath $taskLatest)) { throw 'No maintenance result yet.' }
    Get-Content -LiteralPath $taskLatest -Raw
    exit
}
if ($Action -eq 'CheckUpdates') { Invoke-TaskNode @($taskOps,'updates'); exit }
$taskLock = $null
$taskResult = [ordered]@{ action=$Action; startedAt=(Get-Date).ToString('o'); ok=$false }
$taskBackup = $null
$taskStopped = $false
$taskFilesChanged = $false
try {
    $taskLock = [IO.File]::Open((Join-Path $taskState 'maintenance.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    if ($Action -eq 'Backup') {
        Wait-TaskIdle
        $taskResult.backup = Backup-TaskProfile
    } elseif ($Action -eq 'Stage') {
        Invoke-TaskNode @((Join-Path $PSScriptRoot 'build-qqbot-patch.cjs'),'--check')
        Invoke-TaskNode @((Join-Path $PSScriptRoot 'build-qqbot-patch.cjs'),'--sdk','--check')
        Invoke-TaskNode @((Join-Path $PSScriptRoot 'stage.cjs'))
        & $taskNode $taskPnpm --dir $taskStage --store-dir $taskStore install --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw 'Candidate dependency installation failed.' }
        Invoke-TaskNode @($taskOps,'verify',$taskStage)
        $env:QQBOT_TEST_PROFILE = $taskStage
        Invoke-TaskNode @('--test',(Join-Path $PSScriptRoot 'approval.test.mjs'),(Join-Path $PSScriptRoot 'qq-boundaries.test.mjs'),(Join-Path $PSScriptRoot 'maintenance.test.cjs'),(Join-Path $PSScriptRoot 'remote-ops.test.mjs'),(Join-Path $taskRoot 'plugin-sources\dsh-task-memory\tests\render.test.mjs'))
        $taskCompositionErrors = Join-Path $taskRoot 'tmp\inspect\validated-composition.err.log'
        & (Join-Path $taskRoot 'resources\runtime\cli\bin\dsh.cmd') --profile qqbot-validation --dump-config 1> (Join-Path $taskRoot 'tmp\inspect\validated-composition.yml') 2> $taskCompositionErrors
        if ($LASTEXITCODE -ne 0) { throw 'Candidate composition failed.' }
        if ((Get-Content -LiteralPath $taskCompositionErrors -Raw) -match 'skipping profile bundle|incompatible with dsh|patch: entry .+ not found') { throw 'Candidate silently skipped a plugin or override; inspect composition diagnostics.' }
        Invoke-TaskNode @((Join-Path $PSScriptRoot 'stage.cjs'),'seal')
        $taskResult.candidate = $taskStage
    } else {
        if ($Action -eq 'DeployValidated') { Invoke-TaskNode @((Join-Path $PSScriptRoot 'stage.cjs'),'check') }
        if ($Action -eq 'Restore') {
            if (!$BackupId -or $BackupId -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Specify an exact local BackupId.' }
            $taskRestore = Join-Path $taskState "backups\$BackupId"
            if (!(Test-Path -LiteralPath (Join-Path $taskRestore 'profile\package.json'))) { throw 'Backup not found.' }
            Invoke-TaskNode @((Join-Path $PSScriptRoot 'backup-integrity.cjs'),'verify',$taskRestore)
        }
        Wait-TaskIdle
        $taskBackup = Backup-TaskProfile
        $taskResult.backup = $taskBackup
        Stop-TaskHost
        $taskStopped = $true
        if ($Action -eq 'DeployValidated') {
            # Re-check after the idle wait and shutdown, so intervening UI changes cannot be overwritten.
            Invoke-TaskNode @((Join-Path $PSScriptRoot 'stage.cjs'),'check')
            $taskFilesChanged = $true
            foreach ($taskFile in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.patch.yml')) {
                Copy-Item -LiteralPath (Join-Path $taskStage $taskFile) -Destination (Join-Path $taskProfile $taskFile) -Force
            }
            Copy-Item -LiteralPath (Join-Path $taskStage 'patches') -Destination $taskProfile -Recurse -Force
            & $taskNode $taskPnpm --dir $taskProfile --store-dir $taskStore install --frozen-lockfile --ignore-scripts --offline
            if ($LASTEXITCODE -ne 0) { throw 'Frozen candidate install failed.' }
            Invoke-TaskNode @($taskOps,'verify')
        } elseif ($Action -eq 'Restore') {
            $taskFilesChanged = $true
            Restore-TaskFiles $taskRestore
        } elseif ($Action -eq 'ApplyFeatures') {
            $taskFilesChanged = $true
            Invoke-TaskNode @($taskOps,'configure-features')
        }
        $taskResult.status = Start-TaskHost
        $taskStopped = $false
    }
    $taskResult.ok = $true
} catch {
    $taskResult.error = $_.Exception.Message
    if ($taskStopped -and $taskBackup) {
        try {
            # Only processes of this failed deployment are stopped here; the pre-change idle gate already passed.
            Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $taskExe } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
            Start-Sleep -Seconds 2
            if ($taskFilesChanged) { Restore-TaskFiles $taskBackup }
            $taskResult.rollbackStatus = Start-TaskHost
            $taskResult.rolledBack = $true
        } catch { $taskResult.rollbackError = $_.Exception.Message }
    }
} finally {
    $taskResult.finishedAt = (Get-Date).ToString('o')
    $taskJson = $taskResult | ConvertTo-Json -Depth 8
    $taskJson | Set-Content -LiteralPath (Join-Path $taskState "jobs\$taskStamp-$Action.result.json") -Encoding UTF8
    if ($taskLock) {
        try {
            $taskLatestTemp = Join-Path $taskState "latest-result.$PID.tmp"
            $taskJson | Set-Content -LiteralPath $taskLatestTemp -Encoding UTF8
            Move-Item -LiteralPath $taskLatestTemp -Destination (Join-Path $taskState 'latest-result.json') -Force
        } finally { $taskLock.Dispose() }
    }
    Write-Output $taskJson
}
if (!$taskResult.ok) { exit 1 }
