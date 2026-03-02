Stop-Process -Name python -Force -ErrorAction SilentlyContinue
Write-Host "Killed all python.exe"
Start-Sleep 2
$check = netstat -ano | Select-String ":8000 " | Select-String "LISTEN"
if ($check) {
    Write-Host "Still blocked:"
    $check
} else {
    Write-Host "Port 8000 is now free."
}
