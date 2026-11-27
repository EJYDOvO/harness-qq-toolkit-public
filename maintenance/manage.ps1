param(
    [ValidateSet('Status','Doctor','Result','CheckUpdates','Backup','Stage','DeployValidated','Restart','Restore','ApplyFeatures','SwitchCharacter')]
    [string]$Action = 'Status',
    [switch]$Queue,
    [string]$BackupId,
    [string]$JobId
)
$ErrorActionPreference = 'Stop'
# Node prints UTF-8; Windows PowerShell 5.1 would decode it with the console code page (GBK on
# Chinese Windows) and corrupt JSON containing non-ASCII text, e.g. a Chinese Preset name.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
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
function Get-TaskHostProcesses {
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $taskExe }
}
function Stop-TaskHostProcesses([object[]]$Processes) {
    foreach ($taskProcess in $Processes) { Stop-Process -Id $taskProcess.ProcessId -ErrorAction SilentlyContinue }
    if ($Processes.Count) { Start-Sleep -Seconds 2 }
    if (@(Get-TaskHostProcesses).Count) { throw 'Harness did not stop.' }
}
function Stop-TaskHost {
    # Stop only this installation, after checking that both agent and plugin operations are idle.
    Wait-TaskIdle
    $taskProcesses = @(Get-TaskHostProcesses)
    if (!$taskProcesses.Count) { throw 'Harness process could not be identified.' }
    $script:taskStopped = $true
    Stop-TaskHostProcesses $taskProcesses
}
function Test-TaskQQReady([int64]$taskStartedAt, [int[]]$taskPids) {
    $taskHealthFile = Join-Path $taskState 'qq-health.json'
    if (!(Test-Path -LiteralPath $taskHealthFile)) { return $false }
    $taskHealth = Get-Content -LiteralPath $taskHealthFile -Raw | ConvertFrom-Json
    return $taskHealth.connected -eq $true -and $taskHealth.detail -eq 'ready' -and [int64]$taskHealth.at -ge $taskStartedAt -and ($taskPids -contains [int]$taskHealth.pid)
}
function Start-TaskHost {
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $taskLogStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $script:taskStartLog = Join-Path $taskRoot "tmp\desktop-$taskLogStamp.stdout.log"
    # Taken before launching: a fast Gateway may report ready within the first poll. The old Host is stopped.
    $taskStartedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    Start-Process -FilePath $taskExe -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $script:taskStartLog -RedirectStandardError (Join-Path $taskRoot "tmp\desktop-$taskLogStamp.stderr.log") | Out-Null
    $taskDeadline = (Get-Date).AddSeconds(100)
    do {
        Start-Sleep -Seconds 2
        try {
            $taskStatus = Get-TaskStatus
            $taskLog = Get-Content -LiteralPath $script:taskStartLog -Raw -ErrorAction SilentlyContinue
            # Gateway readiness recorded by Remote Ops after this start, by a process of this Host.
            $taskReady = Test-TaskQQReady $taskStartedAt @(Get-TaskHostPids)
            if ($taskStatus.reachable -and ($taskReady -or $taskLog -match '\[im-qqbot\] Bot ready!')) { return (Get-TaskStatus -Health) }
        } catch { }
    } while ((Get-Date) -lt $taskDeadline)
    throw 'Harness/QQ did not become ready within 100 seconds.'
}
function Invoke-SwitchNode([string[]]$SwitchArgs) {
    # Decisions live in character-switch.cjs; this only runs it and keeps its output and exit code.
    $script:taskSwitchOutput = & $taskNode (Join-Path $PSScriptRoot 'character-switch.cjs') @SwitchArgs
    return $LASTEXITCODE
}
function Format-SwitchReason([string]$Text) {
    # Windows PowerShell 5.1 splits a native argument at embedded double quotes, so one reason would
    # arrive as several arguments. Keep it one plain line.
    return (($Text -replace '["\\\r\n]+',' ').Trim())
}
function Get-TaskHostPids {
    Get-TaskHostProcesses | ForEach-Object { $_.ProcessId }
}
function Wait-TaskCharacterServed([int64]$StartedAt, [string]$Role) {
    $taskDeadline = (Get-Date).AddSeconds(20)
    do {
        $taskPidList = (Get-TaskHostPids) -join ','
        if ($taskPidList -and (Invoke-SwitchNode @('verify',$taskRoot,"$StartedAt",$taskPidList,$Role)) -eq 0) { return }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $taskDeadline)
    throw "The restarted Host did not serve the $Role character. $($script:taskSwitchOutput)"
}
function Test-TaskExistingCharacterServed([string]$Role) {
    $taskProcesses = @(Get-TaskHostProcesses)
    foreach ($taskProcess in $taskProcesses) {
        if (!$taskProcess.CreationDate) { continue }
        $taskStartedAt = ([DateTimeOffset]$taskProcess.CreationDate).ToUnixTimeMilliseconds()
        if ((Invoke-SwitchNode @('verify',$taskRoot,"$taskStartedAt",("$($taskProcess.ProcessId)"),$Role)) -ne 0) { continue }
        try {
            if (!(Test-TaskQQReady $taskStartedAt @($taskProcesses.ProcessId))) { return $false }
            return (Get-TaskStatus -Health).reachable
        } catch { return $false }
    }
    return $false
}
function Restore-TaskCharacter {
    $taskRecovery = Invoke-SwitchNode @('recover',$taskRoot)
    if ($taskRecovery -eq 3) { return $false }
    if ($taskRecovery -ne 0) { throw "Cannot recover the character switch. $($script:taskSwitchOutput)" }
    $taskLink = ($script:taskSwitchOutput | ConvertFrom-Json).link
    if ($taskLink -eq 'previous' -and (Test-TaskExistingCharacterServed 'previous')) { return $true }

    # A target Host can survive an interrupted switch. Confirm shutdown before changing the junction.
    Stop-TaskHostProcesses @(Get-TaskHostProcesses)
    if ((Invoke-SwitchNode @('revert',$taskRoot)) -ne 0) { throw "Cannot restore the character link. $($script:taskSwitchOutput)" }
    $taskStartedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    Start-TaskHost | Out-Null
    Wait-TaskCharacterServed $taskStartedAt 'previous'
    return $true
}
function Invoke-CharacterSwitch {
    try {
        $taskRecovered = Restore-TaskCharacter
    } catch {
        $taskReason = Format-SwitchReason "interrupted. Rollback failed. $($_.Exception.Message)"
        Invoke-SwitchNode @('finish',$taskRoot,'retry',$taskReason) | Out-Null
        throw $taskReason
    }
    if ($taskRecovered -and (Invoke-SwitchNode @('finish',$taskRoot,'fail','interrupted','true')) -ne 0) {
        throw 'The previous character was restored, but the interrupted switch result could not be recorded.'
    }
    $taskPending = Invoke-SwitchNode @('pending',$taskRoot)
    if ($taskPending -in @(3,4)) {
        $taskResult.skipped = $true
        return
    }
    if ($taskPending -ne 0) { throw "Cannot accept the character switch. $($script:taskSwitchOutput)" }
    # Everything that can refuse is decided now, while the Host is still running and untouched.
    $taskCheck = Invoke-SwitchNode @('check',$taskRoot)
    if ($taskCheck -notin @(0,5)) {
        $taskReason = Format-SwitchReason "Switch refused before anything changed: $($script:taskSwitchOutput)"
        Invoke-SwitchNode @('finish',$taskRoot,'fail',$taskReason,'false') | Out-Null
        throw $taskReason
    }
    try {
        if ($taskCheck -eq 5) {
            if (!(Test-TaskExistingCharacterServed 'target')) { throw 'The link already points at the target, but its Host could not be verified.' }
        } else {
            Stop-TaskHost
            if ((Invoke-SwitchNode @('apply',$taskRoot)) -ne 0) { throw "Cannot point the character link at the new character. $($script:taskSwitchOutput)" }
            $taskStartedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
            $taskResult.status = Start-TaskHost
            Wait-TaskCharacterServed $taskStartedAt 'target'
        }
    } catch {
        $taskReason = Format-SwitchReason $_.Exception.Message
        $taskRestored = $false
        $taskOutcome = 'fail'
        if ($script:taskStopped -or $taskCheck -eq 5) {
            try {
                if (!(Restore-TaskCharacter)) { throw 'Missing switch journal.' }
                $taskRestored = $true
            } catch {
                $taskOutcome = 'retry'
                $taskReason = Format-SwitchReason "$taskReason. Rollback failed. $($_.Exception.Message)"
            }
        } else {
            try { $taskRestored = Test-TaskExistingCharacterServed 'previous' } catch { }
        }
        if ((Invoke-SwitchNode @('finish',$taskRoot,$taskOutcome,$taskReason,"$taskRestored".ToLower())) -ne 0) { $taskReason = "$taskReason. The result could not be recorded." }
        throw $taskReason
    }
    # The switch worked. A failed result write must never trigger a rollback.
    $script:taskStopped = $false
    if ((Invoke-SwitchNode @('finish',$taskRoot,'ok')) -ne 0) { throw 'Character switched, but its result could not be recorded.' }
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
    if ($Action -in @('Restart','DeployValidated','Restore','ApplyFeatures') -and (Test-Path -LiteralPath (Join-Path $taskState 'character-switch.inprogress.json'))) {
        throw 'Character switch recovery must finish before restarting the Host.'
    } elseif ($Action -eq 'Backup') {
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
        Invoke-TaskNode @('--test',(Join-Path $PSScriptRoot 'hitl.test.mjs'),(Join-Path $PSScriptRoot 'qq-boundaries.test.mjs'),(Join-Path $PSScriptRoot 'maintenance.test.cjs'),(Join-Path $PSScriptRoot 'remote-ops.test.mjs'))
        $taskCompositionErrors = Join-Path $taskRoot 'tmp\inspect\validated-composition.err.log'
        # Compose with the selected Host runtime (host-runtime.json), not the install root's original one.
        & (Join-Path $taskRuntime 'resources\runtime\cli\bin\dsh.cmd') --profile qqbot-validation --dump-config 1> (Join-Path $taskRoot 'tmp\inspect\validated-composition.yml') 2> $taskCompositionErrors
        if ($LASTEXITCODE -ne 0) { throw 'Candidate composition failed.' }
        if ((Get-Content -LiteralPath $taskCompositionErrors -Raw) -match 'skipping profile bundle|incompatible with dsh|patch: entry .+ not found') { throw 'Candidate silently skipped a plugin or override; inspect composition diagnostics.' }
        Invoke-TaskNode @((Join-Path $PSScriptRoot 'stage.cjs'),'seal')
        $taskResult.candidate = $taskStage
    } elseif ($Action -eq 'SwitchCharacter') {
        Invoke-CharacterSwitch
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
            # A Character Profile's artifact pins were sealed with the candidate and must move with it.
            if (Test-Path -LiteralPath (Join-Path $taskStage 'character-artifacts.json')) { Copy-Item -LiteralPath (Join-Path $taskStage 'character-artifacts.json') -Destination (Join-Path $taskProfile 'character-artifacts.json') -Force }
            Copy-Item -LiteralPath (Join-Path $taskStage 'patches') -Destination $taskProfile -Recurse -Force
            # The live modules directory may come from a Profile installed elsewhere and renamed; pnpm then
            # rebuilds it, which needs confirmation on a TTY. Stage filled the offline store.
            & $taskNode $taskPnpm --dir $taskProfile --store-dir $taskStore install --frozen-lockfile --ignore-scripts --offline --config.confirm-modules-purge=false
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
