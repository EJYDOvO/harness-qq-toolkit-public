param([string]$Message='Reviewed local maintenance checkpoint')
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
foreach($taskRelative in @('maintenance','plugin-sources/dsh-remote-ops','plugin-sources/dsh-task-memory','default-workspace')) {
 $taskRepo=Join-Path $taskRoot $taskRelative
 if(!(Test-Path -LiteralPath (Join-Path $taskRepo '.git'))) { & git -C $taskRepo init -b main | Out-Null; if($LASTEXITCODE -ne 0){throw "Cannot initialize $taskRelative"} }
 & git -C $taskRepo config core.autocrlf false
 if($LASTEXITCODE -ne 0){throw "Cannot configure $taskRelative"}
 if($taskRelative -eq 'default-workspace') { & git -C $taskRepo add -- AGENTS.md .gitignore }
 else { & git -C $taskRepo add --all }
 if($LASTEXITCODE -ne 0){throw "Cannot stage $taskRelative"}
 & git -C $taskRepo diff --cached --quiet
 if($LASTEXITCODE -eq 1) { & git -C $taskRepo -c user.name='Local Maintenance' -c user.email='maintenance@localhost' commit -m $Message; if($LASTEXITCODE -ne 0){throw "Cannot checkpoint $taskRelative"} }
 Write-Output "$taskRelative"
 & git -C $taskRepo log -1 --format='%h %s'
}
