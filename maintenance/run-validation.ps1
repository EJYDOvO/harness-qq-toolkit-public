$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$env:DSH_HOME=Join-Path $taskRoot 'data'
$env:TEMP=Join-Path $taskRoot 'tmp';$env:TMP=$env:TEMP
& (Join-Path $taskRoot 'resources\runtime\cli\bin\dsh.cmd') --profile qqbot-validation --patch (Join-Path $PSScriptRoot 'feature-validation.yml') --no-open --port 0
exit $LASTEXITCODE
