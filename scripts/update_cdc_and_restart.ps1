$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectDir

python ".\scripts\update_cdc_travel_alerts.py"

$processes = Get-CimInstance Win32_Process |
    Where-Object { $_.Name -like 'python*' -and $_.CommandLine -match '(^| )app\.py($| )' }

foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force
}

Start-Sleep -Seconds 1
Start-Process -FilePath python -ArgumentList 'app.py' -WorkingDirectory $ProjectDir -WindowStyle Hidden | Out-Null

Write-Host "CDC travel alert knowledge updated and backend restarted."
