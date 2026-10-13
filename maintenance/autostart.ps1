param([ValidateSet('Enable','Disable','Status','Start')][string]$Action='Status')
$ErrorActionPreference='Stop'
$taskName='DeepSeekHarness-QQ-Watchdog'
if($Action -eq 'Enable') {
 $taskUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name
 $taskCommand=(Get-Command powershell.exe).Source
 $taskArgs='-NoProfile -WindowStyle Hidden -File "'+(Join-Path $PSScriptRoot 'watchdog.ps1')+'"'
 $taskExisting=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
 if($taskExisting -and $taskExisting.Actions.Arguments -ne $taskArgs){throw 'Task name belongs to a different installation.'}
 $taskAction=New-ScheduledTaskAction -Execute $taskCommand -Argument $taskArgs
 $taskTrigger=New-ScheduledTaskTrigger -AtLogOn -User $taskUser
 $taskPrincipal=New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
 $taskSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
 Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description 'Private QQ Harness watchdog; managed by maintenance/autostart.ps1' -Force | Out-Null
 Start-ScheduledTask -TaskName $taskName
} elseif($Action -eq 'Disable') {
 Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
 Disable-ScheduledTask -TaskName $taskName | Out-Null
} elseif($Action -eq 'Start') { Start-ScheduledTask -TaskName $taskName }
Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Select-Object TaskName,State
