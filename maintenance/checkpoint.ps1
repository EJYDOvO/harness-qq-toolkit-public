param([string]$Message='Reviewed source checkpoint')
$ErrorActionPreference='Stop'
$taskRepo=Split-Path -Parent $PSScriptRoot
& git -C $taskRepo diff --cached --check
if($LASTEXITCODE -ne 0){throw 'Review staged changes first'}
& git -C $taskRepo commit -m $Message
if($LASTEXITCODE -ne 0){throw 'Commit failed; no automatic staging or nested repository creation'}
